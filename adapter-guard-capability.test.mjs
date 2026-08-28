import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

const repo = fileURLToPath(new URL(".", import.meta.url));
const wrapper = join(repo, "bin/local-codex-secure.mjs");
const realAppServer = join(repo, "test/fixtures/visible-events-app-server.mjs");
const terminal = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-codex-capability-integration-")));
  const tokenFile = join(root, "token");
  const stateFile = join(root, "control", "threads.json");
  const jobsDir = join(root, "control", "jobs");
  const approvalsDir = join(root, "control", "guard", "approvals");
  const wrapperLauncher = join(root, "secure-wrapper");
  const port = 20000 + Math.floor(Math.random() * 30000);
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, "Bearer test-secret\n", { mode: 0o600 });
  // adapter spawns LOCAL_CODEX_BIN directly, while the installed secure wrapper
  // is executable. Repository .mjs files need not retain an executable bit on
  // every checkout, so mirror the installed contract with a tiny executable shim.
  await writeFile(wrapperLauncher, `#!/usr/bin/env node\nawait import(${JSON.stringify(wrapper)});\n`, { mode: 0o700 });
  const env = {
    ...process.env,
    LOCAL_CODEX_ROOT: root,
    LOCAL_CODEX_PORT: String(port),
    LOCAL_CODEX_HOST: "127.0.0.1",
    LOCAL_CODEX_TOKEN_FILE: tokenFile,
    LOCAL_CODEX_STATE_FILE: stateFile,
    LOCAL_CODEX_LOG_FILE: join(root, "audit.log"),
    LOCAL_CODEX_JOBS_DIR: jobsDir,
    LOCAL_CODEX_JOB_EVENTS_DIR: join(root, "control", "job-events"),
    LOCAL_CODEX_BIN: wrapperLauncher,
    LOCAL_CODEX_REAL_BIN: realAppServer,
    LOCAL_CODEX_CALL_TIMEOUT_MS: "10000",
  };
  let child;
  let sequence = 0;

  async function start() {
    child = spawn(process.execPath, ["adapter.mjs"], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("adapter did not start")), 5000);
      child.stderr.on("data", chunk => {
        if (chunk.toString().includes("ready on")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`adapter exited ${code}`));
      });
    });
  }

  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
  }

  async function call(name, args) {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(JSON.parse(body.result.content[0].text), body.result.structuredContent);
    return body.result.structuredContent;
  }

  async function pendingApproval(jobId) {
    for (let i = 0; i < 250; i++) {
      try {
        const name = (await readdir(approvalsDir)).find(file => file.endsWith(".pending.json"));
        if (name) return JSON.parse(await readFile(join(approvalsDir, name), "utf8"));
      } catch {}
      await delay(20);
    }
    const status = await call("codex-status", { jobId });
    throw new Error(`network capability approval did not appear; job status=${status.status} error=${status.errorCode || "none"} message=${status.message || "none"}`);
  }

  async function finished(jobId) {
    for (let i = 0; i < 40; i++) {
      const result = await call("codex-status", { jobId, waitMs: 300 });
      if (terminal.has(result.status)) return result;
    }
    throw new Error("job did not finish");
  }

  t.after(() => stop());
  await start();
  return { root, approvalsDir, call, pendingApproval, finished, stop };
}

test("network capability is visible before spawn and event order continues through Guard", async t => {
  const f = await setup(t);
  const created = await f.call("codex", {
    requestId: "network-capability",
    cwd: f.root,
    prompt: "Run the visible integration turn",
    networkAccess: true,
  });
  const pending = await f.pendingApproval(created.jobId);
  assert.equal(pending.jobId, created.jobId);
  assert.equal(pending.method, "localCodex/capabilityApproval");
  assert.equal(pending.params.capability, "networkAccess");

  const heldEvents = await f.call("codex-status", {
    jobId: created.jobId,
    afterEventSeq: 0,
    eventLimit: 20,
    waitMs: 20000,
  });
  assert.deepEqual(heldEvents.events.map(event => event.type), ["approval.requested"]);
  assert.equal(heldEvents.events[0].data.params.accessChange.networkAccess.to, true);
  assert.equal(heldEvents.events[0].data.params.accessChange.hostCredentials.to, "available");
  assert.equal(heldEvents.threadId, null, "Codex app-server must not have started before host approval");

  await writeFile(join(f.approvalsDir, `${pending.approvalId}.decision.json`), `${JSON.stringify({ decision: "accept" })}\n`, { mode: 0o600 });
  const done = await f.finished(created.jobId);
  assert.equal(done.status, "completed");
  assert.equal(done.content, "FINAL_VISIBLE");

  const all = await f.call("codex-status", { jobId: created.jobId, afterEventSeq: 0, eventLimit: 100 });
  assert.equal(all.events[0].type, "approval.requested");
  assert.equal(all.events[1].type, "approval.resolved");
  assert.equal(all.events[1].data.decision, "accept");
  assert.ok(all.events.some(event => event.type === "session.started"));
  assert.ok(all.events.some(event => event.type === "chatgpt.prompt"), "proxy events after preflight must not be lost to sequence collisions");
  assert.ok(all.events.some(event => event.type === "assistant.delta"));
  assert.deepEqual(all.events.map(event => event.seq), Array.from({ length: all.events.length }, (_, index) => index + 1));
  assert.equal(all.eventsDone, true);

  const audit = (await readFile(join(f.root, "audit.log"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const capabilityAudit = audit.filter(entry => entry.component === "local-codex-guard" && entry.capability === "networkAccess");
  assert.deepEqual(capabilityAudit.map(entry => entry.event), ["capability_approval_requested", "capability_approval_resolved"]);
});

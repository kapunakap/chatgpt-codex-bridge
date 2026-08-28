import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

const repo = fileURLToPath(new URL(".", import.meta.url));
const fixtureSource = join(repo, "test/fixtures/visible-events-app-server.mjs");
const terminal = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "local-codex-events-test-"));
  const tokenFile = join(root, "token");
  const fake = join(root, "fake-codex.mjs");
  const eventsDir = join(root, "job-events");
  const port = 20000 + Math.floor(Math.random() * 30000);
  await writeFile(tokenFile, "Bearer test-secret\n", { mode: 0o600 });
  await writeFile(fake, await readFile(fixtureSource, "utf8"), { mode: 0o700 });
  const env = {
    ...process.env,
    LOCAL_CODEX_ROOT: root,
    LOCAL_CODEX_PORT: String(port),
    LOCAL_CODEX_HOST: "127.0.0.1",
    LOCAL_CODEX_TOKEN_FILE: tokenFile,
    LOCAL_CODEX_STATE_FILE: join(root, "threads.json"),
    LOCAL_CODEX_LOG_FILE: join(root, "audit.log"),
    LOCAL_CODEX_JOBS_DIR: join(root, "jobs"),
    LOCAL_CODEX_JOB_EVENTS_DIR: eventsDir,
    LOCAL_CODEX_BIN: fake,
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

  async function finished(jobId) {
    for (let i = 0; i < 30; i++) {
      const result = await call("codex-status", { jobId, waitMs: 300 });
      if (terminal.has(result.status)) return result;
    }
    throw new Error("job did not finish");
  }

  t.after(() => stop());
  await start();
  return { root, eventsDir, call, finished, start, stop };
}

test("codex-status streams cursor-based visible events and persists them across restart", async t => {
  const f = await setup(t);
  const created = await f.call("codex", { requestId: "events", cwd: f.root, prompt: "show progress" });

  const first = await f.call("codex-status", {
    jobId: created.jobId,
    afterEventSeq: 0,
    eventLimit: 1,
    waitMs: 20000,
  });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].seq, 1);
  assert.equal(first.events[0].type, "assistant.delta");
  assert.equal(first.events[0].data.text, "VISIBLE_PROGRESS");
  assert.equal(first.nextEventSeq, 1);
  assert.doesNotMatch(JSON.stringify(first.events), /REASONING_SECRET|ENCRYPTED_SECRET/);

  const second = await f.call("codex-status", {
    jobId: created.jobId,
    afterEventSeq: first.nextEventSeq,
    eventLimit: 1,
    waitMs: 20000,
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].seq, 2);
  assert.equal(second.events[0].type, "item.completed");
  assert.equal(second.events[0].data.item.command, "npm test");
  assert.equal(second.nextEventSeq, 2);
  assert.doesNotMatch(JSON.stringify(second.events), /REASONING_SECRET|ENCRYPTED_SECRET/);

  const final = await f.finished(created.jobId);
  assert.equal(final.status, "completed");
  assert.equal(final.content, "FINAL_VISIBLE");

  const all = await f.call("codex-status", { jobId: created.jobId, afterEventSeq: 0, eventLimit: 100 });
  assert.deepEqual(all.events.map(event => event.seq), [1, 2]);
  assert.equal(all.nextEventSeq, 2);
  assert.equal(all.eventsDone, true);
  assert.equal((await stat(f.eventsDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.eventsDir, `${created.jobId}.jsonl`))).mode & 0o777, 0o600);

  await f.stop();
  await f.start();
  const restored = await f.call("codex-status", { jobId: created.jobId, afterEventSeq: 0, eventLimit: 100 });
  assert.deepEqual(restored.events, all.events);
  assert.equal(restored.nextEventSeq, 2);
  assert.equal(restored.eventsDone, true);
});

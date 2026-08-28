import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

const repo = fileURLToPath(new URL(".", import.meta.url));
const fixtureSource = join(repo, "test/fixtures/browser-environment-app-server.mjs");
const terminal = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-codex-browser-test-")));
  const tokenFile = join(root, "token");
  const fake = join(root, "fake-codex.mjs");
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
    LOCAL_CODEX_JOB_EVENTS_DIR: join(root, "job-events"),
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

  async function rpc(message) {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  async function call(name, args) {
    const response = await rpc({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } });
    assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
    return response.result.structuredContent;
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
  return { root, port, call, rpc, finished, stop };
}

test("browserAccess is explicit, independent, and fails closed on unsupported macOS", async t => {
  const f = await setup(t);
  const listed = await f.rpc({ jsonrpc: "2.0", id: "tools", method: "tools/list" });
  const codex = listed.result.tools.find(tool => tool.name === "codex");
  const reply = listed.result.tools.find(tool => tool.name === "codex-reply");
  assert.equal(codex.inputSchema.properties.browserAccess.type, "boolean");
  assert.equal(codex.inputSchema.properties.browserAccess.default, false);
  assert.equal(reply.inputSchema.properties.browserAccess.type, "boolean");
  assert.equal(reply.inputSchema.properties.browserAccess.default, undefined);
  assert.match(codex.inputSchema.properties.browserAccess.description, /Playwright|Chromium/i);
  assert.match(codex.inputSchema.properties.browserAccess.description, /independent of networkAccess/i);

  for (const invalid of [null, 1, "true", {}]) {
    const result = await f.call("codex", { requestId: `bad-${JSON.stringify(invalid)}`, cwd: f.root, prompt: "browser", browserAccess: invalid });
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "invalid_request");
  }

  const ready = await (await fetch(`http://127.0.0.1:${f.port}/readyz`)).json();
  if (process.platform === "darwin") {
    assert.equal(ready.browserAccessStatus, "upstream-sandbox-blocked");
    const blocked = await f.call("codex", { requestId: "browser", cwd: f.root, prompt: "run Playwright", browserAccess: true });
    assert.equal(blocked.status, "error");
    assert.equal(blocked.errorCode, "browser_access_unavailable");
    assert.match(blocked.message, /No job was started/i);
    assert.match(blocked.message, /sandbox was not weakened/i);
    assert.equal((await readdir(join(f.root, "jobs"))).length, 0);
    return;
  }

  assert.equal(ready.browserAccessStatus, "available");
  const created = await f.call("codex", { requestId: "browser", cwd: f.root, prompt: "run browser", browserAccess: true, networkAccess: false });
  assert.equal(created.browserAccess, true);
  assert.equal(created.networkAccess, false);
  const done = await f.finished(created.jobId);
  assert.equal(done.status, "completed");
  assert.equal(done.browserAccess, true);
  assert.equal(done.networkAccess, false);

  const state = JSON.parse(await readFile(join(f.root, "threads.json"), "utf8"));
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.threadBrowserAccess[done.threadId], true);
  assert.equal(state.threadNetworkAccess[done.threadId], false);

  const inherited = await f.finished((await f.call("codex-reply", {
    requestId: "browser-reply", threadId: done.threadId, prompt: "continue",
  })).jobId);
  assert.equal(inherited.browserAccess, true);

  const disabled = await f.finished((await f.call("codex-reply", {
    requestId: "browser-disable", threadId: done.threadId, prompt: "continue without browser", browserAccess: false,
  })).jobId);
  assert.equal(disabled.browserAccess, false);
});

test("known Chromium sandbox failure is classified as environment evidence", async t => {
  const f = await setup(t);
  const created = await f.call("codex", { requestId: "environment", cwd: f.root, prompt: "browser smoke" });
  const done = await f.finished(created.jobId);
  assert.equal(done.status, "completed");
  assert.equal(done.environmentErrorCode, "browser_sandbox_blocked");
  assert.match(done.environmentMessage, /blocked by the macOS Codex sandbox/i);

  const events = await f.call("codex-status", { jobId: created.jobId, afterEventSeq: 0, eventLimit: 100 });
  assert.ok(events.events.some(event => event.type === "browser.environment_blocked"));
  assert.equal(events.environmentErrorCode, "browser_sandbox_blocked");
});

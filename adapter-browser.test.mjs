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

async function setup(t, mode = "available") {
  const root = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "lcb-test-")));
  const tokenFile = join(root, "token");
  const fake = join(root, "fake-codex.mjs");
  const trace = join(root, "trace.jsonl");
  const port = 20000 + Math.floor(Math.random() * 30000);
  await writeFile(tokenFile, "Bearer test-secret\n", { mode: 0o600 });
  await writeFile(fake, await readFile(fixtureSource, "utf8"), { mode: 0o700 });
  await writeFile(trace, "");
  const env = {
    ...process.env,
    LOCAL_CODEX_ROOT: root,
    LOCAL_CODEX_PORT: String(port),
    LOCAL_CODEX_HOST: "127.0.0.1",
    LOCAL_CODEX_TOKEN_FILE: tokenFile,
    LOCAL_CODEX_STATE_FILE: join(root, "threads.json"),
    LOCAL_CODEX_LOG_FILE: join(root, "audit.log"),
    LOCAL_CODEX_WORKTREE_ROOT: join(root, "worktrees"),
    LOCAL_CODEX_WORKTREE_RETENTION: "15",
    LOCAL_CODEX_JOBS_DIR: join(root, "jobs"),
    LOCAL_CODEX_JOB_EVENTS_DIR: join(root, "job-events"),
    LOCAL_CODEX_BIN: fake,
    LOCAL_CODEX_CALL_TIMEOUT_MS: "10000",
    BROWSER_FIXTURE_MODE: mode,
    BROWSER_FIXTURE_TRACE: trace,
  };
  let child;
  let sequence = 0;

  async function start() {
    child = spawn(process.execPath, ["adapter.mjs"], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("adapter did not start")), 5000);
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
        if (stderr.includes("ready on")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`adapter exited ${code}: ${stderr.trim()}`));
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
    const response = await rpc({
      jsonrpc: "2.0", id: ++sequence, method: "tools/call",
      params: {
        name, arguments: args,
        _meta: { "x-codex-turn-metadata": { session_id: "host-session", turn_id: "host-turn", thread_id: "host-session", thread_source: "user" } },
      },
    });
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

  async function records() {
    const text = await readFile(trace, "utf8");
    return text.trim() ? text.trim().split("\n").map(JSON.parse) : [];
  }

  t.after(() => stop());
  await start();
  return { root, port, call, rpc, finished, records, stop };
}

test("browserAccess selects the official Browser backend without widening shell access", async t => {
  const f = await setup(t);
  const listed = await f.rpc({ jsonrpc: "2.0", id: "tools", method: "tools/list" });
  const codex = listed.result.tools.find(tool => tool.name === "codex");
  const reply = listed.result.tools.find(tool => tool.name === "codex-reply");
  assert.equal(codex.inputSchema.properties.browserAccess.type, "boolean");
  assert.equal(codex.inputSchema.properties.browserAccess.default, false);
  assert.equal(reply.inputSchema.properties.browserAccess.type, "boolean");
  assert.equal(reply.inputSchema.properties.browserAccess.default, undefined);
  assert.match(codex.inputSchema.properties.browserAccess.description, /official Codex Browser/i);
  assert.match(codex.inputSchema.properties.browserAccess.description, /never enables shell-launched Playwright/i);

  for (const invalid of [null, 1, "true", {}]) {
    const result = await f.call("codex", { requestId: `bad-${JSON.stringify(invalid)}`, cwd: f.root, prompt: "browser", browserAccess: invalid });
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "invalid_request");
  }
  const missingHostContext = await f.rpc({
    jsonrpc: "2.0", id: "missing-host", method: "tools/call",
    params: { name: "codex", arguments: { requestId: "missing-host", cwd: f.root, prompt: "browser", browserAccess: true } },
  });
  assert.equal(missingHostContext.result.structuredContent.errorCode, "browser_host_context_unavailable");

  const ready = await (await fetch(`http://127.0.0.1:${f.port}/readyz`)).json();
  assert.equal(ready.browserAccessStatus, "official-backend");
  const created = await f.call("codex", { requestId: "browser", cwd: f.root, prompt: "run browser", browserAccess: true, networkAccess: false });
  assert.equal(created.browserAccess, true);
  assert.equal(created.browserBackend, "official_codex");
  assert.equal(created.networkAccess, false);
  const done = await f.finished(created.jobId);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.content, "OFFICIAL_BROWSER_OK");
  assert.equal(done.browserAccess, true);
  assert.equal(done.browserBackend, "official_codex");
  assert.equal(done.networkAccess, false);

  const records = await f.records();
  const browserEnvironment = records.find(record => record.method === "fixture/environment" && record.params.brokerEnabled);
  assert.ok(browserEnvironment.params.argv.some(value => value === "mcp_servers.node_repl.enabled=false"));
  assert.ok(browserEnvironment.params.argv.some(value => value === "mcp_servers.playwright.enabled=false"));
  assert.ok(browserEnvironment.params.argv.some(value => value.includes("mcp_servers.local_codex_browser.command=")));
  assert.ok(browserEnvironment.params.argv.some(value => value.includes("browser-proxy.mjs")));
  assert.ok(records.some(record => record.method === "configRequirements/read"));
  assert.ok(records.some(record => record.method === "plugin/installed"));
  assert.ok(records.some(record => record.method === "mcpServerStatus/list"));
  const browserMcpCalls = records.filter(record => record.method === "mcpServer/tool/call").map(record => record.params.tool);
  assert.deepEqual(browserMcpCalls.slice(0, 2), ["js", "js_reset"]);
  const turn = records.find(record => record.method === "turn/start");
  assert.deepEqual(turn.params.input, [{ type: "text", text: "run browser" }]);
  assert.match(turn.params.additionalContext["local-codex-browser-access"].value, /Never launch Playwright/i);
  assert.match(turn.params.additionalContext["local-codex-browser-access"].value, /official_browser_open/i);
  assert.match(turn.params.additionalContext["local-codex-browser-access"].value, /Do not call node_repl/i);
  assert.equal(turn.params.additionalContext["local-codex-browser-access"].kind, "application");

  const state = JSON.parse(await readFile(join(f.root, "threads.json"), "utf8"));
  assert.equal(state.schemaVersion, 5);
  assert.equal(state.threadBrowserAccess[done.threadId], true);
  assert.equal(state.threadNetworkAccess[done.threadId], false);

  const inherited = await f.finished((await f.call("codex-reply", {
    requestId: "browser-reply", threadId: done.threadId, prompt: "continue",
  })).jobId);
  assert.equal(inherited.browserAccess, true);
  assert.equal(inherited.browserBackend, "official_codex");

  const disabled = await f.finished((await f.call("codex-reply", {
    requestId: "browser-disable", threadId: done.threadId, prompt: "continue without browser", browserAccess: false,
  })).jobId);
  assert.equal(disabled.browserAccess, false);
  assert.equal(disabled.browserBackend, "none");
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith(".lcb-") && name.endsWith(".sock")), []);
});

test("browserAccess fails before turn start for unavailable official backends", async t => {
  const cases = [
    ["policy-blocked", "browser_policy_blocked"],
    ["plugin-disabled", "browser_plugin_unavailable"],
    ["transport-missing", "browser_transport_unavailable"],
    ["runtime-error", "browser_runtime_unavailable"],
  ];
  for (const [mode, errorCode] of cases) {
    await t.test(mode, async t2 => {
      const f = await setup(t2, mode);
      const created = await f.call("codex", {
        requestId: `browser-${mode}`, cwd: f.root, prompt: "use official Browser", browserAccess: true,
      });
      const done = await f.finished(created.jobId);
      assert.equal(done.status, "failed");
      assert.equal(done.errorCode, errorCode);
      assert.equal(done.browserBackend, "official_codex");
      assert.equal((await f.records()).some(record => record.method === "turn/start"), false);
      assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith(".lcb-") && name.endsWith(".sock")), []);
    });
  }
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
  const methods = (await f.records()).map(record => record.method);
  assert.equal(methods.includes("configRequirements/read"), false);
  assert.equal(methods.includes("plugin/installed"), false);
  assert.equal(methods.includes("mcpServerStatus/list"), false);
  assert.equal(methods.includes("mcpServer/tool/call"), false);
});

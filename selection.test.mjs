import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cwd = fileURLToPath(new URL(".", import.meta.url));

async function setup(t, mode = "") {
  const root = await mkdtemp(join(tmpdir(), "codex-selection-"));
  const logFile = join(root, "calls.log");
  const stateFile = join(root, "threads.json");
  const mockState = join(root, "codex.json");
  const trace = join(root, "trace.jsonl");
  const tokenFile = join(root, "token");
  await writeFile(tokenFile, "Bearer TOKEN_SECRET", { mode: 0o600 });
  await writeFile(logFile, '{"existing":"tunnel-line"}\n', { mode: 0o600 });
  let child;
  let base;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  async function start() {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["adapter.mjs"], {
      cwd, stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env, LOCAL_CODEX_ROOT: root, LOCAL_CODEX_PORT: String(port),
        LOCAL_CODEX_TOKEN_FILE: tokenFile, LOCAL_CODEX_STATE_FILE: stateFile,
        LOCAL_CODEX_LOG_FILE: logFile,
        LOCAL_CODEX_BIN: join(cwd, "test/fixtures/codex-app-server.mjs"),
        LOCAL_CODEX_CALL_TIMEOUT_MS: mode === "timeout" ? "1500" : "8000",
        MOCK_CODEX_STATE_FILE: mockState, MOCK_CODEX_TRACE_FILE: trace, MOCK_CODEX_MODE: mode,
      },
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("startup timeout")); }, 8000);
      child.stderr.on("data", chunk => {
        if (chunk.toString().includes("ready on")) { clearTimeout(timeout); resolve(); }
      });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error(`startup exit ${code}`)); });
      child.once("error", reject);
    });
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  await start();
  return {
    start, stop, root, stateFile, mockState, logFile,
    logs: async () => (await readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse),
    trace: async () => (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse),
    call: async (args, name = "codex") => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST", headers: { Authorization: "Bearer TOKEN_SECRET", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "UNTRUSTED_REQUEST_ID_SECRET", method: "tools/call", params: { name, arguments: { prompt: "PROMPT_SECRET", ...args } } }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    },
  };
}

test("Luna/max is explicit; real responses confirm it; logs contain only metadata", async t => {
  const h = await setup(t);
  const response = await h.call({});
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.content, "MOCK_OUTPUT_SECRET");
  const trace = await h.trace();
  const start = trace.find(x => x.method === "thread/start").params;
  const turn = trace.find(x => x.method === "turn/start").params;
  assert.equal(start.model, "gpt-5.6-luna");
  assert.equal(start.config.model_reasoning_effort, "max");
  assert.equal(start.permissions, "local-codex-tunnel");
  assert.equal(start.approvalPolicy, "never");
  assert.equal(turn.model, "gpt-5.6-luna");
  assert.equal(turn.effort, "max");
  assert.equal(trace.filter(x => x.method === "model/list").length, 2);
  const logs = await h.logs();
  assert.deepEqual(logs[0], { existing: "tunnel-line" });
  assert.equal(logs[1].event, "call_started");
  const requested = logs.find(x => x.event === "settings_requested");
  assert.equal(requested.settingsStatus, "requested");
  const confirmed = logs.find(x => x.event === "settings_confirmed");
  assert.equal(confirmed.model, "gpt-5.6-luna");
  assert.equal(confirmed.reasoningEffort, "max");
  assert.equal(confirmed.settingsStatus, "confirmed");
  const completed = logs.at(-1);
  assert.equal(completed.event, "call_completed");
  assert.equal(completed.threadId, response.structuredContent.threadId);
  assert.ok(completed.turnId);
  assert.ok(completed.durationMs >= 0);
  assert.equal(completed.requestId, logs[1].requestId);
  assert.equal((await stat(h.logFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
});

test("model aliases and full IDs support explicit and partial new-thread overrides", async t => {
  const h = await setup(t);
  for (const [model, expected] of [["sol", "gpt-5.6-sol"], ["terra", "gpt-5.6-terra"], ["luna", "gpt-5.6-luna"], ["gpt-5.6-sol", "gpt-5.6-sol"]]) {
    const response = await h.call({ model, reasoningEffort: "low" });
    assert.equal(response.isError, undefined);
    const turn = (await h.trace()).filter(x => x.method === "turn/start").at(-1).params;
    assert.equal(turn.model, expected);
    assert.equal(turn.effort, "low");
  }
  await h.call({ model: "terra" });
  assert.equal((await h.trace()).filter(x => x.method === "turn/start").at(-1).params.effort, "max");
  await h.call({ reasoningEffort: "medium" });
  assert.equal((await h.trace()).filter(x => x.method === "turn/start").at(-1).params.model, "gpt-5.6-luna");
});

test("reply overrides persist through app-server and adapter restarts", async t => {
  const h = await setup(t);
  const threadId = (await h.call({})).structuredContent.threadId;
  const switched = await h.call({ threadId, model: "terra", reasoningEffort: "high" }, "codex-reply");
  assert.equal(switched.isError, undefined);
  await h.stop();
  await h.start();
  assert.equal((await h.call({ threadId }, "codex-reply")).isError, undefined);
  let turn = (await h.trace()).filter(x => x.method === "turn/start").at(-1).params;
  assert.equal(turn.model, "gpt-5.6-terra");
  assert.equal(turn.effort, "high");
  await h.call({ threadId, reasoningEffort: "low" }, "codex-reply");
  await h.call({ threadId, model: "sol" }, "codex-reply");
  turn = (await h.trace()).filter(x => x.method === "turn/start").at(-1).params;
  assert.equal(turn.model, "gpt-5.6-sol");
  assert.equal(turn.effort, "low");
});

test("legacy threadIds-only state preserves existing Sol/high threads", async t => {
  const h = await setup(t);
  await h.stop();
  await writeFile(h.stateFile, JSON.stringify({ threadIds: ["legacy-thread"] }));
  await writeFile(h.mockState, JSON.stringify({ "legacy-thread": { id: "legacy-thread", model: "gpt-5.6-sol", reasoningEffort: "high" } }));
  await h.start();
  assert.equal((await h.call({ threadId: "legacy-thread" }, "codex-reply")).isError, undefined);
  const turn = (await h.trace()).find(x => x.method === "turn/start").params;
  assert.equal(turn.model, "gpt-5.6-sol");
  assert.equal(turn.effort, "high");
});

test("unsupported or malformed selections never start a turn or leak supplied strings", async t => {
  const h = await setup(t);
  for (const args of [{ model: "UNKNOWN_MODEL_SECRET" }, { reasoningEffort: "UNSUPPORTED_SECRET" }, { model: null }, { reasoningEffort: "" }, { model: {} }]) {
    const result = await h.call(args);
    assert.equal(result.isError, true);
  }
  assert.equal((await h.trace()).some(x => x.method === "turn/start"), false);
  assert.doesNotMatch(JSON.stringify(await h.logs()), /SECRET/);
  assert.match((await h.call({ model: "missing" })).content[0].text, /Available models:/);
  assert.match((await h.call({ reasoningEffort: "ultra" })).content[0].text, /Supported choices:/);
});

for (const mode of ["mismatch", "missing-confirmation", "catalog-error"]) {
  test(`${mode} fails closed before generation`, async t => {
    const h = await setup(t, mode);
    assert.equal((await h.call({})).isError, true);
    assert.equal((await h.trace()).some(x => x.method === "turn/start"), false);
    const logs = await h.logs();
    assert.equal(logs.some(x => x.event === "settings_confirmed"), false);
    assert.equal(logs.at(-1).event, "call_failed");
    assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  });
}

for (const mode of ["timeout", "exit", "turn-error"]) {
  test(`${mode} records safe terminal metadata`, async t => {
    const h = await setup(t, mode);
    assert.equal((await h.call({})).isError, true);
    const logs = await h.logs();
    assert.equal(logs.at(-1).event, mode === "timeout" ? "call_timed_out" : "call_failed");
    assert.equal(logs.at(-1).model, "gpt-5.6-luna");
    assert.equal(logs.at(-1).reasoningEffort, "max");
    assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  });
}

for (const mode of ["early-completion", "no-settings-event"]) {
  test(`${mode} still waits for effective settings confirmation`, async t => {
    const h = await setup(t, mode);
    assert.equal((await h.call({})).isError, undefined);
    const logs = await h.logs();
    assert.equal(logs.at(-1).event, "call_completed");
    assert.equal(logs.at(-1).settingsStatus, "confirmed");
    assert.ok(logs.find(x => x.event === "settings_confirmed" && x.turnId));
  });
}

test("post-turn settings mismatch is never reported as success", async t => {
  const h = await setup(t, "post-turn-mismatch");
  assert.equal((await h.call({})).isError, true);
  const logs = await h.logs();
  assert.equal(logs.at(-1).event, "call_failed");
  assert.equal(logs.at(-1).settingsStatus, "mismatch");
  assert.equal(logs.at(-1).errorCode, "settings_mismatch");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

const repo = fileURLToPath(new URL(".", import.meta.url));
const terminal = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-codex-adapter-test-")));
  const tokenFile = join(root, "token");
  const fake = join(root, "fake-codex.mjs");
  const port = 20000 + Math.floor(Math.random() * 30000);
  await writeFile(tokenFile, "Bearer test-secret\n", { mode: 0o600 });
  await writeFile(fake, fakeSource, { mode: 0o700 });
  const deniedGroup = join(root, "deny-group-signals.mjs");
  await writeFile(deniedGroup, `const original = process.kill; process.kill = function(pid, signal) {
    if (pid < 0) throw Object.assign(new Error('protected hook'), {code:'EPERM'});
    return original.call(process, pid, signal);
  };`);
  let child;
  let sequence = 0;
  const env = { ...process.env,
    LOCAL_CODEX_ROOT: root, LOCAL_CODEX_PORT: String(port), LOCAL_CODEX_HOST: "127.0.0.1",
    LOCAL_CODEX_TOKEN_FILE: tokenFile, LOCAL_CODEX_STATE_FILE: join(root, "threads.json"),
    LOCAL_CODEX_LOG_FILE: join(root, "audit.log"), LOCAL_CODEX_JOBS_DIR: join(root, "jobs"),
    LOCAL_CODEX_BIN: options.missingBin ? join(root, "missing") : fake, LOCAL_CODEX_CALL_TIMEOUT_MS: String(options.timeout || 10000),
    LOCAL_CODEX_MAX_CONCURRENCY: String(options.maxConcurrency ?? 4), LOCAL_CODEX_MAX_QUEUE: String(options.maxQueue ?? 100),
    FAKE_ROOT: root,
  };
  async function start() {
    child = spawn(process.execPath, [...(options.deniedGroup ? ["--import", deniedGroup] : []), "adapter.mjs"], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("adapter did not start")), 5000);
      child.stderr.on("data", chunk => {
        if (chunk.toString().includes("ready on")) { clearTimeout(timeout); resolve(); }
      });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error(`adapter exited ${code}`)); });
    });
  }
  async function stop(signal = "SIGTERM") {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, "exit"); child.kill(signal); await exit;
  }
  async function rpc(message, signal) {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST", headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
      body: JSON.stringify(message), signal,
    });
    if (!Object.hasOwn(message, "id")) { assert.equal(response.status, 202); return; }
    assert.equal(response.status, 200);
    return response.json();
  }
  async function call(name, args, signal, id = ++sequence) {
    if (name === "codex") args = { cwd: root, ...args };
    const response = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, signal);
    assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
    return response.result.structuredContent;
  }
  async function finished(jobId) {
    for (let i = 0; i < 40; i++) {
      const result = await call("codex-status", { jobId, waitMs: 300 });
      if (terminal.has(result.status)) return result;
    }
    throw new Error("job did not finish");
  }
  async function records() {
    try { return (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async function started(jobId) {
    for (let i = 0; i < 100; i++) {
      const result = await call("codex-status", { jobId });
      if (result.turnId || terminal.has(result.status)) return result;
      await delay(10);
    }
    throw new Error("turn did not start");
  }
  t.after(() => stop());
  await start();
  return { root, port, call, rpc, finished, started, records, stop, start, env };
}

test("discovery, authentication, schemas, and validation", async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${f.port}/healthz`)).json(), { status: "ok" });
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/mcp`, { method: "POST", body: "{}" })).status, 401);
  const discover = await f.rpc({ jsonrpc: "2.0", id: "d", method: "server/discover" });
  assert.equal(discover.error.code, -32601);
  const initialized = await f.rpc({ jsonrpc: "2.0", id: "i", method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  assert.equal(initialized.result.serverInfo.version, "3.2.0");
  const listed = await f.rpc({ jsonrpc: "2.0", id: "l", method: "tools/list" });
  assert.deepEqual(listed.result.tools.map(t => t.name), ["codex", "codex-reply", "codex-status", "codex-cancel", "codex-browser-status", "codex-folders"]);
  const browserStatus = listed.result.tools.find(t => t.name === "codex-browser-status");
  assert.equal(browserStatus.annotations.readOnlyHint, true);
  assert.deepEqual(browserStatus.inputSchema.required, ["cwd"]);
  assert.deepEqual(listed.result.tools[0].inputSchema.required, ["requestId", "cwd", "prompt"]);
  const codex = listed.result.tools[0];
  const reply = listed.result.tools[1];
  assert.equal(codex.inputSchema.properties.networkAccess.type, "boolean");
  assert.equal(codex.inputSchema.properties.networkAccess.default, false);
  assert.match(codex.description, /different canonical folders can run concurrently/i);
  assert.match(codex.description, /serialized through the queue/i);
  for (const text of [codex.description, codex.inputSchema.properties.networkAccess.description]) {
    assert.match(text, /task intent/i);
    assert.match(text, /even if.*(?:did not|never).*network access/i);
    assert.match(text, /git fetch.*git pull.*git clone.*(?:dependencies|package).*curl.*HTTP\/API.*downloads/i);
    assert.match(text, /(?:omit|false).*fully local/i);
  }
  assert.equal(reply.inputSchema.properties.networkAccess.type, "boolean");
  assert.equal(reply.inputSchema.properties.networkAccess.default, undefined);
  for (const text of [reply.description, reply.inputSchema.properties.networkAccess.description]) {
    assert.match(text, /omit.*inherit/i);
    assert.match(text, /enabled.*stays enabled.*disabled.*stays disabled/i);
    assert.match(text, /set true.*newly requires outbound/i);
    assert.match(text, /even if.*(?:implies it|never mentions network access)/i);
    assert.match(text, /set false.*disabled again/i);
  }
  assert.equal(listed.result.tools[0].annotations.openWorldHint, true);
  assert.equal(listed.result.tools[1].annotations.openWorldHint, true);
  assert.equal((await f.call("codex", { prompt: "hello" })).errorCode, "schema_outdated");
  assert.equal((await f.call("codex", { requestId: "r", prompt: "hello", permissions: "all" })).errorCode, "invalid_request");
  for (const networkAccess of [null, 1, "true", {}]) {
    assert.equal((await f.call("codex", { requestId: `network-${JSON.stringify(networkAccess)}`, prompt: "hello", networkAccess })).errorCode, "invalid_request");
  }
  const missing = await f.call("codex", { requestId: "r", prompt: "hello", cwd: undefined });
  assert.equal(missing.errorCode, "schema_outdated"); assert.match(missing.message, /cwd/);
  assert.equal((await f.call("codex-reply", { requestId: "r", threadId: "unknown", prompt: "hello" })).errorCode, "unknown_thread");
  assert.equal((await f.call("codex-status", { jobId: "missing" })).errorCode, "unknown_job");
  assert.equal((await f.records()).length, 0);
});

test("durable immediate acceptance, duplicate retries, same-folder queueing, and final answer", async t => {
  const f = await fixture(t);
  const args = { requestId: "same", prompt: "delay:500" };
  const before = Date.now();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.call("codex", args)));
  assert.ok(Date.now() - before < 450, "acceptance must not wait for generation");
  assert.equal(new Set(results.map(r => r.jobId)).size, 1);
  const { jobId } = results[0];
  assert.equal((await f.call("codex", { ...args, prompt: "different" })).errorCode, "request_conflict");
  const queued = await f.call("codex", { requestId: "other", prompt: "hello" });
  assert.equal(queued.status, "queued"); assert.ok(queued.jobId);
  assert.equal((await f.call("codex", { requestId: "other", prompt: "hello" })).jobId, queued.jobId);
  const ready = await (await fetch(`http://127.0.0.1:${f.port}/readyz`)).json();
  assert.equal(ready.activeCalls, 1); assert.equal(ready.queuedCalls, 1);
  assert.equal(ready.maxConcurrency, 4); assert.equal(ready.maxQueue, 100);
  assert.deepEqual(ready.queuedJobIds, [queued.jobId]);
  assert.equal((await f.call("codex-status", { jobId, waitMs: 20001 })).errorCode, "invalid_wait");
  const result = await f.finished(jobId);
  assert.equal(result.content, "FINAL_OK"); assert.equal(result.status, "completed");
  assert.equal(result.model, "gpt-5.6-luna"); assert.equal(result.reasoningEffort, "max");
  assert.equal(result.networkAccess, false);
  assert.equal((await f.call("codex", args)).jobId, jobId);
  const queuedResult = await f.finished(queued.jobId);
  assert.equal(queuedResult.status, "completed"); assert.equal(queuedResult.content, "FINAL_OK");
  const records = await f.records();
  assert.equal(records.filter(r => r.method === "turn/start").length, 2);
  const start = records.find(r => r.method === "thread/start");
  assert.equal(start.params.permissions, "local-codex-tunnel");
  assert.equal(start.params.approvalPolicy, "never"); assert.equal(start.params.cwd, f.root);
  assert.equal(records.find(r => r.method === "turn/start").params.permissions, "local-codex-tunnel");
  const config = records.find(r => r.event === "spawn").args.join(" ");
  assert.match(config, /network=\{enabled=false\}/);
  assert.match(config, /"\.git"="write"/);
  assert.match(config, /"\.codex"="read"/);
  for (const denied of [".env", ".env.*", "**/.env", "**/.env.*", "*.env", "**/*.env", ".npmrc", "**/.npmrc", ".pypirc", "**/.pypirc"]) {
    assert.ok(config.includes(`${JSON.stringify(denied)}="deny"`));
  }
  const state = JSON.parse(await readFile(join(f.root, "threads.json"), "utf8"));
  assert.ok(state.threadIds.includes(result.threadId));
  assert.equal(state.schemaVersion, 4); assert.equal(state.threadNetworkAccess[result.threadId], false);
  const jobFile = join(f.root, "jobs", `${jobId}.json`);
  assert.equal((await stat(jobFile)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, "jobs"))).mode & 0o777, 0o700);
  assert.ok(!(await readFile(jobFile, "utf8")).includes(args.prompt));
});

test("different folders run concurrently while same-folder jobs serialize", async t => {
  const f = await fixture(t, { maxConcurrency: 2 });
  const first = await realpath(await mkdtemp(join(tmpdir(), "codex-concurrency-a-")));
  const second = await realpath(await mkdtemp(join(tmpdir(), "codex-concurrency-b-")));
  const a1 = await f.call("codex", { requestId: "a1", cwd: first, prompt: "hold" });
  await f.started(a1.jobId);
  const a2 = await f.call("codex", { requestId: "a2", cwd: first, prompt: "hello" });
  assert.equal(a2.status, "queued");
  const b1 = await f.call("codex", { requestId: "b1", cwd: second, prompt: "hold" });
  await f.started(b1.jobId);
  const ready = await (await fetch(`http://127.0.0.1:${f.port}/readyz`)).json();
  assert.equal(ready.activeCalls, 2); assert.equal(ready.queuedCalls, 1);
  assert.deepEqual(new Set(ready.activeCwds), new Set([first, second]));
  assert.deepEqual(ready.queuedCwds, [first]);
  assert.equal(ready.scheduling, "fifo-runnable-per-folder");
  await f.call("codex-cancel", { jobId: a1.jobId });
  assert.equal((await f.finished(a1.jobId)).status, "cancelled");
  const startedA2 = await f.started(a2.jobId);
  assert.ok(startedA2.turnId, "same-folder queued job starts after the folder lock is released");
  assert.equal((await f.finished(a2.jobId)).status, "completed");
  await f.call("codex-cancel", { jobId: b1.jobId });
  assert.equal((await f.finished(b1.jobId)).status, "cancelled");
});

test("bounded queue is FIFO among runnable jobs and returns queue_full", async t => {
  const f = await fixture(t, { maxConcurrency: 1, maxQueue: 2 });
  const folders = [];
  for (const name of ["a", "b", "c", "d"]) folders.push(await realpath(await mkdtemp(join(tmpdir(), `codex-queue-${name}-`))));
  const active = await f.call("codex", { requestId: "queue-a", cwd: folders[0], prompt: "hold" });
  await f.started(active.jobId);
  const b = await f.call("codex", { requestId: "queue-b", cwd: folders[1], prompt: "delay:80" });
  const c = await f.call("codex", { requestId: "queue-c", cwd: folders[2], prompt: "hello" });
  assert.equal(b.status, "queued"); assert.equal(c.status, "queued");
  const full = await f.call("codex", { requestId: "queue-d", cwd: folders[3], prompt: "hello" });
  assert.equal(full.status, "error"); assert.equal(full.errorCode, "queue_full");
  await f.call("codex-cancel", { jobId: active.jobId });
  assert.equal((await f.finished(active.jobId)).status, "cancelled");
  assert.equal((await f.finished(b.jobId)).status, "completed");
  assert.equal((await f.finished(c.jobId)).status, "completed");
  const starts = (await f.records()).filter(r => r.method === "thread/start").map(r => r.params.cwd);
  assert.deepEqual(starts, [folders[0], folders[1], folders[2]]);
  const retried = await f.call("codex", { requestId: "queue-d", cwd: folders[3], prompt: "hello" });
  assert.notEqual(retried.status, "error");
  assert.equal((await f.finished(retried.jobId)).status, "completed");
});

test("queued jobs can be cancelled and are interrupted without replay after restart", async t => {
  const f = await fixture(t, { maxConcurrency: 1, maxQueue: 3 });
  const first = await realpath(await mkdtemp(join(tmpdir(), "codex-recovery-a-")));
  const second = await realpath(await mkdtemp(join(tmpdir(), "codex-recovery-b-")));
  const third = await realpath(await mkdtemp(join(tmpdir(), "codex-recovery-c-")));
  const active = await f.call("codex", { requestId: "recovery-active", cwd: first, prompt: "hold" });
  await f.started(active.jobId);
  const cancelled = await f.call("codex", { requestId: "recovery-cancelled", cwd: second, prompt: "hello" });
  assert.equal(cancelled.status, "queued");
  assert.equal((await f.call("codex-cancel", { jobId: cancelled.jobId })).status, "cancelled");
  assert.equal((await f.call("codex-status", { jobId: cancelled.jobId })).status, "cancelled");
  const queued = await f.call("codex", { requestId: "recovery-queued", cwd: third, prompt: "hello" });
  assert.equal(queued.status, "queued");
  await f.stop("SIGKILL"); await f.start();
  assert.equal((await f.call("codex-status", { jobId: active.jobId })).status, "interrupted");
  assert.equal((await f.call("codex-status", { jobId: queued.jobId })).status, "interrupted");
  assert.equal((await f.call("codex-status", { jobId: cancelled.jobId })).status, "cancelled");
  assert.equal((await f.records()).filter(r => r.method === "turn/start").length, 1);
});

test("stale schemas return actionable errors, never start work, and log only schema metadata", async t => {
  const f = await fixture(t);
  const listed = await f.rpc({ jsonrpc: "2.0", id: "SCHEMA_REQUEST_SECRET", method: "tools/list" });
  const fingerprint = createHash("sha256").update(JSON.stringify(listed.result.tools)).digest("hex");
  const health = await (await fetch(`http://127.0.0.1:${f.port}/readyz`)).json();
  assert.equal(health.schemaFingerprint, fingerprint);
  const cases = [
    ["codex", { prompt: "PROMPT_SECRET" }],
    ["codex", { requestId: "CALLER_ID_SECRET", prompt: "PROMPT_SECRET" }],
    ["codex-reply", { threadId: "THREAD_SECRET", prompt: "PROMPT_SECRET" }],
  ];
  for (const [name, args] of cases) {
    const response = await f.rpc({ jsonrpc: "2.0", id: "RPC_SECRET", method: "tools/call", params: { name, arguments: args } });
    const result = response.result.structuredContent;
    assert.equal(response.result.isError, true);
    assert.equal(result.errorCode, "schema_outdated");
    assert.match(result.message, /Manage > Refresh.*fresh chat.*No job was started/);
    assert.equal(result.adapterVersion, health.version);
    assert.equal(result.schemaFingerprint, fingerprint);
  }
  for (const requestId of [null, "", " ", "x".repeat(201)]) {
    assert.equal((await f.call("codex", { requestId, prompt: "hello" })).errorCode, "invalid_request");
  }
  assert.equal((await f.records()).length, 0);
  const logs = (await readFile(join(f.root, "audit.log"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(logs.some(line => line.event === "schema_served" && line.schemaFingerprint === fingerprint));
  assert.equal(logs.filter(line => line.event === "call_rejected" && line.errorCode === "schema_outdated").length, cases.length);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  assert.ok(logs.every(line => line.schemaFingerprint === fingerprint && line.adapterVersion === health.version));
});

test("defaults, overrides, resumed settings, unsupported settings, and safe logs", async t => {
  const f = await fixture(t);
  const first = await f.finished((await f.call("codex", { requestId: "a", prompt: "hello", model: "terra", reasoningEffort: "high" })).jobId);
  assert.equal(first.model, "gpt-5.6-terra"); assert.equal(first.reasoningEffort, "high");
  await f.stop(); await f.start();
  const reply = await f.finished((await f.call("codex-reply", { requestId: "b", threadId: first.threadId, prompt: "reply" })).jobId);
  assert.equal(reply.model, "gpt-5.6-terra"); assert.equal(reply.reasoningEffort, "high");
  const overridden = await f.finished((await f.call("codex-reply", { requestId: "c", threadId: first.threadId, prompt: "reply", model: "luna", reasoningEffort: "max" })).jobId);
  assert.equal(overridden.model, "gpt-5.6-luna");
  const inherited = await f.finished((await f.call("codex-reply", { requestId: "d", threadId: first.threadId, prompt: "reply" })).jobId);
  assert.equal(inherited.model, "gpt-5.6-luna"); assert.equal(inherited.reasoningEffort, "max");
  for (const args of [{ model: "missing" }, { model: "terra", reasoningEffort: "max" }]) {
    const result = await f.finished((await f.call("codex", { requestId: JSON.stringify(args), prompt: "hello", ...args })).jobId);
    assert.equal(result.status, "failed"); assert.match(result.errorCode, /^unsupported_/);
  }
  const failed = await f.finished((await f.call("codex", { requestId: "error", prompt: "upstream-error-secret" })).jobId);
  assert.equal(failed.status, "failed"); assert.ok(!JSON.stringify(failed).includes("UPSTREAM_SECRET"));
  const audit = await readFile(join(f.root, "audit.log"), "utf8");
  for (const secret of ["test-secret", "UPSTREAM_SECRET", "upstream-error-secret", "PRIVATE_REASONING", "FINAL_OK"]) assert.ok(!audit.includes(secret));
});

test("network access is opt-in; replies inherit and persist explicit overrides", async t => {
  const f = await fixture(t);
  const defaultArgs = { requestId: "network-default", prompt: "hello" };
  const disabled = await f.finished((await f.call("codex", defaultArgs)).jobId);
  assert.equal(disabled.networkAccess, false);
  assert.equal((await f.call("codex", defaultArgs)).jobId, disabled.jobId);
  assert.equal((await f.call("codex", { ...defaultArgs, networkAccess: false })).errorCode, "request_conflict");

  const enabled = await f.finished((await f.call("codex", { requestId: "network-enabled", prompt: "hello", networkAccess: true })).jobId);
  assert.equal(enabled.networkAccess, true);
  await f.stop(); await f.start();
  const inherited = await f.finished((await f.call("codex-reply", { requestId: "network-inherited", threadId: enabled.threadId, prompt: "hello" })).jobId);
  assert.equal(inherited.networkAccess, true);
  const overridden = await f.finished((await f.call("codex-reply", { requestId: "network-disabled-reply", threadId: enabled.threadId, prompt: "hello", networkAccess: false })).jobId);
  assert.equal(overridden.networkAccess, false);
  await f.stop(); await f.start();
  const inheritedDisabled = await f.finished((await f.call("codex-reply", { requestId: "network-inherited-disabled", threadId: enabled.threadId, prompt: "hello" })).jobId);
  assert.equal(inheritedDisabled.networkAccess, false);

  const calls = await f.records();
  const configs = calls.filter(r => r.event === "spawn").map(r => r.args[r.args.indexOf("-c") + 1]);
  assert.deepEqual(configs.map(config => /network=\{enabled=true\}/.test(config)), [false, true, true, false, false]);
  for (const request of calls.filter(r => ["thread/start", "thread/resume", "turn/start"].includes(r.method))) {
    assert.equal(request.params.permissions, "local-codex-tunnel");
  }
  const state = JSON.parse(await readFile(join(f.root, "threads.json"), "utf8"));
  assert.equal(state.threadNetworkAccess[disabled.threadId], false);
  assert.equal(state.threadNetworkAccess[enabled.threadId], false);
  const audit = await readFile(join(f.root, "audit.log"), "utf8");
  assert.match(audit, /"networkAccess":true/); assert.match(audit, /"networkAccess":false/);
});

test("status cancellation and disconnect do not cancel accepted work", async t => {
  const f = await fixture(t);
  const job = await f.call("codex", { requestId: "hold", prompt: "hold" });
  await f.started(job.jobId);
  const ac = new AbortController();
  const pending = f.call("codex-status", { jobId: job.jobId, waitMs: 20000 }, ac.signal).catch(e => e.name);
  await delay(40); ac.abort(); assert.equal(await pending, "AbortError");
  const poll = f.call("codex-status", { jobId: job.jobId, waitMs: 20000 }, undefined, "poll-id");
  await delay(40);
  await f.rpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "poll-id" } });
  assert.equal((await poll).status, "running");
  assert.equal((await f.records()).filter(r => r.method === "turn/interrupt").length, 0);
  const state = JSON.parse(await readFile(join(f.root, "threads.json"), "utf8"));
  assert.equal(state.threadIds.length, 1, "register the thread before completion");
  assert.equal((await f.call("codex-cancel", { jobId: job.jobId })).status, "cancelling");
  const result = await f.finished(job.jobId); assert.equal(result.status, "cancelled");
  assert.equal((await f.call("codex-cancel", { jobId: job.jobId })).status, "cancelled");
  assert.equal((await f.records()).filter(r => r.method === "turn/interrupt").length, 1);
  for (const r of (await f.records()).filter(r => r.event === "spawn")) assert.throws(() => process.kill(r.pid, 0), /ESRCH/);
});

test("timeout, stubborn child cleanup, server failure, and missing executable", async t => {
  const f = await fixture(t, { timeout: 250 });
  const held = await f.call("codex", { requestId: "t", prompt: "stubborn" });
  const timed = await f.finished(held.jobId);
  assert.equal(timed.status, "timed_out");
  for (const r of (await f.records()).filter(r => r.event === "spawn")) assert.throws(() => process.kill(r.pid, 0), /ESRCH/);
  const crash = await f.finished((await f.call("codex", { requestId: "c", prompt: "crash" })).jobId);
  assert.equal(crash.status, "failed"); assert.equal(crash.errorCode, "server_exit");
  const ok = await f.finished((await f.call("codex", { requestId: "ok", prompt: "hello" })).jobId);
  assert.equal(ok.status, "completed");
  const missing = await fixture(t, { missingBin: true });
  const failed = await missing.finished((await missing.call("codex", { requestId: "missing", prompt: "hello" })).jobId);
  assert.equal(failed.status, "failed"); assert.equal(failed.errorCode, "spawn_failed");
});

test("acceptance fails closed when job storage cannot be written", async t => {
  const f = await fixture(t);
  await rename(join(f.root, "jobs"), join(f.root, "jobs-old"));
  await writeFile(join(f.root, "jobs"), "not a directory");
  const failed = await f.call("codex", { requestId: "disk", prompt: "hello" });
  assert.equal(failed.errorCode, "storage_error");
  assert.equal((await f.records()).length, 0);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/readyz`)).status, 503);
});

test("graceful shutdown cancels all active and queued work without replaying it", async t => {
  const f = await fixture(t, { maxConcurrency: 2 });
  const first = await realpath(await mkdtemp(join(tmpdir(), "shutdown-a-")));
  const second = await realpath(await mkdtemp(join(tmpdir(), "shutdown-b-")));
  const job = await f.call("codex", { requestId: "shutdown", cwd: first, prompt: "hold" });
  const other = await f.call("codex", { requestId: "shutdown-other", cwd: second, prompt: "hold" });
  const queued = await f.call("codex", { requestId: "shutdown-queued", cwd: first, prompt: "hello" });
  await f.started(job.jobId); await f.started(other.jobId); assert.equal(queued.status, "queued");
  await f.stop(); await f.start();
  assert.equal((await f.call("codex-status", { jobId: job.jobId })).status, "interrupted");
  assert.equal((await f.call("codex-status", { jobId: other.jobId })).status, "interrupted");
  assert.equal((await f.call("codex-status", { jobId: queued.jobId })).status, "interrupted");
  assert.equal((await f.records()).filter(r => r.method === "turn/start").length, 2);
  for (const r of (await f.records()).filter(r => r.event === "spawn")) assert.throws(() => process.kill(r.pid, 0), /ESRCH/);
});

test("saved results survive restart; unfinished jobs are never replayed", async t => {
  const f = await fixture(t);
  const args = { requestId: "finished", prompt: "hello" };
  const done = await f.finished((await f.call("codex", args)).jobId);
  const holdArgs = { requestId: "unfinished", prompt: "hold" };
  const held = await f.call("codex", holdArgs); await f.started(held.jobId);
  await f.stop("SIGKILL"); await f.start();
  const interrupted = await f.call("codex-status", { jobId: held.jobId });
  assert.equal(interrupted.status, "interrupted"); assert.equal(interrupted.errorCode, "adapter_restarted");
  assert.equal((await f.call("codex", holdArgs)).jobId, held.jobId);
  const result = await f.call("codex", args);
  assert.equal(result.jobId, done.jobId); assert.equal(result.content, "FINAL_OK");
  assert.equal((await f.records()).filter(r => r.method === "turn/start").length, 2);
  await delay(50);
  for (const r of (await f.records()).filter(r => r.event === "spawn")) assert.throws(() => process.kill(r.pid, 0), /ESRCH/);
});

test("protected macOS completion hooks do not poison readiness after child exit", async t => {
  const f = await fixture(t, { deniedGroup: true });
  const result = await f.finished((await f.call("codex", { requestId: "hook", prompt: "hello" })).jobId);
  assert.equal(result.status, "completed");
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/readyz`)).status, 200);
  const held = await f.call("codex", { requestId: "cancel-hook", prompt: "stubborn" });
  await f.started(held.jobId); await f.call("codex-cancel", { jobId: held.jobId });
  assert.equal((await f.finished(held.jobId)).status, "cancelled");
  for (const r of (await f.records()).filter(r => r.event === "spawn")) assert.throws(() => process.kill(r.pid, 0), /ESRCH/);
});

test("jobs choose arbitrary canonical folders; replies keep their original folder", async t => {
  const f = await fixture(t);
  // Sibling folders outside the former configured root must work without an allowlist.
  const first = await realpath(await mkdtemp(join(tmpdir(), "codex-folder-a-")));
  const second = await realpath(await mkdtemp(join(tmpdir(), "codex-folder-b-")));
  const link = join(f.root, "directory-link"); await symlink(first, link);
  const args = { requestId: "folder-a", cwd: link, prompt: "hello" };
  const a = await f.finished((await f.call("codex", args)).jobId);
  assert.equal(a.cwd, first);
  assert.equal((await f.call("codex", { ...args, cwd: first })).jobId, a.jobId);
  assert.equal((await f.call("codex", { ...args, cwd: second })).errorCode, "request_conflict");
  const b = await f.finished((await f.call("codex", { requestId: "folder-b", cwd: second, prompt: "hello" })).jobId);
  assert.equal(b.cwd, second);
  await f.stop(); delete f.env.LOCAL_CODEX_ROOT; await f.start();
  const reply = await f.finished((await f.call("codex-reply", { requestId: "reply-a", threadId: a.threadId, prompt: "hello" })).jobId);
  assert.equal(reply.cwd, first);
  assert.equal((await f.call("codex-reply", { requestId: "change", threadId: a.threadId, cwd: second, prompt: "hello" })).errorCode, "invalid_request");
  const calls = await f.records();
  assert.deepEqual(calls.filter(r => r.event === "spawn").map(r => r.cwd), [first, second, first]);
  for (const r of calls.filter(r => r.event === "spawn")) {
    const permissions = r.args[r.args.indexOf("-c") + 1];
    assert.ok(permissions.includes(`workspace_roots={${JSON.stringify(r.cwd)}=true}`));
    assert.match(permissions, /network=\{enabled=false\}/);
  }
  for (const r of calls.filter(r => r.method === "turn/start")) {
    const expected = r.params.threadId === a.threadId ? first : second;
    assert.equal(r.params.cwd, expected); assert.equal(r.params.approvalPolicy, "never");
  }
  const state = JSON.parse(await readFile(join(f.root, "threads.json"), "utf8"));
  assert.deepEqual(state.threadCwds, { [a.threadId]: first, [b.threadId]: second });
  // Replacing a saved directory with a symlink must not silently change reply access.
  await rename(first, first + "-moved"); await symlink(second, first);
  const changed = await f.finished((await f.call("codex-reply", { requestId: "changed-folder", threadId: a.threadId, prompt: "hello" })).jobId);
  assert.equal(changed.errorCode, "folder_changed");
  assert.equal((await f.records()).filter(r => r.event === "spawn").length, 3);
});

test("directory lookup paginates names only and rejects invalid paths and cursors", async t => {
  const f = await fixture(t);
  const directory = join(f.root, "browse"); await mkdir(directory);
  for (let i = 0; i < 105; i++) await mkdir(join(directory, `dir-${String(i).padStart(3, "0")}`));
  await writeFile(join(directory, "private-file.txt"), "PRIVATE_FILE_CONTENT");
  await symlink(join(directory, "dir-000"), join(directory, "dir-link"));
  await symlink(join(directory, "missing"), join(directory, "broken-link"));
  const home = await f.call("codex-folders", {});
  assert.equal(home.path, await realpath(homedir()));
  const page1 = await f.call("codex-folders", { path: directory });
  assert.equal(page1.directories.length, 100); assert.ok(page1.nextCursor);
  const page2 = await f.call("codex-folders", { path: directory, cursor: page1.nextCursor });
  assert.equal(page2.directories.length, 6); assert.equal(page2.nextCursor, null);
  const all = [...page1.directories, ...page2.directories];
  assert.equal(new Set(all).size, 106); assert.ok(all.includes("dir-link"));
  assert.ok(!JSON.stringify([page1, page2]).includes("private-file"));
  assert.equal((await f.call("codex-folders", { path: f.root, cursor: page1.nextCursor })).errorCode, "invalid_cursor");
  assert.equal((await f.call("codex-folders", { path: directory, cursor: "invalid" })).errorCode, "invalid_cursor");
  for (const cwd of ["relative", join(directory, "missing"), join(directory, "private-file.txt"), join(directory, "broken-link")]) {
    assert.equal((await f.call("codex", { requestId: cwd, cwd, prompt: "hello" })).errorCode, "invalid_directory");
  }
  assert.equal((await f.records()).length, 0);
});

test("legacy migration pins old folders and preserves fingerprints and results", async t => {
  const f = await fixture(t);
  const args = { requestId: "legacy", prompt: "hello" };
  const done = await f.finished((await f.call("codex", args)).jobId);
  await f.stop();
  const file = join(f.root, "jobs", `${done.jobId}.json`);
  const oldJob = JSON.parse(await readFile(file, "utf8")); delete oldJob.cwd;
  await writeFile(file, JSON.stringify(oldJob));
  await writeFile(join(f.root, "threads.json"), JSON.stringify({ threadIds: [done.threadId], retainedMetadata: "keep" }));
  await f.start();
  const migrated = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(migrated, { ...oldJob, cwd: f.root });
  assert.equal((await f.call("codex", args)).jobId, done.jobId);
  const state = JSON.parse(await readFile(join(f.root, "threads.json"), "utf8"));
  assert.equal(state.threadCwds[done.threadId], f.root); assert.equal(state.threadNetworkAccess[done.threadId], false);
  assert.equal(state.schemaVersion, 4); assert.equal(state.retainedMetadata, "keep");
  assert.equal((await stat(join(f.root, "threads.json"))).mode & 0o777, 0o600);
  await f.stop(); f.env.LOCAL_CODEX_ROOT = "/missing-old-config-root"; await f.start();
  const reply = await f.finished((await f.call("codex-reply", { requestId: "legacy-reply", threadId: done.threadId, prompt: "hello" })).jobId);
  assert.equal(reply.cwd, f.root);
});

test("native macOS sandbox blocks sibling and symlink writes, including system temp", {
  skip: process.platform !== "darwin" || process.env.LOCAL_CODEX_NATIVE_TEST !== "1",
}, async t => {
  const f = await fixture(t);
  const a = join(f.root, "native-a"), b = join(f.root, "native-b");
  await mkdir(a); await mkdir(b);
  await symlink(b, join(a, "escape")); await symlink(a, join(b, "escape"));
  for (const [cwd, other] of [[a, b], [b, a]]) {
    await mkdir(join(cwd, ".git")); await mkdir(join(cwd, ".codex"));
    await writeFile(join(cwd, ".codex", "config.toml"), "readable");
    await writeFile(join(cwd, ".env"), "SECRET");
    await writeFile(join(cwd, ".npmrc"), "SECRET");
    await writeFile(join(cwd, ".pypirc"), "SECRET");
    await f.finished((await f.call("codex", { requestId: cwd, cwd, prompt: "hello" })).jobId);
    const spawnRecord = (await f.records()).filter(r => r.event === "spawn" && r.cwd === cwd).at(-1);
    const config = spawnRecord.args[spawnRecord.args.indexOf("-c") + 1];
    const command = 'printf allowed > "$1/inside" || exit 10; printf allowed > "$1/.git/FETCH_HEAD" || exit 11; test "$(cat "$1/.codex/config.toml")" = readable || exit 12; if (printf blocked > "$1/.codex/changed") 2>/dev/null; then exit 13; fi; if (cat "$1/.env" >/dev/null 2>&1); then exit 14; fi; if (cat "$1/.npmrc" >/dev/null 2>&1); then exit 15; fi; if (cat "$1/.pypirc" >/dev/null 2>&1); then exit 16; fi; if (printf blocked > "$2/outside") 2>/dev/null; then exit 17; fi; if (printf blocked > "$1/escape/escaped") 2>/dev/null; then exit 18; fi';
    const child = spawn("codex", ["sandbox", "-P", "local-codex-tunnel", "-C", cwd, "-c", config, "--", "/bin/sh", "-c", command, "native-test", cwd, other], { stdio: "ignore" });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, "native sandbox must allow own folder and deny both escape paths");
    assert.equal(await readFile(join(cwd, "inside"), "utf8"), "allowed");
    assert.equal(await readFile(join(cwd, ".git", "FETCH_HEAD"), "utf8"), "allowed");
    await assert.rejects(stat(join(cwd, ".codex", "changed")), { code: "ENOENT" });
    await assert.rejects(stat(join(other, "outside")), { code: "ENOENT" });
    await assert.rejects(stat(join(other, "escaped")), { code: "ENOENT" });
  }
});

test("native macOS sandbox enforces the command network toggle", {
  skip: process.platform !== "darwin" || process.env.LOCAL_CODEX_NATIVE_TEST !== "1",
}, async t => {
  const f = await fixture(t);
  const disabled = await f.finished((await f.call("codex", { requestId: "native-network-off", prompt: "hello" })).jobId);
  const enabled = await f.finished((await f.call("codex", { requestId: "native-network-on", prompt: "hello", networkAccess: true })).jobId);
  const records = await f.records();
  const configFor = job => {
    const startIndex = records.findIndex(r => r.method === "thread/start" && r.params.cwd === job.cwd && r.params.developerInstructions.includes(job.networkAccess ? "enabled" : "disabled"));
    const spawns = records.slice(0, startIndex + 1).filter(r => r.event === "spawn");
    return spawns.at(-1).args[spawns.at(-1).args.indexOf("-c") + 1];
  };
  const listener = createServer(socket => socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"));
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  t.after(() => listener.close());
  const endpoint = `http://127.0.0.1:${listener.address().port}`;
  const probe = config => new Promise(resolve => {
    const child = spawn("codex", ["sandbox", "-P", "local-codex-tunnel", "-C", f.root, "-c", config, "--", "/usr/bin/curl", "--fail", "--silent", "--output", "/dev/null", endpoint], { stdio: "ignore" });
    child.once("exit", code => resolve(code));
  });
  assert.notEqual(await probe(configFor(disabled)), 0);
  assert.equal(await probe(configFor(enabled)), 0);
});

const fakeSource = String.raw`#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = process.env.FAKE_ROOT;
const log = value => appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(value)+'\n');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const notify = (method, params) => send({method,params});
let settings, threadId, turnId, mode;
const load = () => { try { return JSON.parse(readFileSync(join(root,'fake-threads.json'),'utf8')); } catch { return {}; } };
const save = () => { const all=load(); all[threadId]=settings; writeFileSync(join(root,'fake-threads.json'),JSON.stringify(all)); };
const catalog = [
 {model:'gpt-5.6-luna',supportedReasoningEfforts:[{reasoningEffort:'max'},{reasoningEffort:'low'}]},
 {model:'gpt-5.6-terra',supportedReasoningEfforts:[{reasoningEffort:'high'}]},
];
log({event:'spawn',pid:process.pid,cwd:process.cwd(),args:process.argv.slice(2)});
const input=createInterface({input:process.stdin});
input.on('close',()=>process.exit(0));
input.on('line',line=>{
 const m=JSON.parse(line); log(m); const p=m.params||{};
 const reply=result=>send({id:m.id,result});
 switch(m.method){
 case 'initialize': reply({}); break;
 case 'model/list': reply({data:[catalog[p.cursor?1:0]],nextCursor:p.cursor?null:'next'}); break;
 case 'thread/start':
  threadId=randomUUID(); settings={cwd:p.cwd,model:p.model,reasoningEffort:p.config.model_reasoning_effort}; save();
  reply({thread:{id:threadId,cwd:settings.cwd},...settings}); break;
 case 'thread/resume': threadId=p.threadId; settings=load()[threadId]; reply({thread:{id:threadId,cwd:settings.cwd},...settings}); break;
 case 'turn/start':
  mode=p.input[0].text;
  if(mode==='upstream-error-secret'){send({id:m.id,error:{message:'UPSTREAM_SECRET'}});break;}
  if(mode==='crash'){process.exit(9);}
  settings={cwd:p.cwd,model:p.model,reasoningEffort:p.effort};save();turnId=randomUUID();
  reply({turn:{id:turnId}});
  notify('thread/settings/updated',{threadId,threadSettings:{model:p.model,effort:p.effort}});
  notify('turn/started',{threadId,turn:{id:turnId}});
  notify('item/reasoning/textDelta',{threadId,delta:'PRIVATE_REASONING'});
  if(mode==='stubborn')process.on('SIGTERM',()=>{});
  if(mode==='hold'||mode==='stubborn')break;
  setTimeout(()=>{
   notify('item/completed',{threadId,item:{id:'comment',type:'agentMessage',phase:'commentary',text:'WORKING'}});
   notify('item/agentMessage/delta',{threadId,itemId:'answer',delta:'FINAL_OK'});
   notify('item/completed',{threadId,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'FINAL_OK'}});
   notify('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});
  },mode.startsWith('delay:')?Number(mode.slice(6)):20);break;
 case 'turn/interrupt':
  if(mode==='stubborn')break;
  reply({});notify('turn/completed',{threadId,turn:{id:turnId,status:'interrupted'}});break;
 }
});
`;

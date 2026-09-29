import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { TraceStore } from "../observability.mjs";
import { createTraceProxy } from "./local-codex-trace-proxy.mjs";

async function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

function result(id, value) {
  return {
    jsonrpc: "2.0", id,
    result: { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] },
  };
}

async function fakeAdapter(port) {
  let statusCount = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }
    if (req.url === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        status: "ready", version: "3.5.2", schemaFingerprint: "schema-test",
        activeCalls: 0, queuedCalls: 0, maxConcurrency: 10, maxQueue: 100,
        pollLeaseMs: 90000, browserAccessStatus: "official-backend",
      }));
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    let body;
    if (message.method === "initialize") body = { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } };
    else if (message.method === "tools/list") body = { jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "codex", outputSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string" } } } },
      { name: "codex-status", outputSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string" } } } },
    ] } };
    else if (message.method === "tools/call" && message.params?.name === "codex") {
      body = result(message.id, {
        jobId: "job-1", status: "starting", cwd: "/tmp/local-codex-worktree-job-1",
        sourceCwd: "/tmp/source", threadId: null, turnId: null,
        model: null, reasoningEffort: null, networkAccess: false, browserAccess: false,
      });
    } else if (message.method === "tools/call" && message.params?.name === "codex-status") {
      statusCount += 1;
      body = result(message.id, statusCount === 1 ? {
        jobId: "job-1", status: "running", cwd: "/tmp/local-codex-worktree-job-1",
        sourceCwd: "/tmp/source", threadId: "thread-1", turnId: "turn-1",
        model: "gpt-5.6-luna", reasoningEffort: "max", networkAccess: false, browserAccess: false,
      } : {
        jobId: "job-1", status: "completed", cwd: "/tmp/local-codex-worktree-job-1",
        sourceCwd: "/tmp/source", threadId: "thread-1", turnId: "turn-1",
        model: "gpt-5.6-luna", reasoningEffort: "max", networkAccess: false, browserAccess: false,
        content: "LOCAL_CODEX_CANARY_OK", finishedAt: Date.now(),
      });
    } else body = result(message.id, { status: "error", errorCode: "invalid_request" });
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "local-codex" });
    res.end(JSON.stringify(body));
  });
  await new Promise(resolvePromise => server.listen(port, "127.0.0.1", resolvePromise));
  return server;
}

async function call(port, token, message) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify(message),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("proxy correlates submit, polling, terminal receipt, and schema without prompt logging", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "trace-proxy-test-"));
  const token = "Bearer test-token";
  const tokenFile = resolve(root, "token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const adapterPort = await freePort();
  const proxyPort = await freePort();
  const adapter = await fakeAdapter(adapterPort);
  const store = await new TraceStore({
    logFile: resolve(root, "trace-events.jsonl"), stateDir: resolve(root, "traces"), maxBytes: 1024 * 1024, rotations: 2,
  }).init();
  const proxy = await createTraceProxy({
    host: "127.0.0.1", port: proxyPort, adapterHost: "127.0.0.1", adapterPort, tokenFile, traceStore: store,
    env: { ...process.env, LOCAL_CODEX_REAL_BIN: process.execPath },
  });
  await proxy.listen();
  t.after(async () => { await proxy.close(); await new Promise(resolvePromise => adapter.close(resolvePromise)); });

  const listed = await call(proxyPort, token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.ok(listed.result.tools.some(tool => tool.name === "codex-trace-receipt"));
  const codexSchema = listed.result.tools.find(tool => tool.name === "codex").outputSchema;
  assert.ok(codexSchema.properties.traceId);

  const prompt = "Reply with exactly LOCAL_CODEX_CANARY_OK SECRET_PROMPT_NEVER_LOG";
  const submitted = await call(proxyPort, token, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "codex", arguments: { requestId: "canary-1", cwd: "/tmp/source", prompt } },
  });
  const submit = submitted.result.structuredContent;
  assert.equal(submit.jobId, "job-1");
  assert.match(submit.traceId, /^trc_/);
  assert.match(submit.requestTraceId, /^req_/);

  const running = await call(proxyPort, token, {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "codex-status", arguments: { jobId: "job-1", waitMs: 0 } },
  });
  assert.equal(running.result.structuredContent.status, "running");
  assert.equal(running.result.structuredContent.traceId, submit.traceId);

  const completed = await call(proxyPort, token, {
    jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "codex-status", arguments: { jobId: "job-1", waitMs: 0 } },
  });
  assert.equal(completed.result.structuredContent.status, "completed");
  assert.equal(completed.result.structuredContent.traceId, submit.traceId);

  const receiptResponse = await call(proxyPort, token, {
    jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "codex-trace-receipt", arguments: { jobId: "job-1" } },
  });
  const receipt = receiptResponse.result.structuredContent;
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.pass, true);
  assert.equal(receipt.traceId, submit.traceId);
  assert.equal(receipt.bridge.adapterVersion, "3.5.2");
  assert.equal(receipt.bridge.schemaFingerprint, "schema-test");
  assert.ok(receipt.observedStages.includes("mcp.request.received"));
  assert.ok(receipt.observedStages.includes("mcp.request.validated"));
  assert.ok(receipt.observedStages.includes("status.poll.received"));
  assert.ok(receipt.observedStages.includes("job.result.persisted"));
  assert.ok(receipt.observedStages.includes("job.terminal.observed"));
  const receiptText = JSON.stringify(receipt);
  assert.equal(receiptText.includes("SECRET_PROMPT_NEVER_LOG"), false);
  assert.equal(receiptText.includes("/tmp/source"), false);

  const log = await readFile(store.logFile, "utf8");
  assert.equal(log.includes("SECRET_PROMPT_NEVER_LOG"), false);
  assert.equal(log.includes("/tmp/source"), false);
  assert.match(log, /folderFingerprint/);
});

test("proxy reports adapter transport failure with stable code", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "trace-proxy-fail-test-"));
  const token = "Bearer test-token";
  const tokenFile = resolve(root, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const proxyPort = await freePort();
  const deadPort = await freePort();
  const store = await new TraceStore({ logFile: resolve(root, "trace.jsonl"), stateDir: resolve(root, "traces") }).init();
  const proxy = await createTraceProxy({ host: "127.0.0.1", port: proxyPort, adapterHost: "127.0.0.1", adapterPort: deadPort, tokenFile, traceStore: store, env: process.env });
  await proxy.listen();
  t.after(() => proxy.close());
  const response = await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(response.status, 502);
  const log = await readFile(store.logFile, "utf8");
  assert.match(log, /transport_unreachable/);
});

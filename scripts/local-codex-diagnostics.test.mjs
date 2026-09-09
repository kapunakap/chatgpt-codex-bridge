import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { runCanary, runDoctor } from "./local-codex-diagnostics.mjs";

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

function toolResult(id, value, isError = false) {
  return { jsonrpc: "2.0", id, result: { structuredContent: value, ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(value) }] } };
}

async function startServer(port, handler) {
  const server = createServer(handler);
  await new Promise(resolvePromise => server.listen(port, "127.0.0.1", resolvePromise));
  return server;
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "diagnostics-test-"));
  const stateDir = resolve(root, "state");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const tokenFile = resolve(stateDir, "token");
  await writeFile(tokenFile, "Bearer test\n", { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const config = resolve(stateDir, "config.env");
  await writeFile(config, "# test\n", { mode: 0o600 });
  const port = await freePort();
  return {
    root, stateDir, tokenFile, config, port,
    env: {
      ...process.env,
      LOCAL_CODEX_HOST: "127.0.0.1",
      LOCAL_CODEX_PORT: String(port),
      LOCAL_CODEX_TOKEN_FILE: tokenFile,
      LOCAL_CODEX_CONFIG_FILE: config,
      LOCAL_CODEX_STATE_FILE: resolve(stateDir, "threads.json"),
      LOCAL_CODEX_REAL_BIN: process.execPath,
    },
  };
}

test("doctor exits healthy when local dependencies and MCP trace schema are healthy", async t => {
  const f = await fixture();
  const server = await startServer(f.port, async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }
    if (req.url === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        status: "ready", activeCalls: 0, queuedCalls: 0, pollLeaseMs: 90000,
        dependencies: { adapter: "ready", traceStorage: "ready", scheduler: "ready", runtimeCleanup: "ready", pollingLease: "ready", tunnelClient: "ready" },
      }));
    }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    const body = message.method === "tools/list"
      ? { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "codex" }, { name: "codex-status" }, { name: "codex-trace-receipt" }] } }
      : { jsonrpc: "2.0", id: message.id, result: {} };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  t.after(() => new Promise(resolvePromise => server.close(resolvePromise)));
  const result = await runDoctor(f.env);
  assert.equal(result.ok, true);
  assert.equal(result.rows.some(row => row.level === "FAIL"), false);
});

test("doctor returns failure for unreachable proxy", async () => {
  const f = await fixture();
  const result = await runDoctor(f.env);
  assert.equal(result.ok, false);
  assert.ok(result.rows.some(row => row.check === "proxy_health" && row.level === "FAIL"));
  assert.ok(result.rows.some(row => row.check === "local_mcp" && row.level === "FAIL"));
});

test("local canary exercises submit, polling and sanitized receipt", async t => {
  const f = await fixture();
  const server = await startServer(f.port, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    let body;
    if (message.params?.name === "codex") {
      assert.equal(message.params.arguments.networkAccess, false);
      assert.equal(message.params.arguments.browserAccess, false);
      assert.equal(message.params.arguments.worktree, false);
      assert.equal(message.params.arguments.prompt, "Reply with exactly LOCAL_CODEX_CANARY_OK");
      body = toolResult(message.id, { status: "starting", jobId: "job-canary", traceId: "trc-canary" });
    } else if (message.params?.name === "codex-status") {
      body = toolResult(message.id, { status: "completed", jobId: "job-canary", traceId: "trc-canary", content: "LOCAL_CODEX_CANARY_OK" });
    } else if (message.params?.name === "codex-trace-receipt") {
      body = toolResult(message.id, { status: "ok", pass: true, jobId: "job-canary", traceId: "trc-canary", observedStages: ["job.accepted", "codex.turn.completed", "job.terminal.observed"] });
    } else body = toolResult(message.id, { status: "error", message: "unexpected" }, true);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  t.after(() => new Promise(resolvePromise => server.close(resolvePromise)));
  const output = await runCanary(f.env);
  assert.equal(output.status, "PASS");
  assert.equal(output.jobId, "job-canary");
  assert.equal(output.traceId, "trc-canary");
  assert.equal(output.receipt.pass, true);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const root = await mkdtemp(join(tmpdir(), "local-codex-adapter-test-"));
const tokenFile = join(root, "token");
await writeFile(tokenFile, "Bearer test-secret\n", { mode: 0o600 });
const port = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, ["adapter.mjs"], {
  cwd: fileURLToPath(new URL(".", import.meta.url)),
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    LOCAL_CODEX_PORT: String(port),
    LOCAL_CODEX_TOKEN_FILE: tokenFile,
    LOCAL_CODEX_STATE_FILE: join(root, "threads.json"),
    LOCAL_CODEX_LOG_FILE: join(root, "calls.log"),
    LOCAL_CODEX_ROOT: root,
  },
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("adapter did not start")), 5000);
  child.stderr.on("data", chunk => {
    if (chunk.toString().includes("ready on")) {
      clearTimeout(timeout);
      resolve();
    }
  });
  child.on("exit", code => reject(new Error(`adapter exited with ${code}`)));
});

test.after(() => child.kill("SIGTERM"));

test("health is loopback-accessible without exposing MCP", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("MCP requires the local bearer token", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(response.status, 401);
});

test("discovery falls back and tools have constrained schemas", async () => {
  const discover = await rpc({ jsonrpc: "2.0", id: "discover", method: "server/discover", params: {} });
  assert.equal(discover.error.code, -32601);

  const initialized = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");

  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ["codex", "codex-reply"]);
  assert.deepEqual(Object.keys(listed.result.tools[0].inputSchema.properties), ["prompt", "model", "reasoningEffort"]);
  assert.deepEqual(Object.keys(listed.result.tools[1].inputSchema.properties), ["threadId", "prompt", "model", "reasoningEffort"]);
  assert.equal(initialized.result.serverInfo.version, "1.1.0");
});

test("reply rejects threads not created by this adapter", async () => {
  const response = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "codex-reply",
      arguments: { threadId: "unknown-thread", prompt: "hello" },
    },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /not created by this Local Codex adapter/);
});

async function rpc(message) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
  assert.equal(response.status, 200);
  return response.json();
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

const repo = fileURLToPath(new URL(".", import.meta.url));

test("Browser proxy authenticates and forwards newline JSON over a private Unix socket", async t => {
  const root = await mkdtemp(join(tmpdir(), "local-codex-browser-proxy-test-"));
  const socketPath = join(root, "broker.sock");
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        if (!authenticated) {
          assert.equal(message.token, "capability-token");
          authenticated = true;
        } else {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })}\n`);
        }
      }
    });
  });
  await new Promise(resolvePromise => server.listen(socketPath, resolvePromise));
  const child = spawn(process.execPath, [join(repo, "browser-proxy.mjs"), "--socket", socketPath, "--token", "capability-token"], {
    cwd: repo, stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    await new Promise(resolvePromise => server.close(resolvePromise));
    await rm(root, { recursive: true, force: true });
  });
  const response = new Promise(resolvePromise => {
    let buffer = "";
    child.stdout.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolvePromise(JSON.parse(buffer.slice(0, newline)));
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
  assert.deepEqual(await response, { jsonrpc: "2.0", id: 1, result: { ok: true } });
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const proxy = join(root, "bin/local-codex-guard-proxy.mjs");
const fixture = join(root, "test/fixtures/guard-browser-environment-app-server.mjs");

async function runCase(mode) {
  const temp = await mkdtemp(join(tmpdir(), `local-codex-guard-browser-${mode}-`));
  const guardDir = join(temp, "guard");
  const child = spawn(process.execPath, [
    proxy,
    "--real-bin", fixture,
    "--guard-dir", guardDir,
    "--network-access", "false",
    "--",
    "--case", mode,
  ], { cwd: temp, stdio: ["pipe", "pipe", "pipe"] });
  const output = [];
  readline.createInterface({ input: child.stdout }).on("line", line => output.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({
    id: 1,
    method: "turn/start",
    params: { threadId: "thread-browser", input: [{ type: "text", text: "run browser smoke" }] },
  })}\n`);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0);

  const eventFile = join(guardDir, "events", (await readdir(join(guardDir, "events")))[0]);
  const persisted = (await readFile(eventFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const bridged = output
    .filter(message => message.method === "localCodex/visibleEvent")
    .map(message => message.params.event);
  return { output, persisted, bridged };
}

test("Guard classifies the known Chromium Mach-port sandbox failure", async () => {
  const result = await runCase("browser");
  const event = result.bridged.find(entry => entry.type === "browser.environment_blocked");
  assert.ok(event, "known Chromium sandbox failure should produce a structured environment event");
  assert.equal(event.data.errorCode, "browser_sandbox_blocked");
  assert.equal(event.data.signature, "chromium_mach_port_rendezvous");
  assert.match(event.data.message, /execution-environment failure evidence/i);
  assert.equal(result.persisted.some(entry => entry.type === "browser.environment_blocked"), true);

  const types = result.bridged.map(entry => entry.type);
  assert.ok(types.indexOf("item.completed") < types.indexOf("browser.environment_blocked"));
  assert.ok(result.output.some(message => message.method === "item/completed"), "original app-server event must still reach the adapter");
});

test("Guard does not classify generic command permission errors as browser failures", async () => {
  const result = await runCase("generic");
  assert.equal(result.bridged.some(entry => entry.type === "browser.environment_blocked"), false);
  assert.equal(result.persisted.some(entry => entry.type === "browser.environment_blocked"), false);
  assert.ok(result.bridged.some(entry => entry.type === "item.completed"));
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const proxy = join(root, "bin/local-codex-guard-proxy.mjs");
const fixture = join(root, "test/fixtures/guard-app-server.mjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("guard proxy forces native approvals, hides reasoning, and blocks until host decision", async () => {
  const temp = await mkdtemp(join(tmpdir(), "local-codex-guard-"));
  const guardDir = join(temp, "guard");
  const trace = join(temp, "trace.jsonl");
  const child = spawn(process.execPath, [proxy, "--real-bin", fixture, "--guard-dir", guardDir, "--network-access", "true", "--", "--trace", trace], {
    cwd: temp, stdio: ["pipe", "pipe", "pipe"],
  });
  const output = [];
  readline.createInterface({ input: child.stdout }).on("line", line => output.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-1", approvalPolicy: "never", input: [{ type: "text", text: "Ship it" }] } })}\n`);

  let pendingName;
  for (let i = 0; i < 100; i++) {
    try {
      pendingName = (await readdir(join(guardDir, "approvals"))).find(name => name.endsWith(".pending.json"));
      if (pendingName) break;
    } catch {}
    await delay(20);
  }
  assert.ok(pendingName, "approval should remain pending without a host decision");
  assert.equal(output.some(message => message.method === "item/commandExecution/requestApproval"), false, "adapter must not receive the held approval request");

  const traceMessages = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  const turn = traceMessages.find(message => message.method === "turn/start");
  assert.equal(turn.params.approvalPolicy, "untrusted");
  assert.equal(turn.params.approvalsReviewer, "user");

  const eventFile = join(guardDir, "events", (await readdir(join(guardDir, "events")))[0]);
  const eventText = await readFile(eventFile, "utf8");
  assert.match(eventText, /Ship it/);
  assert.match(eventText, /Visible answer/);
  assert.match(eventText, /approval\.requested/);
  assert.doesNotMatch(eventText, /PRIVATE_REASONING/);

  const pending = JSON.parse(await readFile(join(guardDir, "approvals", pendingName), "utf8"));
  await writeFile(join(guardDir, "approvals", `${pending.approvalId}.decision.json`), `${JSON.stringify({ decision: "accept" })}\n`, { mode: 0o600 });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0);
  const finalTrace = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(finalTrace.find(message => message.id === "approval-1")?.result, { decision: "accept" });
  assert.ok(output.some(message => message.method === "turn/completed"));
});

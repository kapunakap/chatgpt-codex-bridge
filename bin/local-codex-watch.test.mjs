import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const watch = join(root, "bin/local-codex-watch.mjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture({ approval = false, commandOutput = false } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "local-codex-watch-"));
  const jobsDir = join(temp, "jobs");
  const guard = join(temp, "guard");
  for (const dir of [jobsDir, join(guard, "sessions"), join(guard, "events"), join(guard, "approvals")]) await mkdir(dir, { recursive: true });
  const jobId = "11111111-1111-1111-1111-111111111111";
  await writeFile(join(temp, "token"), "Bearer test\n");
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    jobId, status: "running", cwd: join(temp, "gta-labin"), threadId: "thread-1", model: "gpt-5.6-luna",
    reasoningEffort: "high", networkAccess: true, startedAt: Date.now() - 12000, updatedAt: Date.now(),
  }));
  await writeFile(join(guard, "sessions", "session-1.json"), JSON.stringify({
    sessionId: "session-1", cwd: join(temp, "gta-labin"), threadId: "thread-1", status: approval ? "held" : "running",
    startedAt: Date.now() - 12000, updatedAt: Date.now(), networkAccess: true,
  }));
  const events = [
    { seq: 1, time: new Date().toISOString(), sessionId: "session-1", type: "chatgpt.prompt", data: { text: "Find the needle and ship the branch" } },
    { seq: 2, time: new Date().toISOString(), sessionId: "session-1", type: "assistant.delta", data: { text: "needle result" } },
  ];
  if (commandOutput) events.push({
    seq: 3, time: new Date().toISOString(), sessionId: "session-1", type: "item.completed",
    data: { item: { type: "commandExecution", command: ["npm", "test"], aggregatedOutput: "line one\nline two\nline three\nline four\nEXPANDED_ONLY\nline six" } },
  });
  await writeFile(join(guard, "events", "session-1.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`);
  if (approval) {
    await writeFile(join(guard, "approvals", "approval-1.pending.json"), JSON.stringify({
      approvalId: "approval-1", sessionId: "session-1", requestId: "request-1", networkAccess: true, createdAt: Date.now(),
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1", itemId: "item-1", kind: "command",
        command: ["git", "push", "origin", "feature/guard"], reason: "Publish the completed branch",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    }));
  }
  return { temp, jobsDir, guard, jobId };
}

function startWatch(f, args = []) {
  const child = spawn(process.execPath, [watch, ...args], {
    env: {
      ...process.env,
      LOCAL_CODEX_JOBS_DIR: f.jobsDir,
      LOCAL_CODEX_STATE_FILE: join(f.temp, "threads.json"),
      LOCAL_CODEX_TOKEN_FILE: join(f.temp, "token"),
      LOCAL_CODEX_PORT: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  return { child, read: () => stdout };
}

test("watch renders the mock-driven monitor layout and dominant approval state", async () => {
  const f = await fixture({ approval: true });
  const { child, read } = startWatch(f, ["--once"]);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const stdout = read();
  assert.equal(code, 0);
  assert.match(stdout, /LOCAL CODEX GUARD/);
  assert.match(stdout, /APPROVAL REQUIRED/);
  assert.match(stdout, /git push origin feature\/guard/);
  assert.match(stdout, /Remote write/);
  assert.match(stdout, /Host credentials/);
  assert.match(stdout, /Workspace writes/);
  assert.match(stdout, /No action will execute until approved/);
  assert.match(stdout, /JOB INSPECTOR/);
  assert.match(stdout, /d details/);
});

test("watch collapses command output, expands it, searches events, and toggles follow", async t => {
  const f = await fixture({ commandOutput: true });
  const { child, read } = startWatch(f);
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });

  await delay(350);
  const initial = read();
  assert.match(initial, /command output 6 lines/);
  assert.doesNotMatch(initial, /EXPANDED_ONLY/);

  const expandAt = initial.length;
  child.stdin.write("l");
  await delay(180);
  const expanded = read().slice(expandAt);
  assert.match(expanded, /EXPANDED_ONLY/);
  assert.match(expanded, /collapse/);

  const searchAt = read().length;
  child.stdin.write("/");
  await delay(60);
  child.stdin.write("needle");
  await delay(60);
  child.stdin.write("\r");
  await delay(180);
  const searched = read().slice(searchAt);
  assert.match(searched, /SEARCH/);
  assert.match(searched, /\/needle/);

  const followAt = read().length;
  child.stdin.write("f");
  await delay(180);
  assert.match(read().slice(followAt), /FOLLOW ○/);

  child.stdin.write("q");
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0);
});

test("watch exposes sanitized approval details on d", async t => {
  const f = await fixture({ approval: true });
  const { child, read } = startWatch(f);
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  await delay(300);
  const before = read().length;
  child.stdin.write("d");
  await delay(180);
  const detailed = read().slice(before);
  assert.match(detailed, /DETAILS/);
  assert.match(detailed, /item\/commandExecution\/requestApproval/);
  assert.match(detailed, /request-1/);
  assert.match(detailed, /Decisions/);
  assert.match(detailed, /acceptForSession/);
  child.stdin.write("q");
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
});

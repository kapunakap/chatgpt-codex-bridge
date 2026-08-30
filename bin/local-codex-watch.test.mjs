import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const watch = join(root, "bin/local-codex-watch.mjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readWhenPresent(file, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await readFile(file, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
    }
    await delay(25);
  }
}

async function fixture({ approval = false, commandOutput = false } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "local-codex-watch-"));
  const jobsDir = join(temp, "jobs");
  const jobEventsDir = join(temp, "job-events");
  const guard = join(temp, "guard");
  for (const dir of [jobsDir, jobEventsDir, join(guard, "sessions"), join(guard, "events"), join(guard, "approvals")]) await mkdir(dir, { recursive: true });
  const jobId = "11111111-1111-1111-1111-111111111111";
  const jobFile = join(jobsDir, jobId + ".json");
  const sessionFile = join(guard, "sessions", "session-1.json");
  await mkdir(join(temp, "gta-labin"), { recursive: true });
  await writeFile(join(temp, "token"), "Bearer test\n");
  await writeFile(jobFile, JSON.stringify({
    jobId, status: "running", cwd: join(temp, "gta-labin"), threadId: "thread-1", model: "gpt-5.6-luna",
    reasoningEffort: "high", networkAccess: true, startedAt: Date.now() - 12000, updatedAt: Date.now(),
  }));
  await writeFile(sessionFile, JSON.stringify({
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
  const eventText = events.map(JSON.stringify).join("\n") + "\n";
  await writeFile(join(guard, "events", "session-1.jsonl"), eventText);
  await writeFile(join(jobEventsDir, jobId + ".jsonl"), eventText);
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
  return { temp, jobsDir, jobEventsDir, guard, jobId, jobFile, sessionFile, events };
}

function startWatch(f, args = [], env = {}) {
  const child = spawn(process.execPath, [watch, ...args], {
    env: {
      ...process.env,
      LOCAL_CODEX_JOBS_DIR: f.jobsDir,
      LOCAL_CODEX_STATE_FILE: join(f.temp, "threads.json"),
      LOCAL_CODEX_TOKEN_FILE: join(f.temp, "token"),
      LOCAL_CODEX_PORT: "1",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  return { child, read: () => stdout };
}

test("watch opens only terminal jobs through the configured secure resume handoff", async t => {
  const f = await fixture();
  const recordFile = join(f.temp, "resume-record.json");
  const fakeSecure = join(f.temp, "fake-secure-resume.mjs");
  await writeFile(fakeSecure, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.TEST_RESUME_RECORD, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  network: process.env.LOCAL_CODEX_RESUME_NETWORK_ACCESS,
  token: process.env.LOCAL_CODEX_RESUME_TOKEN,
  interactive: process.env.LOCAL_CODEX_INTERACTIVE_RESUME,
}));
`);
  await chmod(fakeSecure, 0o755);
  const { child, read } = startWatch(f, [], {
    LOCAL_CODEX_BIN: fakeSecure,
    TEST_RESUME_RECORD: recordFile,
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  await delay(300);

  const activeAt = read().length;
  child.stdin.write("o");
  await delay(160);
  assert.match(read().slice(activeAt), /Wait for this job to finish before opening Codex CLI/);
  await assert.rejects(readFile(recordFile, "utf8"), { code: "ENOENT" });

  const completedAt = Date.now();
  await writeFile(f.jobFile, JSON.stringify({
    jobId: f.jobId, status: "completed", cwd: join(f.temp, "gta-labin"), threadId: "thread-1",
    model: "gpt-5.6-luna", reasoningEffort: "high", networkAccess: true,
    startedAt: completedAt - 12000, updatedAt: completedAt, finishedAt: completedAt,
  }));
  await delay(350);
  const openAt = read().length;
  child.stdin.write("o");
  await delay(350);
  const record = JSON.parse(await readWhenPresent(recordFile));
  assert.deepEqual(record.args, ["resume", "thread-1"]);
  assert.equal(record.cwd, await realpath(join(f.temp, "gta-labin")));
  assert.equal(record.network, "true");
  assert.equal(record.token, "Bearer test");
  assert.equal(record.interactive, "1");
  await delay(160);
  assert.match(read().slice(openAt), /Returned from Codex CLI/);
  assert.match(read().slice(openAt), /\x1b\[\?25h\x1b\[\?1049l/);
  assert.match(read().slice(openAt), /\x1b\[\?1049h\x1b\[\?25l/);

  child.stdin.write("q");
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
});

test("browser jobs warn before native CLI handoff and launch on the second o", async t => {
  const f = await fixture();
  const completedAt = Date.now();
  await writeFile(f.jobFile, JSON.stringify({
    jobId: f.jobId, status: "completed", cwd: join(f.temp, "gta-labin"), threadId: "thread-1",
    model: "gpt-5.6-luna", reasoningEffort: "high", networkAccess: false, browserAccess: true,
    startedAt: completedAt - 12000, updatedAt: completedAt, finishedAt: completedAt,
  }));
  const recordFile = join(f.temp, "browser-resume.json");
  const fakeSecure = join(f.temp, "fake-browser-resume.mjs");
  await writeFile(fakeSecure, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.TEST_RESUME_RECORD, JSON.stringify(process.argv.slice(2)));
`);
  await chmod(fakeSecure, 0o755);
  const { child, read } = startWatch(f, [], {
    LOCAL_CODEX_BIN: fakeSecure,
    TEST_RESUME_RECORD: recordFile,
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  await delay(300);
  const warningAt = read().length;
  child.stdin.write("o");
  await delay(160);
  assert.match(read().slice(warningAt), /ChatGPT Browser context is unavailable in CLI/);
  await assert.rejects(readFile(recordFile, "utf8"), { code: "ENOENT" });
  child.stdin.write("o");
  assert.deepEqual(JSON.parse(await readWhenPresent(recordFile)), ["resume", "thread-1"]);
  child.stdin.write("q");
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
});

test("watch restores the monitor after secure resume launch failure", async t => {
  const f = await fixture();
  const completedAt = Date.now();
  await writeFile(f.jobFile, JSON.stringify({
    jobId: f.jobId, status: "completed", cwd: join(f.temp, "gta-labin"), threadId: "thread-1",
    model: "gpt-5.6-luna", reasoningEffort: "high", networkAccess: false,
    startedAt: completedAt - 12000, updatedAt: completedAt, finishedAt: completedAt,
  }));
  const { child, read } = startWatch(f, [], { LOCAL_CODEX_BIN: join(f.temp, "missing-secure-wrapper") });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  await delay(300);
  const failedAt = read().length;
  child.stdin.write("o");
  await delay(300);
  const output = read().slice(failedAt);
  assert.match(output, /Unable to start Codex CLI/);
  assert.match(output, /\x1b\[\?1049h\x1b\[\?25l/);
  child.stdin.write("q");
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
});

test("watch restores a snapshotted worktree before opening the native CLI", async t => {
  const f = await fixture();
  const restoredCwd = join(f.temp, "restored-worktree");
  await mkdir(restoredCwd);
  const completedAt = Date.now();
  await writeFile(f.jobFile, JSON.stringify({
    jobId: f.jobId, status: "completed", cwd: join(f.temp, "missing-worktree"),
    sourceCwd: join(f.temp, "gta-labin"), workspaceKind: "worktree",
    worktreeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", worktreeState: "snapshotted",
    threadId: "thread-1", model: "gpt-5.6-luna", reasoningEffort: "high", networkAccess: false,
    startedAt: completedAt - 12000, updatedAt: completedAt, finishedAt: completedAt,
  }));
  let restoreCalls = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ready", maxConcurrency: 10 }));
      return;
    }
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body);
      if (message.method === "localCodex/worktreeRestore") restoreCalls += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { cwd: restoredCwd, worktreeState: "ready" } }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const recordFile = join(f.temp, "restored-resume.json");
  const fakeSecure = join(f.temp, "fake-restored-resume.mjs");
  await writeFile(fakeSecure, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.TEST_RESUME_RECORD, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
`);
  await chmod(fakeSecure, 0o755);
  const { child } = startWatch(f, [], {
    LOCAL_CODEX_BIN: fakeSecure,
    LOCAL_CODEX_PORT: String(server.address().port),
    TEST_RESUME_RECORD: recordFile,
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  await delay(300);
  child.stdin.write("o");
  const record = JSON.parse(await readWhenPresent(recordFile));
  assert.equal(restoreCalls, 1);
  assert.equal(record.cwd, await realpath(restoredCwd));
  assert.deepEqual(record.args, ["resume", "thread-1"]);
  child.stdin.write("q");
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
});

test("watch renders the mock-driven monitor layout and dominant approval state", async () => {
  const f = await fixture({ approval: true });
  const { child, read } = startWatch(f, ["--once"]);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const stdout = read();
  assert.equal(code, 0);
  assert.match(stdout, /LOCAL CODEX MONITOR/);
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

for (const [status, label] of [
  ["completed", "✓ DONE"],
  ["cancelled", "■ STOP"],
  ["failed", "✕ FAIL"],
  ["timed_out", "✕ FAIL"],
]) {
  test("watch keeps the selected job visible after running transitions to " + status, async t => {
    const f = await fixture();
    const otherJobId = "22222222-2222-2222-2222-222222222222";
    await writeFile(join(f.jobsDir, otherJobId + ".json"), JSON.stringify({
      jobId: otherJobId,
      status: "running",
      cwd: join(f.temp, "other-project"),
      threadId: "thread-2",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      networkAccess: false,
      startedAt: Date.now() - 5000,
      updatedAt: Date.now() - 1000,
    }));
    const { child, read } = startWatch(f);
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    await delay(350);
    assert.match(read(), /\x1b\[44;97;1m● RUN  gta-labin/);

    const changedAt = Date.now();
    await writeFile(f.jobFile, JSON.stringify({
      jobId: f.jobId,
      status,
      cwd: join(f.temp, "gta-labin"),
      threadId: "thread-1",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      networkAccess: true,
      startedAt: changedAt - 12000,
      updatedAt: changedAt,
      finishedAt: changedAt,
    }));
    await writeFile(f.sessionFile, JSON.stringify({
      sessionId: "session-1",
      cwd: join(f.temp, "gta-labin"),
      threadId: "thread-1",
      status: "ended",
      startedAt: changedAt - 12000,
      updatedAt: changedAt,
      networkAccess: true,
    }));
    await writeFile(join(f.guard, "approvals", "stale.pending.json"), JSON.stringify({
      approvalId: "stale",
      sessionId: "session-1",
      requestId: "stale-request",
      networkAccess: true,
      createdAt: changedAt,
      method: "item/commandExecution/requestApproval",
      params: { command: ["echo", "stale"] },
    }));
    const marker = "PERSISTED_AFTER_" + status;
    const terminalEvents = [
      ...f.events,
      {
        seq: 99,
        time: new Date(changedAt).toISOString(),
        sessionId: "session-1",
        type: "assistant.delta",
        data: { text: marker },
      },
      {
        seq: 100,
        time: new Date(changedAt).toISOString(),
        sessionId: "session-1",
        type: "turn.completed",
        data: { status },
      },
    ];
    await writeFile(
      join(f.jobEventsDir, f.jobId + ".jsonl"),
      terminalEvents.map(JSON.stringify).join("\n") + "\n"
    );

    const changedOutputAt = read().length;
    await delay(450);
    const changed = read().slice(changedOutputAt);
    assert.match(changed, new RegExp("\\x1b\\[44;97;1m" + label + "  gta-labin"));
    assert.match(changed, new RegExp(marker));
    assert.doesNotMatch(changed, /APPROVAL REQUIRED/);
    assert.doesNotMatch(changed, /! HOLD  gta-labin/);

    child.stdin.write("q");
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0);
  });
}

test("watch keeps a selected queued job visible when it starts running", async t => {
  const f = await fixture();
  const queuedAt = Date.now();
  await writeFile(f.jobFile, JSON.stringify({
    jobId: f.jobId,
    status: "queued",
    cwd: join(f.temp, "gta-labin"),
    threadId: "thread-1",
    model: null,
    reasoningEffort: null,
    networkAccess: false,
    startedAt: queuedAt,
    updatedAt: queuedAt,
  }));
  const { child, read } = startWatch(f);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  await delay(350);
  assert.match(read(), /\x1b\[44;97;1m○ QUE  gta-labin/);

  const runningAt = Date.now();
  await writeFile(f.jobFile, JSON.stringify({
    jobId: f.jobId,
    status: "running",
    cwd: join(f.temp, "gta-labin"),
    threadId: "thread-1",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    networkAccess: false,
    startedAt: queuedAt,
    updatedAt: runningAt,
  }));
  const changedOutputAt = read().length;
  await delay(450);
  assert.match(read().slice(changedOutputAt), /\x1b\[44;97;1m● RUN  gta-labin/);

  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
});

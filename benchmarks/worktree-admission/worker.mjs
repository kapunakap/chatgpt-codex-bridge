import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const execFile = promisify((await import("node:child_process")).execFile);
const [scenario, candidateArg, scratchArg] = process.argv.slice(2);
const candidateRoot = resolve(candidateArg || ".");
const scratchRoot = resolve(scratchArg || ".");
const sourceFile = join(candidateRoot, "worktree-manager.mjs");
const markerFile = join(scratchRoot, "git-stall.json");

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function makeFixture(name) {
  const root = join(scratchRoot, name);
  const repo = join(root, "source-repo");
  await mkdir(repo, { recursive: true });
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_PROTOCOL_FROM_USER: "0",
  };
  await execFile("git", ["init", "-q"], { cwd: repo, env, timeout: 2500, maxBuffer: 1024 * 1024 });
  await execFile("git", ["config", "user.name", "Benchmark Fixture"], { cwd: repo, env, timeout: 2500, maxBuffer: 1024 * 1024 });
  await execFile("git", ["config", "user.email", "benchmark-fixture@localhost"], { cwd: repo, env, timeout: 2500, maxBuffer: 1024 * 1024 });
  await writeFile(join(repo, "fixture.txt"), "local benchmark fixture\n");
  await execFile("git", ["add", "fixture.txt"], { cwd: repo, env, timeout: 2500, maxBuffer: 1024 * 1024 });
  await execFile("git", ["commit", "-qm", "fixture"], { cwd: repo, env, timeout: 2500, maxBuffer: 1024 * 1024 });
  return {
    repo,
    rootDir: join(root, "managed-worktrees"),
    stateDir: join(root, "state"),
  };
}

async function loadManager(fixture) {
  const moduleUrl = pathToFileURL(sourceFile).href;
  const { createWorktreeManager } = await import(moduleUrl);
  return createWorktreeManager({ rootDir: fixture.rootDir, stateDir: fixture.stateDir, retention: 15 });
}

function within(promise, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    promise.then(value => {
      clearTimeout(timer);
      resolve({ timedOut: false, value });
    }, error => {
      clearTimeout(timer);
      resolve({ timedOut: false, error: { code: error?.code || null, message: String(error?.message || error) } });
    });
  });
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fileExists(path) {
  try { await readFile(path); return true; } catch { return false; }
}

async function waitForFile(path, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(path)) return true;
    await delay(10);
  }
  return fileExists(path);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function waitForPidsGone(pids, timeoutMs = 1400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every(pid => !pidAlive(pid))) return true;
    await delay(25);
  }
  return pids.every(pid => !pidAlive(pid));
}

async function prepareStallScript(kind) {
  const script = join(scratchRoot, kind === "timeout" ? "stall-timeout.sh" : "stall-abort.mjs");
  const body = kind === "timeout"
    ? `#!/bin/sh
trap '' TERM
sleep 30 &
child=$!
printf '{"git_pid":%s,"child_pid":%s,"started_ms":%s}\n' "$$" "$child" "$(date +%s)000" > "$WA_STALL_MARKER"
wait "$child"
while :; do sleep 1; done
`
    : `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.WA_STALL_MARKER + ".started", "started");
process.on("SIGTERM", () => setTimeout(() => { writeFileSync(process.env.WA_STALL_MARKER + ".exited", String(Date.now())); process.exit(0); }, 80));
setInterval(() => {}, 1000);
`;
  await writeFile(script, body, { mode: 0o700 });
  await chmod(script, 0o700);
  return script;
}

async function admissionScenario() {
  const fixture = await makeFixture("admission");
  const manager = await loadManager(fixture);
  const idFor = value => `00000000-0000-0000-0000-${value.toString(16).padStart(12, "0")}`;
  for (let i = 1; i <= 225; i++) {
    const id = idFor(i);
    manager.records.set(id, {
      id,
      state: "ready",
      lastUsedAt: i,
      createdAt: i,
      worktreeRoot: join(fixture.rootDir, `fake-${i}`),
      executionCwd: join(fixture.rootDir, `fake-${i}`),
    });
  }
  const firstStarted = deferred();
  const secondStarted = deferred();
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  let snapshotCalls = 0;
  manager.snapshotAndRemove = async record => {
    snapshotCalls += 1;
    if (snapshotCalls === 1) {
      firstStarted.resolve();
      await gate;
    }
    if (snapshotCalls === 2) secondStarted.resolve();
    record.state = "snapshotted";
  };

  const prunePromise = manager.prune(new Set(), { limit: 4 });
  await firstStarted.promise;
  const admissionId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const admissionPromise = manager.plan({ id: admissionId, sourceCwd: fixture.repo });
  releaseFirst();
  const winner = await Promise.race([
    admissionPromise.then(() => "admission"),
    secondStarted.promise.then(() => "second_gc_candidate"),
    delay(2500).then(() => "deadline"),
  ]);
  const [pruneResult, admissionResult] = await Promise.allSettled([prunePromise, admissionPromise]);
  return {
    scenario,
    backlog_records: 225,
    winner,
    admission_state: admissionResult.status === "fulfilled" ? admissionResult.value.state : null,
    snapshot_calls: snapshotCalls,
    pruned_count: pruneResult.status === "fulfilled" ? pruneResult.value.length : null,
    prune_error: pruneResult.status === "rejected" ? String(pruneResult.reason?.message || pruneResult.reason) : null,
  };
}

async function disabledPlanScenario() {
  const fixture = await makeFixture("disabled-plan");
  const manager = await loadManager(fixture);
  let release;
  const blocker = manager.serial(() => new Promise(resolve => { release = resolve; }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const startedAt = Date.now();
  const planPromise = manager.plan({
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sourceCwd: fixture.repo,
    enabled: false,
  }).then(value => ({ value }), error => ({ error: { code: error?.code || null } }));
  const beforeRelease = await within(planPromise, 300);
  const durationMs = Date.now() - startedAt;
  release();
  await blocker;
  const final = beforeRelease.timedOut ? await within(planPromise, 1200) : beforeRelease;
  return {
    scenario,
    resolved_before_release: !beforeRelease.timedOut && Boolean(beforeRelease.value?.value),
    state: final.value?.value?.state || null,
    reason: final.value?.value?.reason || null,
    duration_ms: durationMs,
  };
}

async function stalledGitScenario() {
  const fixture = await makeFixture("stalled-git");
  const manager = await loadManager(fixture);
  const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  await manager.plan({ id, sourceCwd: fixture.repo });
  const script = await prepareStallScript("timeout");
  process.env.WA_STALL_MARKER = markerFile;
  manager.gitTimeoutMs = 350;
  manager.gitBin = script;
  const startedAt = Date.now();
  let prepareSettledAt = null;
  const preparePromise = manager.prepare(id).then(
    value => ({ value, error: null }),
    error => ({ value: null, error: { code: error?.code || null } }),
  ).then(result => { prepareSettledAt = Date.now(); return result; });
  const started = await waitForFile(markerFile, 1200);
  const followPromise = manager.bindThread(id, "benchmark-follow-up").then(value => ({ value }), error => ({ error: { code: error?.code || null } }));
  const outcome = await within(preparePromise, 2200);
  let followUp = { timedOut: true };
  if (!outcome.timedOut) followUp = await within(followPromise, 700);
  let pids = [];
  try {
    const parsed = JSON.parse(await readFile(markerFile, "utf8"));
    pids = [parsed.git_pid, parsed.child_pid].filter(Number.isInteger);
  } catch {}
  const processTreeGone = outcome.timedOut ? false : await waitForPidsGone(pids, 1200);
  const record = manager.get(id);
  return {
    scenario,
    started,
    settled: !outcome.timedOut,
    error_code: outcome.value?.error?.code || outcome.error?.code || null,
    elapsed_ms: prepareSettledAt === null ? null : prepareSettledAt - startedAt,
    follow_up_settled: !followUp.timedOut && Boolean(followUp.value?.value),
    follow_up_state: followUp.value?.value?.state || null,
    process_tree_gone_before_runner_cleanup: processTreeGone,
    pids_observed: pids.length,
    record_state: record?.state || null,
    record_error_code: record?.errorCode || null,
  };
}

async function abortPrepareScenario() {
  const fixture = await makeFixture("abort-prepare");
  const manager = await loadManager(fixture);
  const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  await manager.plan({ id, sourceCwd: fixture.repo });
  const script = await prepareStallScript("abort");
  process.env.WA_STALL_MARKER = markerFile;
  manager.gitTimeoutMs = 5000;
  manager.gitBin = script;
  const controller = new AbortController();
  const startedAt = Date.now();
  const preparePromise = manager.prepare(id, { signal: controller.signal }).then(
    value => ({ value, error: null }),
    error => ({ value: null, error: { code: error?.code || null } }),
  );
  const started = await waitForFile(`${markerFile}.started`, 1200);
  let followUpSettled = false;
  let followUpSettledAt = null;
  const followPromise = manager.bindThread(id, "after-abort").then(
    value => ({ value }),
    error => ({ error: { code: error?.code || null } }),
  ).finally(() => { followUpSettled = true; followUpSettledAt = Date.now(); });
  controller.abort();
  await delay(35);
  const followUpBlockedBeforeGitExit = !followUpSettled && !await fileExists(`${markerFile}.exited`);
  const prepare = await within(preparePromise, 2000);
  const followUp = await within(followPromise, 900);
  const gitExitContent = await readFile(`${markerFile}.exited`, "utf8").catch(() => "");
  const gitExitTime = Number(gitExitContent);
  const record = manager.get(id);
  return {
    scenario,
    started,
    prepare_settled: !prepare.timedOut,
    error_code: prepare.value?.error?.code || prepare.error?.code || null,
    follow_up_blocked_before_git_exit: followUpBlockedBeforeGitExit,
    follow_up_settled: !followUp.timedOut && Boolean(followUp.value?.value),
    git_exit_observed: Number.isFinite(gitExitTime) && gitExitTime > 0,
    git_exit_preceded_follow_up: Number.isFinite(gitExitTime) && followUpSettledAt !== null && gitExitTime <= followUpSettledAt,
    follow_up_elapsed_ms: followUpSettledAt === null ? null : followUpSettledAt - startedAt,
    record_state: record?.state || null,
    record_error_code: record?.errorCode || null,
  };
}

async function main() {
  await mkdir(scratchRoot, { recursive: true });
  let result;
  if (scenario === "admission") result = await admissionScenario();
  else if (scenario === "disabled_plan") result = await disabledPlanScenario();
  else if (scenario === "stalled_git") result = await stalledGitScenario();
  else if (scenario === "abort_prepare") result = await abortPrepareScenario();
  else throw new Error(`Unknown scenario: ${scenario}`);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  process.exit(0);
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ ok: false, scenario, error: { code: error?.code || null, message: String(error?.message || error) } })}\n`);
  process.exit(1);
});

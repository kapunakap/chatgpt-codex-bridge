#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CRITERIA, SCENARIOS, criteriaResult, runBoundedCommand, validateResultShape } from "./grading.mjs";

const benchmarkDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchmarkDir, "../..");
const workerFile = join(benchmarkDir, "worker.mjs");

function parseArgs(argv) {
  const result = { candidate: process.cwd(), label: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--candidate" && argv[index + 1]) result.candidate = argv[++index];
    else if (argv[index] === "--label" && argv[index + 1]) result.label = argv[++index];
    else if (argv[index] === "--help") result.help = true;
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  return result;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function privateEnv(homeDir, tempDir) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: homeDir,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_PROTOCOL_FROM_USER: "0",
  };
}

function parseLastJson(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

async function cleanupTrackedFixtureProcesses(scenarioDir) {
  const markerPath = join(scenarioDir, "git-stall.json");
  let marker;
  try { marker = JSON.parse(await readFile(markerPath, "utf8")); } catch { return; }
  if (!Number.isFinite(marker.started_ms) || Math.abs(Date.now() - marker.started_ms) > 60000) return;
  const pids = [marker.git_pid, marker.child_pid].filter(pid => Number.isInteger(pid) && pid > 1);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") continue; }
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") continue; }
  }
}

async function candidateCommit(candidate, env) {
  const top = await runBoundedCommand("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
    cwd: repoRoot,
    env,
    timeoutMs: 1000,
    maxOutputBytes: 4096,
  });
  if (top.timedOut || top.exitCode !== 0) return null;
  let candidateTop;
  try { candidateTop = await realpath(top.stdout.trim()); } catch { return null; }
  if (candidateTop !== candidate) return null;
  const head = await runBoundedCommand("git", ["-C", candidate, "rev-parse", "HEAD"], {
    cwd: repoRoot,
    env,
    timeoutMs: 1000,
    maxOutputBytes: 4096,
  });
  return !head.timedOut && head.exitCode === 0 ? head.stdout.trim() : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node benchmarks/worktree-admission/grade.mjs --candidate <checkout> [--label <name>]\n");
    return 0;
  }
  const candidateRoot = await realpath(resolve(options.candidate));
  const managerBytes = await readFile(join(candidateRoot, "worktree-manager.mjs"));
  const scratchRoot = await mkdtemp(join(benchmarkDir, ".runtime-"));
  const homeDir = join(scratchRoot, "home");
  const tempDir = join(scratchRoot, "tmp");
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const env = privateEnv(homeDir, tempDir);
  const startedAt = Date.now();
  const candidateHead = await candidateCommit(candidateRoot, env);
  const scenarioData = {};
  const scenarioFailures = {};

  try {
    for (const [scenario, spec] of Object.entries(SCENARIOS)) {
      const scenarioDir = join(scratchRoot, scenario);
      await mkdir(scenarioDir, { recursive: true, mode: 0o700 });
      const scenarioStartedAt = Date.now();
      const result = await runBoundedCommand(process.execPath, [workerFile, scenario, candidateRoot, scenarioDir], {
        cwd: repoRoot,
        env,
        timeoutMs: spec.timeoutMs,
      });
      const durationMs = Date.now() - scenarioStartedAt;
      const parsed = parseLastJson(result.stdout);
      await cleanupTrackedFixtureProcesses(scenarioDir);
      if (!result.timedOut && result.exitCode === 0 && parsed?.ok === true) scenarioData[scenario] = { ...parsed, duration_ms: durationMs };
      else scenarioFailures[scenario] = {
        timed_out: result.timedOut,
        exit_code: result.exitCode,
        exit_signal: result.exitSignal,
        output_too_large: result.outputTooLarge,
        error: result.error,
        stderr: result.stderr.slice(0, 2000),
        worker_result: parsed,
      };
    }

    const admission = scenarioData.admission;
    const stalled = scenarioData.stalled_git;
    const aborted = scenarioData.abort_prepare;
    const direct = scenarioData.disabled_plan;
    const assessments = {
      admission_preemption: {
        scenario: "admission",
        passed: admission?.backlog_records === 225 && admission?.winner === "admission" && admission?.admission_state === "planned",
        duration_ms: admission?.duration_ms,
        evidence: admission || scenarioFailures.admission || {},
      },
      prune_batch_bound: {
        scenario: "admission",
        passed: admission?.snapshot_calls === 4 && admission?.pruned_count === 4,
        duration_ms: admission?.duration_ms,
        evidence: admission ? { backlog_records: admission.backlog_records, snapshot_calls: admission.snapshot_calls, pruned_count: admission.pruned_count } : scenarioFailures.admission || {},
      },
      git_timeout_bound: {
        scenario: "stalled_git",
        passed: stalled?.started === true && stalled?.settled === true && stalled?.error_code === "worktree_git_timeout" &&
          stalled?.elapsed_ms <= 1500 && stalled?.follow_up_settled === true && stalled?.record_state === "failed",
        duration_ms: stalled?.elapsed_ms,
        evidence: stalled || scenarioFailures.stalled_git || {},
      },
      git_process_cleanup: {
        scenario: "stalled_git",
        passed: stalled?.started === true && stalled?.settled === true && stalled?.pids_observed === 2 &&
          stalled?.process_tree_gone_before_runner_cleanup === true && stalled?.follow_up_settled === true && stalled?.record_state === "failed",
        duration_ms: stalled?.elapsed_ms,
        evidence: stalled ? { process_tree_gone_before_runner_cleanup: stalled.process_tree_gone_before_runner_cleanup, pids_observed: stalled.pids_observed, record_state: stalled.record_state } : scenarioFailures.stalled_git || {},
      },
      abort_settling: {
        scenario: "abort_prepare",
        passed: aborted?.started === true && aborted?.prepare_settled === true && aborted?.error_code === "worktree_cancelled" &&
          aborted?.follow_up_blocked_before_git_exit === true && aborted?.follow_up_settled === true &&
          aborted?.git_exit_observed === true && aborted?.git_exit_preceded_follow_up === true &&
          aborted?.record_state === "failed" && aborted?.record_error_code === "worktree_cancelled" && aborted?.follow_up_elapsed_ms <= 1500,
        duration_ms: aborted?.follow_up_elapsed_ms,
        evidence: aborted || scenarioFailures.abort_prepare || {},
      },
      disabled_plan_bypass: {
        scenario: "disabled_plan",
        passed: direct?.resolved_before_release === true && direct?.state === "direct" && direct?.reason === "disabled",
        duration_ms: direct?.duration_ms,
        evidence: direct || scenarioFailures.disabled_plan || {},
      },
    };
    const scored = criteriaResult(assessments);
    const result = {
      schema_version: 1,
      benchmark_id: "chatgpt-codex-bridge.worktree-admission.v1",
      result_kind: "implementation_calibration",
      candidate: {
        label: options.label || basename(candidateRoot),
        commit: candidateHead,
        worktree_manager_sha256: sha256(managerBytes),
      },
      score: scored.score,
      max_score: 100,
      criteria: scored.criteria,
      commands: [
        {
          argv: ["node", "benchmarks/worktree-admission/grade.mjs", "--candidate", "<candidate-checkout>"],
          cwd: "<benchmark-repository-root>",
          timeout_ms: 30000,
        },
        { argv: ["git", "-C", "<candidate-checkout>", "rev-parse", "--show-toplevel"], cwd: "<benchmark-repository-root>", timeout_ms: 1000 },
        { argv: ["git", "-C", "<candidate-checkout>", "rev-parse", "HEAD"], cwd: "<benchmark-repository-root>", timeout_ms: 1000 },
        ...Object.entries(SCENARIOS).map(([scenario, spec]) => ({
          argv: ["node", "benchmarks/worktree-admission/worker.mjs", scenario, "<candidate-checkout>", "<private-scratch>"],
          cwd: "<benchmark-repository-root>",
          timeout_ms: spec.timeoutMs,
        })),
        { argv: ["git", "init", "-q"], cwd: "<fixture-repository>", timeout_ms: 2500 },
        { argv: ["git", "config", "user.name", "Benchmark Fixture"], cwd: "<fixture-repository>", timeout_ms: 2500 },
        { argv: ["git", "config", "user.email", "benchmark-fixture@localhost"], cwd: "<fixture-repository>", timeout_ms: 2500 },
        { argv: ["git", "add", "fixture.txt"], cwd: "<fixture-repository>", timeout_ms: 2500 },
        { argv: ["git", "commit", "-qm", "fixture"], cwd: "<fixture-repository>", timeout_ms: 2500 },
      ],
      runtime: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        total_duration_ms: Date.now() - startedAt,
      },
    };
    if (!validateResultShape(result)) throw new Error("Internal result does not match result.schema.json");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});

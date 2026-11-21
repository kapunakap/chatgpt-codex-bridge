import assert from "node:assert/strict";
import { test } from "node:test";
import { CRITERIA, criteriaResult, isBoundedPrune, runBoundedCommand, validateResultShape } from "./grading.mjs";

test("criterion weights total 100 and scoring is deterministic", () => {
  assert.equal(CRITERIA.reduce((sum, item) => sum + item.weight, 0), 100);
  const allPass = Object.fromEntries(CRITERIA.map(item => [item.id, { passed: true, evidence: { fixture: true } }]));
  const result = criteriaResult(allPass);
  assert.equal(result.score, 100);
  assert.equal(result.criteria.length, 6);
  const onePass = criteriaResult({ admission_preemption: { passed: true, evidence: {} } });
  assert.equal(onePass.score, 25);
  assert.equal(onePass.criteria.find(item => item.id === "prune_batch_bound").earned, 0);
});

test("result-shape validator rejects a score that does not match criterion points", () => {
  const scored = criteriaResult(Object.fromEntries(CRITERIA.map(item => [item.id, { passed: false, evidence: {} }])));
  const result = {
    schema_version: 1,
    benchmark_id: "chatgpt-codex-bridge.worktree-admission.v1",
    result_kind: "implementation_calibration",
    candidate: { label: "fixture", commit: null, worktree_manager_sha256: "a".repeat(64) },
    score: scored.score,
    max_score: 100,
    criteria: scored.criteria,
    commands: [{ argv: ["node", "grade.mjs"], cwd: "<benchmark-root>", timeout_ms: 30000 }],
    runtime: { node: "v22", platform: "test", total_duration_ms: 0 },
  };
  assert.equal(validateResultShape(result), true);
  assert.equal(validateResultShape({ ...result, score: 100 }), false);
});

test("bounded command runner kills a timed-out local process group", async () => {
  const result = await runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    timeoutMs: 100,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.error, null);
  let stillAlive = true;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { process.kill(result.pid, 0); }
    catch (error) { if (error.code === "ESRCH") { stillAlive = false; break; } }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(stillAlive, false, "timed-out child process must be reaped");
});

test("bounded prune accepts equivalent safe batch sizes and rejects no progress or unbounded work", () => {
  for (let n = 1; n <= 4; n++) assert.equal(isBoundedPrune({ backlog_records: 225, snapshot_calls: n, pruned_count: n }), true);
  for (const n of [0, 5, 210]) assert.equal(isBoundedPrune({ backlog_records: 225, snapshot_calls: n, pruned_count: n }), false);
  assert.equal(isBoundedPrune({ backlog_records: 225, snapshot_calls: 3, pruned_count: 2 }), false);
  assert.equal(isBoundedPrune(null), false);
});

#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const [baselinePath, referencePath] = process.argv.slice(2);
if (!baselinePath || !referencePath) {
  process.stderr.write("Usage: node benchmarks/worktree-admission/calibration-check.mjs <baseline-result.json> <reference-result.json>\n");
  process.exit(2);
}

const read = async path => JSON.parse(await readFile(path, "utf8"));
const baseline = await read(baselinePath);
const reference = await read(referencePath);
const targeted = ["admission_preemption", "prune_batch_bound", "git_timeout_bound", "git_process_cleanup", "abort_settling", "disabled_plan_bypass"];
const failed = result => new Set(result.criteria.filter(item => item.passed === false).map(item => item.id));
const baselineFailures = failed(baseline);
const referenceFailures = failed(reference);
const missingBaselineFailures = targeted.filter(id => !baselineFailures.has(id));
const referenceNotPassing = targeted.filter(id => referenceFailures.has(id));

if (baseline.score >= 100 || reference.score !== 100 || missingBaselineFailures.length || referenceNotPassing.length) {
  process.stderr.write(`${JSON.stringify({
    baseline_score: baseline.score,
    reference_score: reference.score,
    missing_baseline_failures: missingBaselineFailures,
    reference_failures: referenceNotPassing,
  }, null, 2)}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({
  calibration: "passed",
  baseline_score: baseline.score,
  reference_score: reference.score,
  targeted_baseline_failures: targeted,
  reference_failures: [],
}, null, 2)}\n`);

import { spawn } from "node:child_process";

export const CRITERIA = Object.freeze([
  { id: "admission_preemption", weight: 25, assertion: "A new enabled plan wins admission before GC starts its second candidate with 225 ready records." },
  { id: "prune_batch_bound", weight: 15, assertion: "One prune pass snapshots exactly four candidates from the 225-record backlog." },
  { id: "git_timeout_bound", weight: 15, assertion: "A stalled Git operation returns worktree_git_timeout within 1,500 ms." },
  { id: "git_process_cleanup", weight: 15, assertion: "The timed-out Git stand-in and its child are gone before prepare settles." },
  { id: "abort_settling", weight: 20, assertion: "Aborting prepare returns cancellation, Git exits, and later serialized work completes only after Git exits and failed state is saved." },
  { id: "disabled_plan_bypass", weight: 10, assertion: "Disabled planning returns a direct workspace before the deliberately blocked serializer is released." },
]);

export const SCENARIOS = Object.freeze({
  admission: { timeoutMs: 8000, ids: ["admission_preemption", "prune_batch_bound"] },
  stalled_git: { timeoutMs: 5000, ids: ["git_timeout_bound", "git_process_cleanup"] },
  abort_prepare: { timeoutMs: 8000, ids: ["abort_settling"] },
  disabled_plan: { timeoutMs: 3000, ids: ["disabled_plan_bypass"] },
});

export function criteriaResult(assessments) {
  const criteria = CRITERIA.map(spec => {
    const assessment = assessments[spec.id] || {};
    const passed = assessment.passed === true;
    return {
      id: spec.id,
      weight: spec.weight,
      earned: passed ? spec.weight : 0,
      passed,
      assertion: spec.assertion,
      timeout_ms: SCENARIOS[assessment.scenario || scenarioFor(spec.id)].timeoutMs,
      duration_ms: Number.isFinite(assessment.duration_ms) ? Math.max(0, Math.round(assessment.duration_ms)) : null,
      evidence: assessment.evidence && typeof assessment.evidence === "object"
        ? assessment.evidence
        : { reason: assessment.reason || "No scenario evidence was produced." },
    };
  });
  return { criteria, score: criteria.reduce((sum, item) => sum + item.earned, 0) };
}

function scenarioFor(id) {
  return Object.entries(SCENARIOS).find(([, value]) => value.ids.includes(id))?.[0] || "admission";
}

export function validateResultShape(result) {
  if (!result || result.schema_version !== 1 || result.benchmark_id !== "chatgpt-codex-bridge.worktree-admission.v1") return false;
  if (!new Set(["implementation_calibration", "model_run"]).has(result.result_kind)) return false;
  if (!result.candidate || typeof result.candidate.label !== "string" ||
      (result.candidate.commit !== null && typeof result.candidate.commit !== "string") ||
      !/^[a-f0-9]{64}$/.test(result.candidate.worktree_manager_sha256 || "")) return false;
  if (!Number.isInteger(result.score) || result.score < 0 || result.score > 100 || result.max_score !== 100) return false;
  if (!Array.isArray(result.criteria) || result.criteria.length !== CRITERIA.length) return false;
  if (result.criteria.reduce((sum, criterion) => sum + criterion.earned, 0) !== result.score) return false;
  if (result.criteria.reduce((sum, criterion) => sum + criterion.weight, 0) !== 100) return false;
  if (!Array.isArray(result.commands) || !result.commands.every(command => Array.isArray(command.argv) && typeof command.cwd === "string" && Number.isInteger(command.timeout_ms) && command.timeout_ms > 0)) return false;
  if (!result.runtime || typeof result.runtime.node !== "string" || typeof result.runtime.platform !== "string" || !Number.isInteger(result.runtime.total_duration_ms)) return false;
  return result.criteria.every((criterion, index) =>
    criterion.id === CRITERIA[index].id && criterion.weight === CRITERIA[index].weight &&
    criterion.earned === (criterion.passed ? criterion.weight : 0) && typeof criterion.passed === "boolean" &&
    Number.isInteger(criterion.timeout_ms) && criterion.timeout_ms > 0 &&
    (criterion.duration_ms === null || Number.isInteger(criterion.duration_ms)) &&
    typeof criterion.evidence === "object");
}

export function runBoundedCommand(command, args, { cwd, env, timeoutMs, maxOutputBytes = 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let outputTooLarge = false;
    let timedOut = false;
    let settled = false;
    let killTimer;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const signalTree = signal => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") {
          try { child.kill(signal); } catch {}
        }
      }
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > maxOutputBytes) {
        outputTooLarge = true;
        signalTree("SIGKILL");
        return current;
      }
      return next;
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => signalTree("SIGKILL"), 200);
    }, timeoutMs);
    deadline.unref();
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    const finish = async (exitCode, exitSignal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      await terminateGroup(child.pid);
      resolve({ command, args, pid: child.pid || null, exitCode, exitSignal, timedOut, outputTooLarge, stdout, stderr, error: error?.message || null });
    };
    child.once("error", error => { void finish(null, null, error); });
    child.once("close", (code, signal) => { void finish(code, signal); });
  });
}

export async function terminateGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const signal = value => {
    try {
      if (process.platform === "win32") process.kill(pid, value);
      else process.kill(-pid, value);
    } catch (error) {
      if (error.code !== "ESRCH") return;
    }
  };
  signal("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 30));
  signal("SIGKILL");
}

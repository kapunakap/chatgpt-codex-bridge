import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const watch = join(root, "bin/local-codex-watch.mjs");

test("watch renders the monitor layout and dominant approval state", async () => {
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
    sessionId: "session-1", cwd: join(temp, "gta-labin"), threadId: "thread-1", status: "held", startedAt: Date.now() - 12000, updatedAt: Date.now(), networkAccess: true,
  }));
  await writeFile(join(guard, "events", "session-1.jsonl"), `${JSON.stringify({ seq: 1, time: new Date().toISOString(), sessionId: "session-1", type: "chatgpt.prompt", data: { text: "Ship the branch" } })}\n`);
  await writeFile(join(guard, "approvals", "approval-1.pending.json"), JSON.stringify({
    approvalId: "approval-1", sessionId: "session-1", networkAccess: true, createdAt: Date.now(), method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", command: ["git", "push", "origin", "feature/guard"], reason: "Publish the completed branch" },
  }));

  const child = spawn(process.execPath, [watch, "--once"], {
    env: { ...process.env, LOCAL_CODEX_JOBS_DIR: jobsDir, LOCAL_CODEX_STATE_FILE: join(temp, "threads.json"), LOCAL_CODEX_TOKEN_FILE: join(temp, "token"), LOCAL_CODEX_PORT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0);
  assert.match(stdout, /LOCAL CODEX GUARD/);
  assert.match(stdout, /APPROVAL REQUIRED/);
  assert.match(stdout, /git push origin feature\/guard/);
  assert.match(stdout, /No action will execute until approved/);
  assert.match(stdout, /JOB INSPECTOR/);
});

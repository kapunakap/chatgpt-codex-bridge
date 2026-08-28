import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const watch = join(root, "bin/local-codex-watch.mjs");

test("watch shows network and host credentials as pending before Codex exists", async () => {
  const temp = await mkdtemp(join(tmpdir(), "local-codex-watch-capability-"));
  const jobsDir = join(temp, "jobs");
  const guard = join(temp, "guard");
  const approvalsDir = join(guard, "approvals");
  for (const dir of [jobsDir, join(guard, "sessions"), join(guard, "events"), approvalsDir]) await mkdir(dir, { recursive: true });
  const jobId = "33333333-3333-3333-3333-333333333333";
  const cwd = join(temp, "chatgpt-codex-bridge");
  await writeFile(join(temp, "token"), "Bearer test\n");
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    jobId, status: "running", cwd, threadId: null, model: null,
    reasoningEffort: null, networkAccess: true, startedAt: Date.now() - 2000, updatedAt: Date.now(),
  }));
  await writeFile(join(approvalsDir, "capability.pending.json"), JSON.stringify({
    approvalId: "capability",
    jobId,
    sessionId: null,
    requestId: `capability:${jobId}`,
    method: "localCodex/capabilityApproval",
    params: {
      capability: "networkAccess",
      reason: "Enable outbound command network access and terminal-like host developer credentials for this Local Codex job.",
      additionalPermissions: { network: { enabled: true } },
      accessChange: {
        networkAccess: { from: false, to: true },
        hostCredentials: { from: "filtered", to: "available" },
      },
    },
    cwd,
    networkAccess: true,
    createdAt: Date.now(),
  }));

  const child = spawn(process.execPath, [watch, "--once"], {
    env: {
      ...process.env,
      LOCAL_CODEX_JOBS_DIR: jobsDir,
      LOCAL_CODEX_STATE_FILE: join(temp, "threads.json"),
      LOCAL_CODEX_TOKEN_FILE: join(temp, "token"),
      LOCAL_CODEX_PORT: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.equal(code, 0);
  assert.match(stdout, /APPROVAL REQUIRED/);
  assert.match(stdout, /Enable network access \+ host developer credentials/);
  assert.match(stdout, /OFF → ON/);
  assert.match(stdout, /FILTERED → AVAILABLE/);
  assert.match(stdout, /NETWORK.*PENDING/s);
  assert.match(stdout, /host auth.*pending host approval/s);
  assert.match(stdout, /No network-enabled Codex process will start until approved/);
  assert.match(stdout, /! HOLD/);
});

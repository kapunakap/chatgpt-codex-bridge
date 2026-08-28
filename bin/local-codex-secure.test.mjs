import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const wrapper = join(repoRoot, "bin/local-codex-secure.mjs");
const fixture = join(repoRoot, "test/fixtures/record-codex-env.mjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function permissionConfig(cwd, networkAccess) {
  const denied = ["/Users", "/System/Volumes/Data/Users", "/Volumes", "/private/tmp", "/tmp", "/private/var/tmp", "/var/tmp", "/private/var/folders", "/var/folders"];
  const inside = path => cwd === "/" || path === cwd || path.startsWith(`${cwd}/`);
  const reads = process.platform === "darwin"
    ? ['":root"="read"', ...denied.filter(path => {
      const canonical = path.replace(/^\/System\/Volumes\/Data(?=\/)/, "").replace(/^\/tmp$/, "/private/tmp").replace(/^\/var(?=\/)/, "/private/var");
      return !inside(path) && !inside(canonical);
    }).map(path => `${JSON.stringify(path)}="deny"`)].join(", ")
    : '":minimal"="read"';
  const workspace = ['"."="write"', '".git"="write"', '".codex"="read"', '".env"="deny"', '".env.*"="deny"',
    '"**/.env"="deny"', '"**/.env.*"="deny"', '"*.env"="deny"', '"**/*.env"="deny"',
    '".npmrc"="deny"', '"**/.npmrc"="deny"', '".pypirc"="deny"', '"**/.pypirc"="deny"'].join(", ");
  return `permissions.local-codex-tunnel={description="Local Codex", workspace_roots={${JSON.stringify(cwd)}=true}, filesystem={${reads}, ":workspace_roots"={${workspace}}}, network={enabled=${networkAccess}}}`;
}

async function runWrapper(t, configs, extraArgs = [], cwd, capabilityDecision = "accept") {
  assert.ok(cwd, "test cwd is required so control state can be placed inside the selected workspace");
  const root = await mkdtemp(join(tmpdir(), "local-codex-secure-"));
  const recordFile = join(root, "record.json");
  const controlDir = join(cwd, ".local-codex-control");
  const jobsDir = join(controlDir, "jobs");
  const approvalsDir = join(controlDir, "guard", "approvals");
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const networkEnabled = configs.some(config => config.includes("network={enabled=true}"));
  const jobId = "11111111-1111-1111-1111-111111111111";
  if (networkEnabled) {
    await writeFile(join(jobsDir, `${jobId}.json`), `${JSON.stringify({
      jobId, cwd, status: "running", updatedAt: Date.now(),
    })}\n`, { mode: 0o600 });
  }
  const args = [wrapper, "app-server", "--listen", "stdio://"];
  for (const config of configs) args.push("-c", config);
  args.push(...extraArgs, "--test-record-file", recordFile);
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      LOCAL_CODEX_STATE_FILE: join(controlDir, "threads.json"),
      LOCAL_CODEX_JOBS_DIR: jobsDir,
      LOCAL_CODEX_LOG_FILE: join(root, "audit.log"),
      LOCAL_CODEX_REAL_BIN: fixture,
      OPENAI_API_KEY: "marker",
      DATABASE_URL: "marker",
      GH_TOKEN: "marker",
      GITHUB_TOKEN: "marker",
      SSH_AUTH_SOCK: "/tmp/marker-socket",
      LOCAL_CODEX_TOKEN_FILE: join(controlDir, "adapter-token"),
      TUNNEL_CLIENT_RUNTIME_API_KEY: "marker",
      TEST_PASSWORD: "marker",
    },
  });
  let pending;
  if (networkEnabled) {
    for (let i = 0; i < 150; i++) {
      try {
        const name = (await readdir(approvalsDir)).find(file => file.endsWith(".pending.json"));
        if (name) {
          pending = JSON.parse(await readFile(join(approvalsDir, name), "utf8"));
          break;
        }
      } catch {}
      await delay(20);
    }
    assert.ok(pending, "network capability approval should appear before real Codex starts");
    await assert.rejects(readFile(recordFile, "utf8"), error => error?.code === "ENOENT");
    assert.equal(pending.jobId, jobId);
    assert.equal(pending.method, "localCodex/capabilityApproval");
    assert.equal((await stat(approvalsDir)).mode & 0o777, 0o700);
    const pendingPath = join(approvalsDir, `${pending.approvalId}.pending.json`);
    assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
    await writeFile(join(approvalsDir, `${pending.approvalId}.decision.json`), `${JSON.stringify({ decision: capabilityDecision })}\n`, { mode: 0o600 });
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let record;
  try { record = JSON.parse(await readFile(recordFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let audit = [];
  try { audit = (await readFile(join(root, "audit.log"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { exitCode, record, controlDir, approvalsDir, pending, audit };
}

test("secure wrapper keeps network-disabled jobs hardened and denies host-authority state", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "local-codex-profile-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const permission = permissionConfig(workspace, false);
  const result = await runWrapper(t, [permission], [], workspace);
  assert.equal(result.exitCode, 0);
  const configs = result.record.args
    .map((value, index) => result.record.args[index - 1] === "-c" ? value : null)
    .filter(Boolean);
  const effectivePermission = configs.find(value => value.startsWith("permissions.local-codex-tunnel="));
  assert.equal(configs.filter(value => value.startsWith("permissions.local-codex-tunnel=")).length, 1);
  assert.notEqual(effectivePermission, permission, "wrapper must add its own control-state deny after validating adapter input");
  assert.match(effectivePermission, /network=\{enabled=false\}/);
  assert.ok(effectivePermission.includes(`${JSON.stringify(result.controlDir)}="deny"`), "control state inside cwd must remain explicitly denied");
  assert.equal(configs.includes('shell_environment_policy.inherit="core"'), true);
  assert.equal(configs.includes("shell_environment_policy.ignore_default_excludes=false"), true);
  assert.ok(configs.some(value => value.includes('"*AUTH*"="exclude"')));

  assert.equal(result.record.env.pathPresent, true);
  assert.equal(result.record.env.homePresent, true);
  assert.equal(result.record.env.openaiApiKeyPresent, false);
  assert.equal(result.record.env.databaseUrlPresent, false);
  assert.equal(result.record.env.ghTokenPresent, false);
  assert.equal(result.record.env.githubTokenPresent, false);
  assert.equal(result.record.env.sshAuthSockPresent, false);
  assert.equal(result.record.env.localTokenFilePresent, false);
  assert.equal(result.record.env.runtimeApiKeyPresent, false);
  assert.equal(result.record.env.passwordPresent, false);
});

test("network-enabled jobs are held before spawn, then receive host auth after approval", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "local-codex-profile-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const permission = permissionConfig(workspace, true);
  const result = await runWrapper(t, [permission], [], workspace, "accept");
  assert.equal(result.exitCode, 0);
  const configs = result.record.args
    .map((value, index) => result.record.args[index - 1] === "-c" ? value : null)
    .filter(Boolean);
  const effectivePermission = configs.find(value => value.startsWith("permissions.local-codex-tunnel="));
  assert.equal(configs.filter(value => value.startsWith("permissions.local-codex-tunnel=")).length, 1);
  assert.match(effectivePermission, /network=\{enabled=true\}/);
  assert.match(effectivePermission, /filesystem=\{":root"="read"/);
  assert.doesNotMatch(effectivePermission, /"\/Users"="deny"/);
  assert.ok(effectivePermission.includes(`${JSON.stringify(result.controlDir)}="deny"`), "trusted host read must carve out Local Codex control state");
  assert.equal(configs.includes('shell_environment_policy.inherit="all"'), true);
  assert.equal(configs.includes("shell_environment_policy.ignore_default_excludes=true"), true);
  assert.ok(configs.some(value => value === 'shell_environment_policy.filters={"LOCAL_CODEX_*"="exclude","TUNNEL_CLIENT_*"="exclude"}'));

  assert.equal(result.record.env.pathPresent, true);
  assert.equal(result.record.env.homePresent, true);
  assert.equal(result.record.env.openaiApiKeyPresent, true);
  assert.equal(result.record.env.databaseUrlPresent, true);
  assert.equal(result.record.env.ghTokenPresent, true);
  assert.equal(result.record.env.githubTokenPresent, true);
  assert.equal(result.record.env.sshAuthSockPresent, true);
  assert.equal(result.record.env.passwordPresent, true);
  assert.equal(result.record.env.localTokenFilePresent, false);
  assert.equal(result.record.env.runtimeApiKeyPresent, false);
  const capabilityAudit = result.audit.filter(entry => entry.component === "local-codex-guard" && entry.capability === "networkAccess");
  assert.deepEqual(capabilityAudit.map(entry => entry.event), ["capability_approval_requested", "capability_approval_resolved"]);
  assert.equal(capabilityAudit.at(-1).decision, "accept");
});

test("rejecting network capability prevents real Codex from starting", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "local-codex-profile-reject-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const result = await runWrapper(t, [permissionConfig(workspace, true)], [], workspace, "decline");
  assert.equal(result.exitCode, 77);
  assert.equal(result.record, undefined);
  const capabilityAudit = result.audit.filter(entry => entry.component === "local-codex-guard" && entry.capability === "networkAccess");
  assert.deepEqual(capabilityAudit.map(entry => entry.event), ["capability_approval_requested", "capability_approval_resolved"]);
  assert.equal(capabilityAudit.at(-1).decision, "decline");
});

test("secure wrapper fails closed on missing, duplicate, malformed, or unsafe permission profiles", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "local-codex-invalid-profile-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const valid = permissionConfig(workspace, false);
  const cases = [
    { configs: [] },
    { configs: [valid, valid] },
    { configs: [valid.replace('".npmrc"="deny",', "")] },
    { configs: [valid.replace("network={enabled=false}", "network={enabled=maybe}")] },
    { configs: [valid], extraArgs: ["--sandbox", "danger-full-access"] },
  ];
  for (const entry of cases) {
    const result = await runWrapper(t, entry.configs, entry.extraArgs, workspace);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.record, undefined);
  }
});

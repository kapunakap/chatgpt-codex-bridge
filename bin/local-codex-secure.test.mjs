import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const wrapper = join(repoRoot, "bin/local-codex-secure.mjs");
const fixture = join(repoRoot, "test/fixtures/record-codex-env.mjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const TEST_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function permissionConfig(cwd, networkAccess, commonGitDir = null) {
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
  const roots = [cwd];
  if (commonGitDir && commonGitDir !== cwd && !commonGitDir.startsWith(`${cwd}/`)) roots.push(commonGitDir);
  return `permissions.local-codex-tunnel={description="Local Codex", workspace_roots={${roots.map(root => `${JSON.stringify(root)}=true`).join(", ")}}, filesystem={${reads}, ":workspace_roots"={${workspace}}}, network={enabled=${networkAccess}}}`;
}

async function runWrapper(t, configs, extraArgs = [], cwd, capabilityDecision = "accept", approvalMode = "off") {
  assert.ok(cwd, "test cwd is required");
  const root = await mkdtemp(join(tmpdir(), "local-codex-secure-"));
  const recordFile = join(root, "record.json");
  const controlDir = join(root, "control");
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
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LOCAL_CODEX_STATE_FILE: join(controlDir, "threads.json"),
      LOCAL_CODEX_JOBS_DIR: jobsDir,
      LOCAL_CODEX_LOG_FILE: join(root, "audit.log"),
      LOCAL_CODEX_REAL_BIN: fixture,
      LOCAL_CODEX_APPROVAL_MODE: approvalMode,
      OPENAI_API_KEY: "marker",
      DATABASE_URL: "marker",
      GH_TOKEN: "marker",
      GITHUB_TOKEN: "marker",
      SSH_AUTH_SOCK: "/tmp/marker-socket",
      LOCAL_CODEX_TOKEN_FILE: join(controlDir, "adapter-token"),
      TUNNEL_CLIENT_RUNTIME_API_KEY: "marker",
      TEST_PASSWORD: "marker",
      GIT_CONFIG_NOSYSTEM: "host-value",
      GIT_CONFIG_GLOBAL: "/host/global-config",
      GIT_CONFIG_SYSTEM: "/host/system-config",
      GIT_TERMINAL_PROMPT: "host-value",
    },
  });
  let childStderr = "";
  child.stderr.on("data", chunk => { childStderr += chunk; });
  let pending;
  if (networkEnabled && approvalMode === "host") {
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
  return { exitCode, record, controlDir, approvalsDir, pending, audit, stderr: childStderr };
}

async function runInteractiveResume(t, { networkAccess, approvalMode = "off", token = "Bearer resume-secret" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-codex-resume-")));
  const workspace = join(root, "workspace");
  const controlDir = join(workspace, ".local-codex-control");
  const tokenFile = join(controlDir, "adapter-token");
  const fakeCodex = join(root, "fake-codex-resume.mjs");
  const recordFile = join(root, "resume-record.json");
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, "Bearer resume-secret\n", { mode: 0o600 });
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    openai: "OPENAI_API_KEY" in process.env,
    gh: "GH_TOKEN" in process.env,
    local: Object.keys(process.env).filter(key => key.startsWith("LOCAL_CODEX_")),
    tunnel: Object.keys(process.env).filter(key => key.startsWith("TUNNEL_CLIENT_")),
  },
}));
`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [wrapper, "resume", "11111111-1111-1111-1111-111111111111"], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LOCAL_CODEX_INTERACTIVE_RESUME: "1",
      LOCAL_CODEX_RESUME_TOKEN: token,
      LOCAL_CODEX_RESUME_NETWORK_ACCESS: String(networkAccess),
      LOCAL_CODEX_APPROVAL_MODE: approvalMode,
      LOCAL_CODEX_STATE_FILE: join(controlDir, "threads.json"),
      LOCAL_CODEX_TOKEN_FILE: tokenFile,
      LOCAL_CODEX_REAL_BIN: fakeCodex,
      OPENAI_API_KEY: "marker",
      GH_TOKEN: "marker",
      TUNNEL_CLIENT_RUNTIME_API_KEY: "marker",
    },
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let record;
  try { record = JSON.parse(await readFile(recordFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let approvalFiles = [];
  try { approvalFiles = await readdir(join(controlDir, "guard", "approvals")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { exitCode, record, controlDir, approvalFiles };
}

test("interactive resume keeps a real TTY path with the original disabled-network boundary", async t => {
  const result = await runInteractiveResume(t, { networkAccess: false });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.record.cwd.endsWith("/workspace"), true);
  assert.deepEqual(result.record.args.slice(0, 2), ["resume", "11111111-1111-1111-1111-111111111111"]);
  assert.ok(result.record.args.includes("--include-non-interactive"));
  assert.equal(result.record.args[result.record.args.indexOf("-a") + 1], "never");
  const configs = result.record.args
    .map((value, index) => result.record.args[index - 1] === "-c" ? value : null)
    .filter(Boolean);
  const permission = configs.find(value => value.startsWith("permissions.local-codex-tunnel="));
  assert.match(permission, /network=\{enabled=false\}/);
  assert.ok(permission.includes(`${JSON.stringify(result.controlDir)}="deny"`));
  assert.ok(configs.includes('sandbox_permissions=["local-codex-tunnel"]'));
  assert.ok(configs.includes("mcp_servers.local_codex_browser.enabled=false"));
  assert.equal(result.record.env.openai, false);
  assert.equal(result.record.env.gh, false);
  assert.deepEqual(result.record.env.local, []);
  assert.deepEqual(result.record.env.tunnel, []);
  assert.deepEqual(result.approvalFiles, []);
});

test("interactive resume preserves network access and uses native CLI approvals in host mode", async t => {
  const result = await runInteractiveResume(t, { networkAccess: true, approvalMode: "host" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.record.args[result.record.args.indexOf("-a") + 1], "untrusted");
  const permission = result.record.args.find(value => value.startsWith("permissions.local-codex-tunnel="));
  assert.match(permission, /network=\{enabled=true\}/);
  assert.ok(permission.includes(`${JSON.stringify(result.controlDir)}="deny"`));
  assert.equal(result.record.env.openai, true);
  assert.equal(result.record.env.gh, true);
  assert.deepEqual(result.record.env.local, []);
  assert.deepEqual(result.approvalFiles, [], "native TUI approvals must not create bridge approval files");
});

test("interactive resume fails closed without the monitor token", async t => {
  const result = await runInteractiveResume(t, { networkAccess: false, token: "wrong" });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.record, undefined);
  assert.deepEqual(result.approvalFiles, []);
});

test("secure wrapper validates and preserves the shared Git metadata root for linked worktrees", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-codex-linked-profile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  await mkdir(repo);
  await runCommand("git", ["-C", repo, "init"]);
  await runCommand("git", ["-C", repo, "config", "user.name", "Test User"]);
  await runCommand("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await writeFile(join(repo, "tracked.txt"), "tracked\n");
  await runCommand("git", ["-C", repo, "add", "."]);
  await runCommand("git", ["-C", repo, "commit", "-m", "initial"]);
  await runCommand("git", ["-C", repo, "worktree", "add", "--detach", worktree, "HEAD"]);
  const commonGitDir = await realpath(join(repo, ".git"));
  const result = await runWrapper(t, [permissionConfig(worktree, false, commonGitDir)], ["--test-git-acceptance"], worktree);
  assert.equal(result.exitCode, 0);
  const permission = result.record.args.find(value => value.startsWith("permissions.local-codex-tunnel="));
  assert.ok(permission.includes(`${JSON.stringify(worktree)}=true`));
  assert.ok(permission.includes(`${JSON.stringify(commonGitDir)}=true`));
  assert.equal(result.record.env.scratchMode, 0o700);
  assert.equal(result.record.env.scratchWritable, true);
  assert.ok(result.record.env.tmpdir.startsWith(`${commonGitDir}/worktrees/`));
  assert.equal(result.record.env.tmp, result.record.env.tmpdir);
  assert.equal(result.record.env.temp, result.record.env.tmpdir);
  assert.equal(result.record.gitAcceptance.revParse.status, 0, result.record.gitAcceptance.revParse.stderr);
  assert.equal(result.record.gitAcceptance.revParse.stdout.trim(), worktree);
  assert.equal(result.record.gitAcceptance.status.status, 0, result.record.gitAcceptance.status.stderr);
  assert.equal(result.record.gitAcceptance.status.stdout, "");
  assert.doesNotMatch(result.record.gitAcceptance.status.stderr, /xcrun_db|\.gitconfig|Operation not permitted/i);
  await assert.rejects(stat(result.record.env.tmpdir), error => error?.code === "ENOENT");
  assert.equal(await runCommand("git", ["-C", worktree, "status", "--short"]), "");
});

test("network-disabled macOS profiles allow workspace ancestors but deny unrelated user paths", {
  skip: process.platform !== "darwin",
}, async t => {
  const workspace = await realpath(await mkdtemp(join(repoRoot, ".local-codex-profile-test-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await runCommand("git", ["-C", workspace, "init"]);
  const commonGitDir = await realpath(join(workspace, ".git"));
  const result = await runWrapper(t, [permissionConfig(workspace, false, commonGitDir)], [], workspace);
  assert.equal(result.exitCode, 0, result.stderr);
  const effective = result.record.args.find(value => value.startsWith("permissions.local-codex-tunnel="));
  assert.doesNotMatch(effective, /"\/Users"="deny"/);
  assert.doesNotMatch(effective, /"\/System\/Volumes\/Data\/Users"="deny"/);
  assert.ok(effective.includes('"/Users/onin/.gitconfig"="deny"'));
  assert.ok(effective.includes(`${JSON.stringify(workspace)}="write"`));
  assert.equal(result.record.env.scratchWritable, true);
  await assert.rejects(stat(result.record.env.tmpdir), error => error?.code === "ENOENT");
});

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
  assert.ok(effectivePermission.includes(`${JSON.stringify(result.controlDir)}="deny"`), "control state must remain explicitly denied");
  assert.equal(configs.includes('shell_environment_policy.inherit="core"'), true);
  assert.equal(configs.includes("shell_environment_policy.ignore_default_excludes=false"), true);
  assert.ok(configs.some(value => value.includes('"*AUTH*"="exclude"')));
  const environmentSet = configs.find(value => value.startsWith("shell_environment_policy.set="));
  assert.ok(environmentSet.includes('"GIT_CONFIG_GLOBAL"="/dev/null"'));
  assert.ok(environmentSet.includes('"GIT_CONFIG_SYSTEM"="/dev/null"'));
  assert.ok(environmentSet.includes('"GIT_CONFIG_NOSYSTEM"="1"'));
  assert.ok(environmentSet.includes('"GIT_TERMINAL_PROMPT"="0"'));

  assert.equal(result.record.env.pathPresent, true);
  assert.equal(result.record.env.homePresent, true);
  assert.equal(result.record.env.openaiApiKeyPresent, false);
  assert.equal(result.record.env.databaseUrlPresent, false);
  assert.equal(result.record.env.ghTokenPresent, false);
  assert.equal(result.record.env.githubTokenPresent, false);
  assert.equal(result.record.env.sshAuthSockPresent, false);
  assert.equal(result.record.env.localTokenFilePresent, false);
  assert.equal(result.record.env.approvalModePresent, false);
  assert.equal(result.record.env.runtimeApiKeyPresent, false);
  assert.equal(result.record.env.passwordPresent, false);
  assert.equal(result.record.env.gitConfigNosystem, "1");
  assert.equal(result.record.env.gitConfigGlobal, "/dev/null");
  assert.equal(result.record.env.gitConfigSystem, "/dev/null");
  assert.equal(result.record.env.gitTerminalPrompt, "0");
  if (process.platform === "darwin") {
    assert.notEqual(result.record.env.path.split(":")[0], "/usr/bin");
    assert.ok(result.record.env.path.split(":")[0].endsWith("/usr/bin"));
    assert.ok(result.record.env.developerDir?.endsWith("/Developer"));
    assert.equal(result.record.env.gitCeilingDirectories, ":/Users");
  }
  assert.equal(result.record.env.scratchMode, 0o700);
  assert.equal(result.record.env.scratchWritable, true);
  assert.ok(result.record.env.tmpdir.startsWith(`${workspace}/.local-codex-tmp-`));
  assert.equal(result.record.env.tmp, result.record.env.tmpdir);
  assert.equal(result.record.env.temp, result.record.env.tmpdir);
  await assert.rejects(stat(result.record.env.tmpdir), error => error?.code === "ENOENT");
});

test("default off mode grants network capability without approval files", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "local-codex-profile-off-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const permission = permissionConfig(workspace, true);
  const result = await runWrapper(t, [permission], [], workspace);
  assert.equal(result.exitCode, 0);
  assert.equal(result.pending, undefined);
  assert.equal(result.record.env.ghTokenPresent, true);
  assert.equal(result.record.env.githubTokenPresent, true);
  assert.equal(result.record.env.sshAuthSockPresent, true);
  assert.equal(result.record.env.approvalModePresent, false);
  assert.equal(result.record.env.gitConfigNosystem, "host-value");
  assert.equal(result.record.env.gitConfigGlobal, "/host/global-config");
  assert.equal(result.record.env.gitConfigSystem, "/host/system-config");
  assert.equal(result.record.env.gitTerminalPrompt, "host-value");
  assert.equal(result.record.env.path, process.env.PATH);
  assert.equal(result.record.env.scratchMode, 0o700);
  assert.equal(result.record.env.scratchWritable, true);
  await assert.rejects(stat(result.record.env.tmpdir), error => error?.code === "ENOENT");
  assert.equal(result.audit.some(entry => entry.capability === "networkAccess"), false);
  let approvalFiles = [];
  try {
    approvalFiles = await readdir(result.approvalsDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert.deepEqual(approvalFiles, []);
});

test("host approval mode holds network-enabled jobs before spawn", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "local-codex-profile-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const permission = permissionConfig(workspace, true);
  const result = await runWrapper(t, [permission], [], workspace, "accept", "host");
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
  const environmentSet = configs.find(value => value.startsWith("shell_environment_policy.set="));
  assert.ok(environmentSet.includes('"TMPDIR"='));
  assert.doesNotMatch(environmentSet, /GIT_CONFIG/);

  assert.equal(result.record.env.pathPresent, true);
  assert.equal(result.record.env.homePresent, true);
  assert.equal(result.record.env.openaiApiKeyPresent, true);
  assert.equal(result.record.env.databaseUrlPresent, true);
  assert.equal(result.record.env.ghTokenPresent, true);
  assert.equal(result.record.env.githubTokenPresent, true);
  assert.equal(result.record.env.sshAuthSockPresent, true);
  assert.equal(result.record.env.passwordPresent, true);
  assert.equal(result.record.env.localTokenFilePresent, false);
  assert.equal(result.record.env.approvalModePresent, false);
  assert.equal(result.record.env.runtimeApiKeyPresent, false);
  assert.equal(result.record.env.gitConfigNosystem, "host-value");
  assert.equal(result.record.env.gitConfigGlobal, "/host/global-config");
  assert.equal(result.record.env.gitConfigSystem, "/host/system-config");
  assert.equal(result.record.env.gitTerminalPrompt, "host-value");
  assert.equal(result.record.env.path, process.env.PATH);
  assert.equal(result.record.env.scratchMode, 0o700);
  assert.equal(result.record.env.scratchWritable, true);
  await assert.rejects(stat(result.record.env.tmpdir), error => error?.code === "ENOENT");
  const capabilityAudit = result.audit.filter(entry => entry.component === "local-codex-guard" && entry.capability === "networkAccess");
  assert.deepEqual(capabilityAudit.map(entry => entry.event), ["capability_approval_requested", "capability_approval_resolved"]);
  assert.equal(capabilityAudit.at(-1).decision, "accept");
});

test("rejecting network capability prevents real Codex from starting", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "local-codex-profile-reject-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const result = await runWrapper(t, [permissionConfig(workspace, true)], [], workspace, "decline", "host");
  assert.equal(result.exitCode, 77);
  assert.equal(result.record, undefined);
  const capabilityAudit = result.audit.filter(entry => entry.component === "local-codex-guard" && entry.capability === "networkAccess");
  assert.deepEqual(capabilityAudit.map(entry => entry.event), ["capability_approval_requested", "capability_approval_resolved"]);
  assert.equal(capabilityAudit.at(-1).decision, "decline");
  assert.equal((await readdir(workspace)).some(name => name.startsWith(".local-codex-tmp-")), false);
});

test("secure wrapper rejects an invalid approval mode before Codex starts", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "local-codex-invalid-approval-mode-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const result = await runWrapper(
    t,
    [permissionConfig(workspace, false)],
    [],
    workspace,
    "accept",
    "sometimes"
  );
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.record, undefined);
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

async function runCommand(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...TEST_GIT_ENV } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  return stdout;
}

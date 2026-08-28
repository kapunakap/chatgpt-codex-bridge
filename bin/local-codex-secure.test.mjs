import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const wrapper = join(repoRoot, "bin/local-codex-secure.mjs");
const fixture = join(repoRoot, "test/fixtures/record-codex-env.mjs");

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

async function runWrapper(t, configs, extraArgs = [], cwd) {
  assert.ok(cwd, "test cwd is required so control state can be placed inside the selected workspace");
  const root = await mkdtemp(join(tmpdir(), "local-codex-secure-"));
  const recordFile = join(root, "record.json");
  const controlDir = join(cwd, ".local-codex-control");
  await mkdir(controlDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = [wrapper, "app-server", "--listen", "stdio://"];
  for (const config of configs) args.push("-c", config);
  args.push(...extraArgs, "--test-record-file", recordFile);
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      LOCAL_CODEX_STATE_FILE: join(controlDir, "threads.json"),
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
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let record;
  try { record = JSON.parse(await readFile(recordFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { exitCode, record, controlDir };
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

test("network-enabled jobs get terminal-like host auth but never Local Codex control state", async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "local-codex-profile-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const permission = permissionConfig(workspace, true);
  const result = await runWrapper(t, [permission], [], workspace);
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

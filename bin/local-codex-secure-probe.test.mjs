import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { probePermissionConfig } from "../browser-probe.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const wrapper = join(root, "bin/local-codex-secure.mjs");
const fixture = join(root, "test/fixtures/record-codex-env.mjs");

async function runProbe({ mode = "browser-status", profileOverride } = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "local-codex-secure-probe-")));
  const controlDir = join(cwd, ".local-codex-control");
  const recordFile = join(cwd, "..", `${cwd.split("/").at(-1)}-record.json`);
  const profile = profileOverride ?? probePermissionConfig(cwd);
  const child = spawn(process.execPath, [
    wrapper,
    "app-server", "--listen", "stdio://", "-c", profile,
    "--test-record-file", recordFile,
  ], {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      LOCAL_CODEX_PROBE_MODE: mode,
      LOCAL_CODEX_STATE_FILE: join(controlDir, "threads.json"),
      LOCAL_CODEX_REAL_BIN: fixture,
      OPENAI_API_KEY: "marker",
      GH_TOKEN: "marker",
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
  try { record = JSON.parse(await readFile(recordFile, "utf8")); } catch {}
  let controlEntries = [];
  try { controlEntries = await readdir(controlDir); } catch {}
  let workspaceEntries = [];
  try { workspaceEntries = await readdir(cwd); } catch {}
  return { exitCode, record, controlDir, controlEntries, workspaceEntries };
}

test("secure wrapper browser probe launches real App Server without Guard state", async () => {
  const result = await runProbe();
  assert.equal(result.exitCode, 0);
  assert.ok(result.record);
  const configs = result.record.args
    .map((value, index) => result.record.args[index - 1] === "-c" ? value : null)
    .filter(Boolean);
  const effective = configs.find(value => value.startsWith("permissions.local-codex-tunnel="));
  assert.match(effective, /Local Codex Browser Probe/);
  assert.match(effective, /network=\{enabled=false\}/);
  assert.match(effective, /"\."="read"/);
  assert.doesNotMatch(effective, /"\."="write"/);
  assert.ok(effective.includes(`${JSON.stringify(result.controlDir)}="deny"`));
  assert.equal(result.record.env.openaiApiKeyPresent, false);
  assert.equal(result.record.env.ghTokenPresent, false);
  assert.equal(result.record.env.localTokenFilePresent, false);
  assert.equal(result.record.env.runtimeApiKeyPresent, false);
  assert.equal(result.record.env.passwordPresent, false);
  assert.equal(result.controlEntries.includes("guard"), false, "probe mode must not create Guard sessions or approvals");
  assert.deepEqual(result.workspaceEntries, [], "probe mode must not create private scratch state in the workspace");
  assert.equal(configs.some(value => value.startsWith("shell_environment_policy.set=")), false);
});

test("secure wrapper rejects unknown probe modes and writable probe profiles", async () => {
  assert.notEqual((await runProbe({ mode: "unknown" })).exitCode, 0);
  const badCwd = await realpath(await mkdtemp(join(tmpdir(), "local-codex-bad-probe-profile-")));
  const bad = probePermissionConfig(badCwd).replace('"."="read"', '"."="write"');
  // Use the matching cwd by invoking a separate wrapper directly.
  const controlDir = join(badCwd, ".local-codex-control");
  const child = spawn(process.execPath, [wrapper, "app-server", "--listen", "stdio://", "-c", bad], {
    cwd: badCwd,
    stdio: "ignore",
    env: {
      ...process.env,
      LOCAL_CODEX_PROBE_MODE: "browser-status",
      LOCAL_CODEX_STATE_FILE: join(controlDir, "threads.json"),
      LOCAL_CODEX_REAL_BIN: fixture,
    },
  });
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.notEqual(exitCode, 0);
});

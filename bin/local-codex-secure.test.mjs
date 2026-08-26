import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const wrapper = join(repoRoot, "bin/local-codex-secure.mjs");
const fixture = join(repoRoot, "test/fixtures/record-codex-env.mjs");

test("secure wrapper replaces permissions and strips ambient credentials", async t => {
  const root = await mkdtemp(join(tmpdir(), "local-codex-secure-"));
  const recordFile = join(root, "record.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  const originalPermission = `permissions.local-codex-tunnel={description="old",workspace_roots={${JSON.stringify(root)}=true},filesystem={":workspace_roots"={"."="write"}},network={enabled=false}}`;
  const child = spawn(process.execPath, [
    wrapper,
    "app-server", "--listen", "stdio://",
    "-c", originalPermission,
    "--test-record-file", recordFile,
  ], {
    cwd: repoRoot,
    stdio: "ignore",
    env: {
      ...process.env,
      LOCAL_CODEX_ROOT: root,
      LOCAL_CODEX_REAL_BIN: fixture,
      OPENAI_API_KEY: "SHOULD_NOT_PASS",
      DATABASE_URL: "postgres://user:password@example.invalid/db",
      LOCAL_CODEX_TOKEN_FILE: "/tmp/SHOULD_NOT_PASS",
      TUNNEL_CLIENT_RUNTIME_API_KEY: "SHOULD_NOT_PASS",
      TEST_PASSWORD: "SHOULD_NOT_PASS",
    },
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0);

  const record = JSON.parse(await readFile(recordFile, "utf8"));
  const configs = record.args
    .map((value, index) => record.args[index - 1] === "-c" ? value : null)
    .filter(Boolean);
  const permission = configs.find(value => value.startsWith("permissions.local-codex-tunnel="));
  assert.ok(permission);
  assert.match(permission, /extends=":workspace"/);
  assert.match(permission, /"\.env"="deny"/);
  assert.match(permission, /"\*\*\/\.env\.\*"="deny"/);
  assert.match(permission, /"\.npmrc"="deny"/);
  assert.match(permission, /network=\{enabled=false\}/);
  assert.equal(configs.includes('shell_environment_policy.inherit="core"'), true);
  assert.equal(configs.includes("shell_environment_policy.ignore_default_excludes=false"), true);
  assert.ok(configs.some(value => value.startsWith("shell_environment_policy.filters=")));

  assert.equal(record.env.pathPresent, true);
  assert.equal(record.env.homePresent, true);
  assert.equal(record.env.openaiApiKeyPresent, false);
  assert.equal(record.env.databaseUrlPresent, false);
  assert.equal(record.env.localTokenFilePresent, false);
  assert.equal(record.env.runtimeApiKeyPresent, false);
  assert.equal(record.env.passwordPresent, false);
});

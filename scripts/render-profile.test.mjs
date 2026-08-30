import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("renders a tunnel-client profile with file-backed secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-codex-profile-test-"));
  const output = join(root, "local-codex.yaml");
  const runtimeKey = join(root, "runtime key");
  const token = join(root, "adapter token");
  const health = join(root, "health.url");
  const log = join(root, "tunnel.log");

  await run([
    "scripts/render-profile.mjs",
    output,
    "tunnel_example",
    runtimeKey,
    token,
    health,
    log,
    "8765",
  ]);

  const profile = JSON.parse(await readFile(output, "utf8"));
  assert.equal(profile.control_plane.tunnel_id, "tunnel_example");
  assert.equal(profile.control_plane.api_key, `file:${runtimeKey}`);
  assert.equal(profile.mcp.extra_headers.Authorization, `file:${token}`);
  assert.equal(profile.mcp.server_urls[0].url, "http://127.0.0.1:8765/mcp");
  assert.equal(profile.health.url_file, health);
  assert.equal(profile.log.file, log);
});

test("fresh installation dry run does not require a fixed root", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-codex-install-test-"));
  const key = join(directory, "unused-test-key");
  await writeFile(key, "not-a-real-key", { mode: 0o600 });
  const output = await run(["scripts/install.sh", "--tunnel-id", "tunnel_example", "--runtime-api-key-file", key, "--dry-run"], "/bin/zsh");
  assert.match(output, /DRY_RUN_OK/);
  assert.match(output, /scope=per_job/);
  assert.match(output, /approval_mode=off/);
  assert.match(output, /legacy_root=\n/);
  assert.match(output, /codex_wrapper=.*local-codex-tunnel\/codex-secure\.mjs/);
  assert.match(output, /watch_renderer=.*local-codex-tunnel\/local-codex-watch-render\.mjs/);
});

test("legacy installation dry run retains the migration root and secure wrapper", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-codex-legacy-install-test-"));
  const key = join(directory, "unused-test-key");
  await writeFile(key, "not-a-real-key", { mode: 0o600 });
  const output = await run(["scripts/install.sh", "--root", directory, "--tunnel-id", "tunnel_example", "--runtime-api-key-file", key, "--dry-run"], "/bin/zsh");
  const canonicalDirectory = await realpath(directory);
  assert.match(output, /DRY_RUN_OK/);
  assert.match(output, new RegExp(`legacy_root=${canonicalDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(output, /codex_wrapper=.*local-codex-tunnel\/codex-secure\.mjs/);
});

test("approval mode defaults to off in launcher, installer, and example config", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const launcher = await readFile(join(root, "bin/local-codex-tunnel"), "utf8");
  const watchLauncher = await readFile(join(root, "bin/local-codex-watch"), "utf8");
  const installer = await readFile(join(root, "scripts/install.sh"), "utf8");
  const example = await readFile(join(root, "examples/config.env.example"), "utf8");
  assert.match(launcher, /LOCAL_CODEX_APPROVAL_MODE=.*:-off/);
  assert.match(watchLauncher, /LOCAL_CODEX_APPROVAL_MODE=.*:-off/);
  assert.match(watchLauncher, /LOCAL_CODEX_BIN=.*:-codex/);
  assert.match(watchLauncher, /LOCAL_CODEX_REAL_BIN=.*:-codex/);
  assert.match(installer, /LOCAL_CODEX_APPROVAL_MODE=%q/);
  assert.match(example, /^LOCAL_CODEX_APPROVAL_MODE=off$/m);
  assert.match(installer, /LOCAL_CODEX_MAX_CONCURRENCY=%q\\n' "10"/);
  assert.match(example, /^LOCAL_CODEX_MAX_CONCURRENCY=10$/m);
});

function run(args, executable = process.execPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`renderer exited with ${code}: ${stderr}`));
    });
  });
}

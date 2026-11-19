import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const helper = join(root, "bin/local-codex-runtime.zsh");

test("Node resolver skips a broken PATH node and selects healthy versioned Node 24", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-codex-node-test-"));
  const pathBin = join(directory, "path-bin");
  const versionedNode = join(directory, "homebrew/opt/node@24/bin/node");
  const brokenNode = join(pathBin, "node");
  await mkdir(pathBin);
  await mkdir(join(directory, "homebrew/opt/node@24/bin"), { recursive: true });
  await writeFile(brokenNode, "#!/bin/sh\necho 'missing libsimdjson.dylib' >&2\nexit 127\n");
  await writeFile(versionedNode, "#!/bin/sh\n[ \"$1\" = -p ] && { echo 24; exit 0; }\nexit 0\n");
  await chmod(brokenNode, 0o755);
  await chmod(versionedNode, 0o755);

  const result = await runZsh("source \"$1\"; local_codex_resolve_node", [helper], {
    PATH: pathBin,
    HOMEBREW_PREFIX: join(directory, "homebrew"),
  });
  assert.equal(result.stdout.trim(), versionedNode);
  assert.doesNotMatch(result.stderr, /simdjson/);
});

test("adapter startup polling survives readiness taking longer than five seconds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-codex-ready-test-"));
  const counter = join(directory, "count");
  const curl = join(directory, "curl");
  const sleep = join(directory, "sleep");
  await writeFile(counter, "0");
  await writeFile(curl, `#!/bin/sh\ncount=$(cat '${counter}')\ncount=$((count + 1))\nprintf '%s' "$count" > '${counter}'\n[ "$count" -ge 75 ]\n`);
  await writeFile(sleep, "#!/bin/sh\nexit 0\n");
  await chmod(curl, 0o755);
  await chmod(sleep, 0o755);

  const result = await runZsh(
    'source "$1"; local_codex_wait_for_ready http://127.0.0.1:8766/readyz 600 "Local Codex adapter" "$$" "$2" "$3"',
    [helper, curl, sleep],
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(await readFile(counter, "utf8"), "75");
  assert.equal(await runZsh('source "$1"; local_codex_timeout_attempts 60000', [helper]).then(value => value.stdout.trim()), "600");
  assert.notEqual((await runZsh('source "$1"; local_codex_timeout_attempts 120001', [helper], {}, { allowFailure: true })).exitCode, 0);
});

test("installer persists selected Node and the adapter timeout; launcher uses bounded polling", async () => {
  const installer = await readFile(join(root, "scripts/install.sh"), "utf8");
  const launcher = await readFile(join(root, "bin/local-codex-tunnel"), "utf8");
  assert.match(installer, /LOCAL_CODEX_NODE_BIN=%q\\n' "\$\{RESOLVED_NODE_BIN\}"/);
  assert.match(installer, /LOCAL_CODEX_ADAPTER_STARTUP_TIMEOUT_MS=%q\\n' "60000"/);
  assert.match(installer, /local-codex-runtime\.zsh/);
  assert.match(launcher, /local_codex_resolve_node/);
  assert.match(launcher, /local_codex_wait_for_ready.*ADAPTER_URL/);
  assert.match(launcher, /for _ in \{1\.\.50\}/);
});

function runZsh(script, args = [], env = {}, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-c", script, "local-codex-runtime-test", ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", exitCode => {
      const result = { exitCode, stdout, stderr };
      if (!allowFailure && exitCode !== 0) reject(new Error(`zsh exited ${exitCode}: ${stderr}${stdout}`));
      else resolve(result);
    });
  });
}

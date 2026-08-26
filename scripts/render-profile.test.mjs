import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
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

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`renderer exited with ${code}: ${stderr}`));
    });
  });
}

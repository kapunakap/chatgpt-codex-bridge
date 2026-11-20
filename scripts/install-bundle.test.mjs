import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("installer deploys startup diagnostics alongside every importing runtime module", async () => {
  const installer = await readFile(join(repoRoot, "scripts/install.sh"), "utf8");
  assert.match(installer, /readonly STARTUP_DIAGNOSTICS_PATH="\$\{LIBEXEC_DIR\}\/startup-diagnostics\.mjs"/);
  assert.match(installer, /install -m 644 "\$\{SOURCE_ROOT\}\/startup-diagnostics\.mjs" "\$\{STARTUP_DIAGNOSTICS_PATH\}"/);
  for (const entry of ["adapter.mjs", "browser-probe.mjs", "bin/local-codex-instrumented.mjs"]) {
    const content = await readFile(join(repoRoot, entry), "utf8");
    assert.match(content, /startup-diagnostics\.mjs/, `${entry} must import the bundled startup diagnostics`);
  }
});

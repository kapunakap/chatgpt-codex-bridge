import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { probeBrowserBackend, probePermissionConfig } from "./browser-probe.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(root, "test/fixtures/browser-probe-app-server.mjs");

async function runCase(mode) {
  const cwd = await mkdtemp(join(tmpdir(), `local-codex-browser-probe-${mode}-`));
  await writeFile(join(cwd, "probe-case.json"), `${JSON.stringify({ mode })}\n`);
  const launcher = join(cwd, "probe-codex");
  await writeFile(launcher, `#!/usr/bin/env node\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  return probeBrowserBackend({ cwd, codexBin: launcher, adapterVersion: "test", signal: undefined });
}

test("browser probe reports an enabled bundled official backend", async () => {
  const result = await runCase("available");
  assert.equal(result.status, "ok");
  assert.equal(result.officialBrowserBackend, "available");
  assert.equal(result.managedPolicy.allowBrowserAndComputerUse, true);
  assert.equal(result.managedPolicy.browserUse, true);
  assert.equal(result.managedPolicy.browserUseFullCdpAccess, true);
  assert.deepEqual(result.bundledPlugins.map(plugin => plugin.id), ["browser@openai-bundled"]);
  assert.equal(result.bundledPlugins[0].bundled, true);
  assert.deepEqual(result.probeSupport, {
    configRequirements: "ok", pluginInstalled: "ok", mcpServerStatus: "ok", browserRuntimeSetup: "ok",
  });
});

test("browser probe respects managed policy blocks before plugin state", async () => {
  const result = await runCase("policy-blocked");
  assert.equal(result.officialBrowserBackend, "policy_blocked");
  assert.equal(result.managedPolicy.allowBrowserAndComputerUse, false);
  assert.equal(result.managedPolicy.browserUse, false);
});

test("browser probe distinguishes disabled bundled plugins from unknown older App Servers", async () => {
  assert.equal((await runCase("plugin-disabled")).officialBrowserBackend, "plugin_disabled");
  const unsupported = await runCase("unsupported");
  assert.equal(unsupported.officialBrowserBackend, "unknown");
  assert.deepEqual(unsupported.probeSupport, {
    configRequirements: "unsupported", pluginInstalled: "unsupported",
    mcpServerStatus: "unsupported", browserRuntimeSetup: "unsupported",
  });
});

test("browser probe requires the trusted transport and successful runtime setup", async () => {
  const missing = await runCase("transport-missing");
  assert.equal(missing.officialBrowserBackend, "unknown");
  assert.equal(missing.probeSupport.mcpServerStatus, "ok");
  assert.equal(missing.probeSupport.browserRuntimeSetup, "unsupported");
  assert.match(missing.message, /node_repl/i);

  const failed = await runCase("runtime-error");
  assert.equal(failed.officialBrowserBackend, "unknown");
  assert.equal(failed.probeSupport.browserRuntimeSetup, "error");
});

test("browser probe permission profile is read-only and network-disabled", async () => {
  const cwd = "/tmp/local-codex-probe-workspace";
  const profile = probePermissionConfig(cwd);
  assert.match(profile, /network=\{enabled=false\}/);
  assert.match(profile, /"\."="read"/);
  assert.match(profile, /"\.git"="read"/);
  assert.doesNotMatch(profile, /"\."="write"/);
  assert.match(profile, /"\.env"="deny"/);
});

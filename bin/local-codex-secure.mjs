#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

const rootInput = process.env.LOCAL_CODEX_ROOT;
if (!rootInput) {
  throw new Error("LOCAL_CODEX_ROOT is required");
}

const ROOT = realpathSync(rootInput);
const REAL_CODEX_BIN = process.env.LOCAL_CODEX_REAL_BIN || "codex";
const rootToml = JSON.stringify(ROOT);

// Extend Codex's built-in workspace profile so its protected-path defaults
// remain in force, then deny common credential files inside the workspace.
const PERMISSION_CONFIG = `permissions.local-codex-tunnel={description="Local Codex",extends=":workspace",workspace_roots={${rootToml}=true},filesystem={":workspace_roots"={".env"="deny",".env.*"="deny","**/.env"="deny","**/.env.*"="deny","*.env"="deny","**/*.env"="deny",".npmrc"="deny","**/.npmrc"="deny",".pypirc"="deny","**/.pypirc"="deny"}},network={enabled=false}}`;

// Commands launched by Codex inherit only the core environment. Codex's
// automatic KEY/SECRET/TOKEN filtering is explicitly enabled, with extra
// exclusions for other common credential-bearing variable names.
const SHELL_ENV_CONFIGS = [
  'shell_environment_policy.inherit="core"',
  "shell_environment_policy.ignore_default_excludes=false",
  'shell_environment_policy.filters={"*PASSWORD*"="exclude","*PASS*"="exclude","*AUTH*"="exclude","*CREDENTIAL*"="exclude","*COOKIE*"="exclude","*SESSION*"="exclude","LOCAL_CODEX_*"="exclude","TUNNEL_CLIENT_*"="exclude"}',
];

const args = process.argv.slice(2);
let replacedPermissionConfig = false;
for (let index = 0; index < args.length - 1; index++) {
  if (args[index] === "-c" && args[index + 1].startsWith("permissions.local-codex-tunnel=")) {
    args[index + 1] = PERMISSION_CONFIG;
    replacedPermissionConfig = true;
  }
}
if (!replacedPermissionConfig) {
  args.push("-c", PERMISSION_CONFIG);
}
for (const config of SHELL_ENV_CONFIGS) {
  args.push("-c", config);
}

// The app-server itself receives a small allowlist instead of the launcher's
// complete environment. Authentication is expected to come from `codex login`
// and Codex state under HOME/CODEX_HOME, not ambient API-key variables.
const ALLOWED_ENV = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "COLORTERM", "NO_COLOR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);
const childEnv = {};
for (const key of ALLOWED_ENV) {
  if (process.env[key] !== undefined) childEnv[key] = process.env[key];
}

// Test fixtures are JavaScript files checked into this repository and are not
// executable through GitHub's contents API, so run an explicit .mjs override
// with Node. Production uses the real `codex` executable directly.
const command = REAL_CODEX_BIN.endsWith(".mjs") ? process.execPath : REAL_CODEX_BIN;
const commandArgs = REAL_CODEX_BIN.endsWith(".mjs") ? [REAL_CODEX_BIN, ...args] : args;
const child = spawn(command, commandArgs, {
  stdio: "inherit",
  env: childEnv,
});

let terminating = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (terminating) return;
    terminating = true;
    child.kill(signal);
  });
}

child.on("error", error => {
  process.stderr.write(`Unable to start Codex: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

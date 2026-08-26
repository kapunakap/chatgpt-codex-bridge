#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

const REAL_CODEX_BIN = process.env.LOCAL_CODEX_REAL_BIN || "codex";

// Keep this generator byte-for-byte aligned with adapter.mjs. The wrapper
// recomputes the expected profile from its canonical working directory so a
// malformed or weakened profile never reaches Codex.
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

// Commands launched by Codex inherit only the core environment. Codex's
// automatic KEY/SECRET/TOKEN filtering is explicitly enabled, with extra
// exclusions for other common credential-bearing variable names.
const SHELL_ENV_CONFIGS = [
  'shell_environment_policy.inherit="core"',
  "shell_environment_policy.ignore_default_excludes=false",
  'shell_environment_policy.filters={"*PASSWORD*"="exclude","*PASS*"="exclude","*AUTH*"="exclude","*CREDENTIAL*"="exclude","*COOKIE*"="exclude","*SESSION*"="exclude","LOCAL_CODEX_*"="exclude","TUNNEL_CLIENT_*"="exclude"}',
];

const args = process.argv.slice(2);
const permissionIndexes = [];
for (let index = 0; index < args.length - 1; index++) {
  if (args[index] === "-c" && args[index + 1].startsWith("permissions.local-codex-tunnel=")) {
    permissionIndexes.push(index + 1);
  }
}
if (permissionIndexes.length !== 1) {
  throw new Error("Exactly one Local Codex permission profile is required");
}
const permission = args[permissionIndexes[0]];
const networkMatches = permission.match(/network=\{enabled=(true|false)\}/g) || [];
if (networkMatches.length !== 1) {
  throw new Error("Local Codex permission profile must select exactly one network state");
}
const networkAccess = networkMatches[0].includes("true");
if (permission !== permissionConfig(realpathSync(process.cwd()), networkAccess)) {
  throw new Error("Local Codex permission profile does not match the hardened workspace policy");
}
if (args.includes("--sandbox") || args.some(value => value.includes("sandbox_mode") || value.includes(":danger-full-access") || value.includes("dangerously_allow"))) {
  throw new Error("Unsafe Codex sandbox configuration is not allowed");
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

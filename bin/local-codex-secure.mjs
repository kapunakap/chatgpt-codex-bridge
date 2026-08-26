#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

const REAL_CODEX_BIN = process.env.LOCAL_CODEX_REAL_BIN || "codex";

// The adapter always sends the hardened profile. The wrapper validates that
// exact profile first, then network-enabled jobs deliberately widen read/env
// access to match the user's normal local developer session. Writes remain
// restricted to the selected workspace. Network-disabled jobs keep the
// hardened profile unchanged.
function permissionConfig(cwd, networkAccess, trustedHostAccess = false) {
  const denied = ["/Users", "/System/Volumes/Data/Users", "/Volumes", "/private/tmp", "/tmp", "/private/var/tmp", "/var/tmp", "/private/var/folders", "/var/folders"];
  const inside = path => cwd === "/" || path === cwd || path.startsWith(`${cwd}/`);
  const reads = process.platform === "darwin"
    ? (trustedHostAccess
      ? '":root"="read"'
      : ['":root"="read"', ...denied.filter(path => {
        const canonical = path.replace(/^\/System\/Volumes\/Data(?=\/)/, "").replace(/^\/tmp$/, "/private/tmp").replace(/^\/var(?=\/)/, "/private/var");
        return !inside(path) && !inside(canonical);
      }).map(path => `${JSON.stringify(path)}="deny"`)].join(", "))
    : (trustedHostAccess ? '":root"="read"' : '":minimal"="read"');
  const workspace = ['"."="write"', '".git"="write"', '".codex"="read"', '".env"="deny"', '".env.*"="deny"',
    '"**/.env"="deny"', '"**/.env.*"="deny"', '"*.env"="deny"', '"**/*.env"="deny"',
    '".npmrc"="deny"', '"**/.npmrc"="deny"', '".pypirc"="deny"', '"**/.pypirc"="deny"'].join(", ");
  return `permissions.local-codex-tunnel={description="Local Codex", workspace_roots={${JSON.stringify(cwd)}=true}, filesystem={${reads}, ":workspace_roots"={${workspace}}}, network={enabled=${networkAccess}}}`;
}

const HARDENED_SHELL_ENV_CONFIGS = [
  'shell_environment_policy.inherit="core"',
  "shell_environment_policy.ignore_default_excludes=false",
  'shell_environment_policy.filters={"*PASSWORD*"="exclude","*PASS*"="exclude","*AUTH*"="exclude","*CREDENTIAL*"="exclude","*COOKIE*"="exclude","*SESSION*"="exclude","LOCAL_CODEX_*"="exclude","TUNNEL_CLIENT_*"="exclude"}',
];

// networkAccess=true is intentionally terminal-like: ordinary developer auth
// such as gh config/Keychain, GH_TOKEN/GITHUB_TOKEN, and SSH_AUTH_SOCK may be
// used by commands. Keep only the tunnel's own control-plane/runtime variables
// out of the Codex process so a coding task cannot impersonate the bridge.
const TRUSTED_SHELL_ENV_CONFIGS = [
  'shell_environment_policy.inherit="all"',
  "shell_environment_policy.ignore_default_excludes=true",
  'shell_environment_policy.filters={"LOCAL_CODEX_*"="exclude","TUNNEL_CLIENT_*"="exclude"}',
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
const permissionIndex = permissionIndexes[0];
const permission = args[permissionIndex];
const networkMatches = permission.match(/network=\{enabled=(true|false)\}/g) || [];
if (networkMatches.length !== 1) {
  throw new Error("Local Codex permission profile must select exactly one network state");
}
const networkAccess = networkMatches[0].includes("true");
const cwd = realpathSync(process.cwd());
if (permission !== permissionConfig(cwd, networkAccess)) {
  throw new Error("Local Codex permission profile does not match the hardened workspace policy");
}
if (args.includes("--sandbox") || args.some(value => value.includes("sandbox_mode") || value.includes(":danger-full-access") || value.includes("dangerously_allow"))) {
  throw new Error("Unsafe Codex sandbox configuration is not allowed");
}

if (networkAccess) {
  args[permissionIndex] = permissionConfig(cwd, true, true);
  for (const config of TRUSTED_SHELL_ENV_CONFIGS) args.push("-c", config);
} else {
  for (const config of HARDENED_SHELL_ENV_CONFIGS) args.push("-c", config);
}

let childEnv;
if (networkAccess) {
  childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("LOCAL_CODEX_") || key.startsWith("TUNNEL_CLIENT_")) delete childEnv[key];
  }
} else {
  // The hardened app-server receives a small allowlist instead of the
  // launcher's complete environment. Authentication for Codex itself comes
  // from Codex state under HOME/CODEX_HOME, not ambient API-key variables.
  const ALLOWED_ENV = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL",
    "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "LC_CTYPE",
    "TERM", "COLORTERM", "NO_COLOR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ]);
  childEnv = {};
  for (const key of ALLOWED_ENV) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
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

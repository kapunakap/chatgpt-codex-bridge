#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const REAL_CODEX_BIN = process.env.LOCAL_CODEX_REAL_BIN || "codex";
const STATE_FILE = process.env.LOCAL_CODEX_STATE_FILE ||
  resolve(homedir(), "Library/Application Support/local-codex-tunnel/threads.json");
const LOG_FILE = process.env.LOCAL_CODEX_LOG_FILE ||
  resolve(homedir(), "Library/Application Support/tunnel-client/logs/local-codex.log");
const CONTROL_DIR = resolve(dirname(STATE_FILE));
const JOBS_DIR = resolve(CONTROL_DIR, "jobs");
const GUARD_DIR = resolve(CONTROL_DIR, "guard");
const APPROVALS_DIR = resolve(GUARD_DIR, "approvals");
const GUARD_PROXY = fileURLToPath(new URL("./local-codex-guard-proxy.mjs", import.meta.url));

// The adapter always sends the hardened profile. The wrapper validates that
// exact profile first, then adds an unconditional deny for Local Codex's own
// control state before the real Codex process starts. That deny protects the
// adapter token, thread/job state, Guard approvals/decisions, and event files
// even when the selected workspace is an ancestor such as the user's home.
// Network-enabled jobs still deliberately widen ordinary host read/env access
// to match the user's terminal, but never to this host-authority directory.
function permissionConfig(cwd, networkAccess, trustedHostAccess = false, protectedControlDir = null) {
  const denied = ["/Users", "/System/Volumes/Data/Users", "/Volumes", "/private/tmp", "/tmp", "/private/var/tmp", "/var/tmp", "/private/var/folders", "/var/folders"];
  const inside = path => cwd === "/" || path === cwd || path.startsWith(`${cwd}/`);
  let readRules;
  if (process.platform === "darwin") {
    readRules = trustedHostAccess
      ? ['":root"="read"']
      : ['":root"="read"', ...denied.filter(path => {
        const canonical = path.replace(/^\/System\/Volumes\/Data(?=\/)/, "").replace(/^\/tmp$/, "/private/tmp").replace(/^\/var(?=\/)/, "/private/var");
        return !inside(path) && !inside(canonical);
      }).map(path => `${JSON.stringify(path)}="deny"`)];
  } else {
    readRules = [trustedHostAccess ? '":root"="read"' : '":minimal"="read"'];
  }
  if (protectedControlDir) readRules.push(`${JSON.stringify(protectedControlDir)}="deny"`);
  const reads = readRules.join(", ");
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

// networkAccess=true is intentionally terminal-like after the host explicitly
// approves that capability: ordinary developer auth such as gh config/Keychain,
// GH_TOKEN/GITHUB_TOKEN, and SSH_AUTH_SOCK may then be used by commands. Keep
// the tunnel's own variables out of the Codex process and keep CONTROL_DIR
// denied at the filesystem layer.
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
// Validate only the adapter-owned input profile. The wrapper-owned CONTROL_DIR
// deny and host capability gate are applied after this exact validation and
// cannot be supplied, removed, or redirected by the caller.
if (permission !== permissionConfig(cwd, networkAccess)) {
  throw new Error("Local Codex permission profile does not match the hardened workspace policy");
}
if (args.includes("--sandbox") || args.some(value => value.includes("sandbox_mode") || value.includes(":danger-full-access") || value.includes("dangerously_allow"))) {
  throw new Error("Unsafe Codex sandbox configuration is not allowed");
}

// Always replace the validated input profile with the effective profile that
// denies host-authority state. This also prevents a broad cwd such as HOME from
// turning Guard decision files into workspace-writable files.
args[permissionIndex] = permissionConfig(cwd, networkAccess, networkAccess, CONTROL_DIR);
if (networkAccess) {
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

let child;
let terminating = false;
let activeCapabilityApproval = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (terminating) return;
    terminating = true;
    if (activeCapabilityApproval) {
      activeCapabilityApproval.cancel();
      return;
    }
    child?.kill(signal);
  });
}

// The network-enabled profile exposes ordinary developer credentials to the
// eventual Codex process, so the capability itself must be host-approved before
// that process exists. The pending decision lives in CONTROL_DIR, which the
// eventual sandbox explicitly denies, preventing self-approval.
let sequenceOffset = 0;
if (networkAccess) {
  const decision = await waitForNetworkCapabilityApproval();
  sequenceOffset = 2; // approval.requested + approval.resolved precede proxy events.
  if (decision !== "accept" && decision !== "acceptForSession") {
    process.exitCode = decision === "cancel" ? 130 : 77;
  }
}

if (!process.exitCode) {
  // The guard proxy is deliberately below the wrapper and above the real Codex
  // app-server. It forces native Codex approval policy and holds command/file
  // approval requests. The TUI is only a controller/view; enforcement continues
  // if the TUI disconnects.
  child = spawn(process.execPath, [
    GUARD_PROXY,
    "--real-bin", REAL_CODEX_BIN,
    "--guard-dir", GUARD_DIR,
    "--network-access", String(networkAccess),
    "--sequence-offset", String(sequenceOffset),
    "--",
    ...args,
  ], {
    stdio: "inherit",
    env: childEnv,
  });

  child.on("error", error => {
    process.stderr.write(`Unable to start guarded Codex: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

function waitForNetworkCapabilityApproval() {
  const approvalId = randomUUID();
  const jobId = currentJobId(cwd);
  if (!jobId) {
    throw new Error("Unable to bind network capability approval to the active Local Codex job; refusing privileged execution");
  }
  mkdirSync(APPROVALS_DIR, { recursive: true, mode: 0o700 });
  const pendingFile = resolve(APPROVALS_DIR, `${approvalId}.pending.json`);
  const decisionFile = resolve(APPROVALS_DIR, `${approvalId}.decision.json`);
  const startedAt = Date.now();
  const pending = {
    approvalId,
    jobId,
    sessionId: null,
    requestId: `capability:${jobId}`,
    method: "localCodex/capabilityApproval",
    params: {
      capability: "networkAccess",
      reason: "Enable outbound command network access and terminal-like host developer credentials for this Local Codex job.",
      additionalPermissions: { network: { enabled: true } },
      accessChange: {
        networkAccess: { from: false, to: true },
        hostCredentials: { from: "filtered", to: "available" },
      },
    },
    cwd,
    networkAccess: true,
    createdAt: startedAt,
    decisionFile,
  };
  writePrivateJson(pendingFile, pending);
  emitBridgeEvent(1, "approval.requested", {
    approvalId,
    method: pending.method,
    params: pending.params,
    networkAccess: true,
    note: "No network-enabled Codex process will start until approved.",
  });
  auditCapability("capability_approval_requested", { jobId, approvalId, status: "held", startedAt });

  return new Promise(resolveDecision => {
    let finished = false;
    const finish = decision => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      activeCapabilityApproval = null;
      rmSync(pendingFile, { force: true });
      rmSync(decisionFile, { force: true });
      emitBridgeEvent(2, "approval.resolved", { approvalId, decision, capability: "networkAccess" });
      auditCapability("capability_approval_resolved", {
        jobId,
        approvalId,
        status: decision === "accept" || decision === "acceptForSession" ? "approved" : "rejected",
        startedAt,
        decision,
      });
      resolveDecision(decision);
    };
    const timer = setInterval(() => {
      if (!existsSync(decisionFile)) return;
      let decision;
      try { decision = JSON.parse(readFileSync(decisionFile, "utf8"))?.decision; }
      catch { return; }
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return;
      finish(decision);
    }, 100);
    activeCapabilityApproval = { cancel: () => finish("cancel") };
  });
}

function currentJobId(selectedCwd) {
  if (!existsSync(JOBS_DIR)) return null;
  const candidates = [];
  for (const file of readdirSync(JOBS_DIR)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
    try {
      const job = JSON.parse(readFileSync(resolve(JOBS_DIR, file), "utf8"));
      if (job.cwd === selectedCwd && ["starting", "running", "cancelling"].includes(job.status) && typeof job.jobId === "string") {
        candidates.push(job);
      }
    } catch { /* ignore unrelated/in-flight records */ }
  }
  candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return candidates[0]?.jobId ?? null;
}

function emitBridgeEvent(seq, type, data) {
  const event = {
    seq,
    time: new Date().toISOString(),
    sessionId: null,
    cwd,
    threadId: null,
    turnId: null,
    type,
    data,
  };
  process.stdout.write(`${JSON.stringify({ method: "localCodex/visibleEvent", params: { event } })}\n`);
}

function auditCapability(event, { jobId, approvalId, status, startedAt, decision }) {
  const entry = {
    time: new Date().toISOString(),
    level: status === "rejected" ? "ERROR" : "INFO",
    component: "local-codex-guard",
    event,
    jobId,
    approvalId,
    capability: "networkAccess",
    networkAccess: true,
    hostCredentials: "available-after-approval",
    status,
    durationMs: Date.now() - startedAt,
    ...(decision ? { decision } : {}),
  };
  try { appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); }
  catch { process.stderr.write("local-codex-guard audit log unavailable\n"); }
}

function writePrivateJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "w", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

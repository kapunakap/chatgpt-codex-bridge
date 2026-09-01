#!/usr/bin/env node

import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const REAL_CODEX_BIN = process.env.LOCAL_CODEX_REAL_BIN || "codex";
const PROBE_MODE = process.env.LOCAL_CODEX_PROBE_MODE || null;
const APPROVAL_MODE = process.env.LOCAL_CODEX_APPROVAL_MODE || "off";
const INTERACTIVE_RESUME = process.env.LOCAL_CODEX_INTERACTIVE_RESUME === "1";
const STATE_FILE = process.env.LOCAL_CODEX_STATE_FILE ||
  resolve(homedir(), "Library/Application Support/local-codex-tunnel/threads.json");
const LOG_FILE = process.env.LOCAL_CODEX_LOG_FILE ||
  resolve(homedir(), "Library/Application Support/tunnel-client/logs/local-codex.log");
const CONTROL_DIR = resolve(dirname(STATE_FILE));
const TOKEN_FILE = process.env.LOCAL_CODEX_TOKEN_FILE || resolve(CONTROL_DIR, "adapter-token");
const JOBS_DIR = process.env.LOCAL_CODEX_JOBS_DIR || resolve(CONTROL_DIR, "jobs");
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
function permissionConfig(cwd, networkAccess, trustedHostAccess = false, protectedControlDir = null, commonGitDir = null, allowWorkspaceAncestors = false) {
  const denied = ["/Users", "/System/Volumes/Data/Users", "/Volumes", "/private/tmp", "/tmp", "/private/var/tmp", "/var/tmp", "/private/var/folders", "/var/folders"];
  const inside = path => cwd === "/" || path === cwd || path.startsWith(`${cwd}/`);
  let readRules;
  if (process.platform === "darwin") {
    readRules = trustedHostAccess
      ? ['":root"="read"']
      : macHardenedReadRules(denied, inside, allowWorkspaceAncestors ? [cwd, commonGitDir].filter(Boolean) : []);
  } else {
    readRules = [trustedHostAccess ? '":root"="read"' : '":minimal"="read"'];
  }
  if (protectedControlDir) readRules.push(`${JSON.stringify(protectedControlDir)}="deny"`);
  const reads = [...new Set(readRules)].join(", ");
  const workspace = ['"."="write"', '".git"="write"', '".codex"="read"', '".env"="deny"', '".env.*"="deny"',
    '"**/.env"="deny"', '"**/.env.*"="deny"', '"*.env"="deny"', '"**/*.env"="deny"',
    '".npmrc"="deny"', '"**/.npmrc"="deny"', '".pypirc"="deny"', '"**/.pypirc"="deny"'].join(", ");
  const roots = [cwd];
  if (commonGitDir && commonGitDir !== cwd && !commonGitDir.startsWith(`${cwd}/`)) roots.push(commonGitDir);
  return `permissions.local-codex-tunnel={description="Local Codex", workspace_roots={${roots.map(root => `${JSON.stringify(root)}=true`).join(", ")}}, filesystem={${reads}, ":workspace_roots"={${workspace}}}, network={enabled=${networkAccess}}}`;
}

function probePermissionConfig(cwd, protectedControlDir = null) {
  const denied = ["/Users", "/System/Volumes/Data/Users", "/Volumes", "/private/tmp", "/tmp", "/private/var/tmp", "/var/tmp", "/private/var/folders", "/var/folders"];
  const inside = path => cwd === "/" || path === cwd || path.startsWith(`${cwd}/`);
  const readRules = process.platform === "darwin"
    ? ['":root"="read"', ...denied.filter(path => {
      const canonical = path.replace(/^\/System\/Volumes\/Data(?=\/)/, "").replace(/^\/tmp$/, "/private/tmp").replace(/^\/var(?=\/)/, "/private/var");
      return !inside(path) && !inside(canonical);
    }).map(path => `${JSON.stringify(path)}="deny"`)]
    : ['":minimal"="read"'];
  if (protectedControlDir) readRules.push(`${JSON.stringify(protectedControlDir)}="deny"`);
  const reads = readRules.join(", ");
  const workspace = ['"."="read"', '".git"="read"', '".codex"="read"', '".env"="deny"', '".env.*"="deny"',
    '"**/.env"="deny"', '"**/.env.*"="deny"', '"*.env"="deny"', '"**/*.env"="deny"',
    '".npmrc"="deny"', '"**/.npmrc"="deny"', '".pypirc"="deny"', '"**/.pypirc"="deny"'].join(", ");
  return `permissions.local-codex-tunnel={description="Local Codex Browser Probe", workspace_roots={${JSON.stringify(cwd)}=true}, filesystem={${reads}, ":workspace_roots"={${workspace}}}, network={enabled=false}}`;
}

const HARDENED_SHELL_ENV_CONFIGS = [
  'shell_environment_policy.inherit="core"',
  "shell_environment_policy.ignore_default_excludes=false",
  'shell_environment_policy.filters={"*PASSWORD*"="exclude","*PASS*"="exclude","*AUTH*"="exclude","*CREDENTIAL*"="exclude","*COOKIE*"="exclude","*SESSION*"="exclude","LOCAL_CODEX_*"="exclude","TUNNEL_CLIENT_*"="exclude"}',
];

// networkAccess=true is intentionally terminal-like after the caller selects
// that capability: ordinary developer auth such as gh config/Keychain,
// GH_TOKEN/GITHUB_TOKEN, and SSH_AUTH_SOCK may then be used by commands. Host
// approval is additionally required only when APPROVAL_MODE is "host". Keep
// the tunnel's own variables out of the Codex process and keep CONTROL_DIR
// denied at the filesystem layer.
const TRUSTED_SHELL_ENV_CONFIGS = [
  'shell_environment_policy.inherit="all"',
  "shell_environment_policy.ignore_default_excludes=true",
  'shell_environment_policy.filters={"LOCAL_CODEX_*"="exclude","TUNNEL_CLIENT_*"="exclude"}',
];

const HARDENED_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

if (PROBE_MODE !== null && PROBE_MODE !== "browser-status") {
  throw new Error("Unknown Local Codex probe mode");
}
if (INTERACTIVE_RESUME && PROBE_MODE) {
  throw new Error("Interactive resume cannot run in probe mode");
}
if (!["off", "host"].includes(APPROVAL_MODE)) {
  throw new Error("LOCAL_CODEX_APPROVAL_MODE must be off or host");
}
const hostApprovalsEnabled = APPROVAL_MODE === "host";

const requestedArgs = process.argv.slice(2);
const cwd = realpathSync(process.cwd());
let interactiveNetworkAccess = null;
if (INTERACTIVE_RESUME) {
  if (requestedArgs.length !== 2 || requestedArgs[0] !== "resume" ||
      typeof requestedArgs[1] !== "string" || !requestedArgs[1] || requestedArgs[1].startsWith("-") ||
      requestedArgs[1].length > 200) {
    throw new Error("Interactive resume requires exactly one saved thread id");
  }
  if (!authorizedResume(process.env.LOCAL_CODEX_RESUME_TOKEN)) {
    throw new Error("Interactive resume authorization failed");
  }
  if (!['true', 'false'].includes(process.env.LOCAL_CODEX_RESUME_NETWORK_ACCESS)) {
    throw new Error("Interactive resume requires an explicit network setting");
  }
  interactiveNetworkAccess = process.env.LOCAL_CODEX_RESUME_NETWORK_ACCESS === "true";
}

const args = [...requestedArgs];
if (INTERACTIVE_RESUME) {
  args.push("--include-non-interactive", "-C", cwd, "-c", permissionConfig(cwd, interactiveNetworkAccess));
}
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
const commonGitDir = gitCommonDirectory(cwd);
if (PROBE_MODE && networkAccess) {
  throw new Error("Local Codex probe mode cannot enable command network access");
}
// Validate only the adapter-owned input profile. The wrapper-owned CONTROL_DIR
// deny and host capability gate are applied after this exact validation and
// cannot be supplied, removed, or redirected by the caller.
const expectedPermission = PROBE_MODE ? probePermissionConfig(cwd) : permissionConfig(cwd, networkAccess, false, null, commonGitDir);
if (permission !== expectedPermission) {
  throw new Error(PROBE_MODE
    ? "Local Codex probe profile does not match the read-only browser diagnostic policy"
    : "Local Codex permission profile does not match the hardened workspace policy");
}
if (args.includes("--sandbox") || args.some(value => value.includes("sandbox_mode") || value.includes(":danger-full-access") || value.includes("dangerously_allow"))) {
  throw new Error("Unsafe Codex sandbox configuration is not allowed");
}

// Always replace the validated input profile with the effective profile that
// denies host-authority state. Probe mode additionally keeps the entire selected
// workspace read-only, so App Server/plugin startup behavior cannot mutate it.
args[permissionIndex] = PROBE_MODE
  ? probePermissionConfig(cwd, CONTROL_DIR)
  : permissionConfig(cwd, networkAccess, networkAccess, CONTROL_DIR, commonGitDir, !networkAccess);

// Normal jobs get private scratch space inside an already-authorized writable
// root. Git workspaces use their per-worktree metadata directory so temporary
// files never appear in `git status`; non-Git workspaces use their own root.
// Probe mode remains read-only and creates no workspace state.
const scratchDir = PROBE_MODE ? null : createScratchDirectory(cwd, commonGitDir);
let scratchCleaned = false;
const cleanupScratch = () => {
  if (!scratchDir || scratchCleaned) return;
  scratchCleaned = true;
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`Unable to remove Local Codex scratch directory: ${error.message}\n`);
    process.exitCode = 1;
  }
};
process.once("exit", cleanupScratch);

const commandEnvOverrides = scratchDir ? {
  TMPDIR: scratchDir,
  TMP: scratchDir,
  TEMP: scratchDir,
  ...(!networkAccess ? { ...HARDENED_GIT_ENV, ...developerGitEnvironment() } : {}),
} : {};
if (Object.keys(commandEnvOverrides).length > 0) {
  args.push("-c", shellEnvironmentSetConfig(commandEnvOverrides));
}
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
Object.assign(childEnv, commandEnvOverrides);

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

if (INTERACTIVE_RESUME) {
  args.push(
    "-a", hostApprovalsEnabled ? "untrusted" : "never",
    "-c", 'sandbox_permissions=["local-codex-tunnel"]',
    "-c", "mcp_servers.node_repl.enabled=false",
    "-c", "mcp_servers.playwright.enabled=false",
    "-c", "mcp_servers.local_codex_browser.enabled=false",
  );
}

// Probe mode never starts a Guard session or a Codex thread. It only exposes
// the real App Server's stdio to the adapter under the validated read-only
// profile. LOCAL_CODEX_* / TUNNEL_CLIENT_* are not passed to the child.
if (PROBE_MODE || INTERACTIVE_RESUME) {
  const command = REAL_CODEX_BIN.endsWith(".mjs") ? process.execPath : REAL_CODEX_BIN;
  const commandArgs = REAL_CODEX_BIN.endsWith(".mjs") ? [REAL_CODEX_BIN, ...args] : args;
  child = spawn(command, commandArgs, { stdio: "inherit", env: childEnv });
  child.on("error", error => {
    cleanupScratch();
    const label = INTERACTIVE_RESUME ? "interactive resume" : "probe";
    process.stderr.write(`Unable to start Local Codex ${label}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    cleanupScratch();
    process.exitCode = signal ? 1 : (code ?? 1);
  });
} else {
  // In host approval mode, the network-enabled profile is held before the real
  // Codex process exists. In the default off mode, the explicit networkAccess
  // selection grants the capability without another host prompt.
  let sequenceOffset = 0;
  if (networkAccess && hostApprovalsEnabled) {
    const decision = await waitForNetworkCapabilityApproval();
    sequenceOffset = 2; // approval.requested + approval.resolved precede proxy events.
    if (decision !== "accept" && decision !== "acceptForSession") {
      process.exitCode = decision === "cancel" ? 130 : 77;
    }
  }

  if (!process.exitCode) {
    // The proxy always records visible events. In host mode it also holds native
    // command/file approvals; in off mode it forces approvalPolicy=never and
    // automatically resolves any unexpected approval request.
    child = spawn(process.execPath, [
      GUARD_PROXY,
      "--real-bin", REAL_CODEX_BIN,
      "--guard-dir", GUARD_DIR,
      "--network-access", String(networkAccess),
      "--approval-mode", APPROVAL_MODE,
      "--sequence-offset", String(sequenceOffset),
      "--",
      ...args,
    ], {
      stdio: "inherit",
      env: childEnv,
    });

    child.on("error", error => {
      cleanupScratch();
      process.stderr.write(`Unable to start guarded Codex: ${error.message}\n`);
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      cleanupScratch();
      if (signal) {
        process.exitCode = 1;
        return;
      }
      process.exitCode = code ?? 1;
    });
  }
}

function authorizedResume(value) {
  if (typeof value !== "string" || !value) return false;
  let expected;
  try { expected = readFileSync(TOKEN_FILE, "utf8").trim(); }
  catch { return false; }
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function gitCommonDirectory(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim()) return null;
  try { return realpathSync(result.stdout.trim()); }
  catch { throw new Error("Invalid Git common directory for Local Codex workspace"); }
}

function gitDirectory(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir"], {
    encoding: "utf8",
    env: { ...process.env, ...HARDENED_GIT_ENV },
  });
  if (result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim()) return null;
  try { return realpathSync(result.stdout.trim()); }
  catch { throw new Error("Invalid Git directory for Local Codex workspace"); }
}

function developerGitEnvironment() {
  if (process.platform !== "darwin") return {};
  const result = spawnSync("/usr/bin/xcrun", ["--find", "git"], {
    encoding: "utf8",
    env: { ...process.env, ...HARDENED_GIT_ENV },
  });
  if (result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim()) {
    throw new Error("Unable to resolve the macOS developer Git executable");
  }
  let gitPath;
  try { gitPath = realpathSync(result.stdout.trim()); }
  catch { throw new Error("Invalid macOS developer Git executable"); }
  if (gitPath === "/usr/bin/git") {
    throw new Error("macOS developer Git resolved to the xcrun shim");
  }
  const developerBin = dirname(gitPath);
  return {
    PATH: `${developerBin}:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}`,
    DEVELOPER_DIR: resolve(developerBin, "../.."),
    // The leading empty entry tells Git the following ceiling path does not
    // need symlink resolution. This prevents repository discovery from
    // probing the deliberately denied /Users ancestor.
    GIT_CEILING_DIRECTORIES: ":/Users",
  };
}

function macHardenedReadRules(denied, inside, authorizedRoots) {
  const userTrees = ["/Users", "/System/Volumes/Data/Users"];
  const rules = ['":root"="read"'];
  for (const path of denied) {
    if (authorizedRoots.length > 0 && userTrees.includes(path)) continue;
    const canonical = path.replace(/^\/System\/Volumes\/Data(?=\/)/, "").replace(/^\/tmp$/, "/private/tmp").replace(/^\/var(?=\/)/, "/private/var");
    if (!inside(path) && !inside(canonical)) rules.push(`${JSON.stringify(path)}="deny"`);
  }
  if (authorizedRoots.length === 0) return rules;
  for (const tree of userTrees) {
    const targets = authorizedRoots.map(root => {
      const canonical = root.replace(/^\/System\/Volumes\/Data(?=\/)/, "");
      return canonical === "/Users" || canonical.startsWith("/Users/")
        ? `${tree}${canonical.slice("/Users".length)}`
        : null;
    }).filter(Boolean);
    if (targets.length === 0) {
      rules.push(`${JSON.stringify(tree)}="deny"`);
      continue;
    }
    // The macOS sandbox needs readable directory ancestors for getcwd and
    // Git discovery. Deny unrelated entries beneath those ancestors instead
    // of denying the ancestors themselves.
    rules.push(...denyUnrelatedUserPaths(tree, targets));
  }
  for (const root of authorizedRoots) rules.push(`${JSON.stringify(root)}="write"`);
  return rules;
}

function denyUnrelatedUserPaths(tree, targets) {
  const rules = [];
  const minimalTargets = targets.filter(target => !targets.some(other => other !== target && target.startsWith(`${other}/`)));
  const visit = (directory, activeTargets) => {
    // Once an authorized root is reached, keep its complete subtree readable
    // (Git worktree metadata lives below the common Git directory). Unrelated
    // entries are denied only while walking the ancestors toward that root.
    if (activeTargets.some(target => target === directory)) return;
    const nextTargets = new Map();
    for (const target of activeTargets) {
      const remainder = relative(directory, target);
      if (!remainder || remainder.startsWith("..")) continue;
      const name = remainder.split("/")[0];
      if (!nextTargets.has(name)) nextTargets.set(name, []);
      nextTargets.get(name).push(target);
    }
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { throw new Error("Unable to build the hardened Local Codex user-path boundary"); }
    for (const entry of entries) {
      const child = resolve(directory, entry.name);
      const childTargets = nextTargets.get(entry.name);
      if (childTargets) visit(child, childTargets);
      else rules.push(`${JSON.stringify(child)}="deny"`);
    }
  };
  visit(tree, minimalTargets);
  return rules;
}

function createScratchDirectory(cwd, commonGitDir) {
  const gitDir = gitDirectory(cwd);
  const parent = gitDir || cwd;
  const authorizedRoots = [cwd, commonGitDir].filter(Boolean);
  if (!authorizedRoots.some(root => parent === root || parent.startsWith(`${root}/`))) {
    throw new Error("Local Codex scratch directory is outside the authorized workspace roots");
  }
  const prefix = resolve(parent, gitDir ? "local-codex-tmp-" : ".local-codex-tmp-");
  const scratch = realpathSync(mkdtempSync(prefix));
  if (!authorizedRoots.some(root => scratch.startsWith(`${root}/`))) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error("Local Codex scratch directory escaped the authorized workspace roots");
  }
  chmodSync(scratch, 0o700);
  return scratch;
}

function shellEnvironmentSetConfig(values) {
  const entries = Object.entries(values)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(",");
  return `shell_environment_policy.set={${entries}}`;
}

async function waitForNetworkCapabilityApproval() {
  const approvalId = randomUUID();
  const jobId = await waitForCurrentJobId(cwd);
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

async function waitForCurrentJobId(selectedCwd) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const jobId = currentJobId(selectedCwd);
    if (jobId) return jobId;
    if (Date.now() >= deadline) return null;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
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
  if (candidates.length > 1) {
    throw new Error("Multiple active Local Codex jobs claim the same workspace; refusing privileged execution");
  }
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

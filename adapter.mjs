#!/usr/bin/env node

import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  browserStatusTool,
  createOfficialBrowserBroker,
  officialBrowserDynamicTools,
  probeBrowserBackend,
} from "./browser-probe.mjs";
import { createWorktreeManager } from "./worktree-manager.mjs";

// Only used to migrate pre-v3 records; never used as a new job's default.
const legacyRootInput = process.env.LOCAL_CODEX_ROOT;
const HOST = process.env.LOCAL_CODEX_HOST || "127.0.0.1";
const PORT = Number(process.env.LOCAL_CODEX_PORT || "8765");
const CODEX_BIN = process.env.LOCAL_CODEX_BIN || "codex";
const BROWSER_PROXY_PATH = fileURLToPath(new URL("./browser-proxy.mjs", import.meta.url));
const TOKEN_FILE = process.env.LOCAL_CODEX_TOKEN_FILE;
const STATE_FILE = process.env.LOCAL_CODEX_STATE_FILE ||
  resolve(homedir(), "Library/Application Support/local-codex-tunnel/threads.json");
const LOG_FILE = process.env.LOCAL_CODEX_LOG_FILE ||
  resolve(homedir(), "Library/Application Support/tunnel-client/logs/local-codex.log");
const JOBS_DIR = process.env.LOCAL_CODEX_JOBS_DIR || resolve(dirname(STATE_FILE), "jobs");
const JOB_EVENTS_DIR = process.env.LOCAL_CODEX_JOB_EVENTS_DIR || resolve(dirname(STATE_FILE), "job-events");
const WORKTREE_ROOT = process.env.LOCAL_CODEX_WORKTREE_ROOT || resolve(homedir(), "Library/Application Support/local-codex-worktrees");
const WORKTREE_RETENTION = Number(process.env.LOCAL_CODEX_WORKTREE_RETENTION || "15");
const VERSION = "3.5.1";
const DEFAULT_SETTINGS = { model: "gpt-5.6-luna", reasoningEffort: "max" };
const MODEL_ALIASES = new Map([
  ["luna", "gpt-5.6-luna"], ["terra", "gpt-5.6-terra"], ["sol", "gpt-5.6-sol"],
]);
const selectionProperties = {
  model: {
    type: "string", minLength: 1, maxLength: 200,
    description: "Codex model ID or alias luna, terra, sol. New threads default to gpt-5.6-luna; replies keep the thread model when omitted.",
  },
  reasoningEffort: {
    type: "string", minLength: 1, maxLength: 32,
    description: "Reasoning level supported by the selected model (e.g. low, medium, high, xhigh, max). New threads default to max; replies keep the thread level when omitted. Unsupported combinations fail without fallback.",
  },
};
const MAX_BODY = 1024 * 1024;
const CALL_TIMEOUT_MS = Number(process.env.LOCAL_CODEX_CALL_TIMEOUT_MS || "1800000");
const POLL_LEASE_MS = Number(process.env.LOCAL_CODEX_POLL_LEASE_MS || "90000");
const MAX_CONCURRENCY = Number(process.env.LOCAL_CODEX_MAX_CONCURRENCY || "10");
const MAX_QUEUE = Number(process.env.LOCAL_CODEX_MAX_QUEUE || "100");
const PROCESS_TERM_GRACE_MS = 2000;
const PROCESS_KILL_VERIFY_MS = 2000;
const PROCESS_CHECK_INTERVAL_MS = 25;
const VISIBLE_EVENT_TYPES = new Set([
  "session.started", "session.error", "session.ended",
  "chatgpt.prompt", "thread.started", "turn.requested", "turn.started", "turn.completed", "turn.interrupt_requested",
  "settings.updated", "assistant.delta", "item.started", "item.completed",
  "approval.requested", "approval.resolved", "approval.server_resolved",
  "browser.environment_blocked",
]);
function permissionConfig(cwd, networkAccess, commonGitDir = null) {
  // Codex 0.147's macOS :minimal preset includes unconditional temp writes.
  // Use system reads without that preset; keep other user/data/temp trees
  // denied. The selected workspace reopens only its own tree. Git metadata is
  // writable there so fetch/clone operations work, while Codex configuration
  // and common credential files stay read-only or denied.
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
  const roots = [cwd];
  if (commonGitDir && commonGitDir !== cwd && !commonGitDir.startsWith(`${cwd}/`)) roots.push(commonGitDir);
  return `permissions.local-codex-tunnel={description="Local Codex", workspace_roots={${roots.map(root => `${JSON.stringify(root)}=true`).join(", ")}}, filesystem={${reads}, ":workspace_roots"={${workspace}}}, network={enabled=${networkAccess}}}`;
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("LOCAL_CODEX_PORT must be an integer between 1 and 65535");
}
if (HOST !== "127.0.0.1" && HOST !== "::1") throw new Error("LOCAL_CODEX_HOST must be loopback");
if (!Number.isSafeInteger(CALL_TIMEOUT_MS) || CALL_TIMEOUT_MS <= 0 || CALL_TIMEOUT_MS > 2147483647) {
  throw new Error("LOCAL_CODEX_CALL_TIMEOUT_MS must be a positive timer-safe integer");
}
if (!Number.isSafeInteger(POLL_LEASE_MS) || POLL_LEASE_MS <= 0 || POLL_LEASE_MS > 2147483647) {
  throw new Error("LOCAL_CODEX_POLL_LEASE_MS must be a positive timer-safe integer");
}
if (!Number.isSafeInteger(MAX_CONCURRENCY) || MAX_CONCURRENCY < 1 || MAX_CONCURRENCY > 1024) {
  throw new Error("LOCAL_CODEX_MAX_CONCURRENCY must be an integer between 1 and 1024");
}
if (!Number.isSafeInteger(MAX_QUEUE) || MAX_QUEUE < 0 || MAX_QUEUE > 100000) {
  throw new Error("LOCAL_CODEX_MAX_QUEUE must be an integer between 0 and 100000");
}
if (!isAbsolute(WORKTREE_ROOT)) throw new Error("LOCAL_CODEX_WORKTREE_ROOT must be absolute");
if (!Number.isSafeInteger(WORKTREE_RETENTION) || WORKTREE_RETENTION < 1 || WORKTREE_RETENTION > 1000) {
  throw new Error("LOCAL_CODEX_WORKTREE_RETENTION must be an integer between 1 and 1000");
}

if (!TOKEN_FILE) {
  throw new Error("LOCAL_CODEX_TOKEN_FILE is required");
}

const expectedAuthorization = (await readFile(TOKEN_FILE, "utf8")).trim();
if (!expectedAuthorization) {
  throw new Error("local adapter token is empty");
}

const threadFolders = new Map();
const threadNetworkAccess = new Map();
const threadBrowserAccess = new Map();
const threadSourceTitles = new Map();
const threadCodexNames = new Map();
const threadSourceCwds = new Map();
const threadWorkspaceKinds = new Map();
const threadWorktreeIds = new Map();
let threadState = {};
await mkdir(dirname(LOG_FILE), { recursive: true, mode: 0o700 });
appendFileSync(LOG_FILE, "", { mode: 0o600 });
await mkdir(JOBS_DIR, { recursive: true, mode: 0o700 });
await mkdir(JOB_EVENTS_DIR, { recursive: true, mode: 0o700 });
await mkdir(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
const worktreeManager = await createWorktreeManager({
  rootDir: WORKTREE_ROOT,
  stateDir: dirname(STATE_FILE),
  retention: WORKTREE_RETENTION,
});
const jobs = new Map();
const requests = new Map();
const waiters = new Map();
const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
const activeJobs = new Map();
const activeFolders = new Set();
const jobQueue = [];
const browserSessions = new Map();
const browserMcpTools = officialBrowserDynamicTools()[0].tools.map(tool => {
  const readOnly = ["open", "snapshot", "get_text", "screenshot", "close"].includes(tool.name);
  return {
    name: `official_browser_${tool.name}`,
    title: `Official Browser: ${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: ["snapshot", "get_text", "screenshot", "close"].includes(tool.name),
      openWorldHint: true,
    },
  };
});
let ready = false;
let shuttingDown = false;
let storageHealthy = true;
let runtimeHealthy = true;
const requestIdProperty = {
  type: "string", minLength: 1, maxLength: 200,
  description: "Generate a unique ID for new work. Reuse this exact ID and arguments on retries; never retry with a new ID.",
};
const sourceTitleProperty = {
  type: "string", minLength: 1, maxLength: 200,
  description: "Exact title of the ChatGPT conversation that started this work. Pass it only when the host exposes the exact title; omit it when unavailable. Never invent, summarize, or infer a title.",
};
const worktreeProperty = {
  type: "boolean", default: true,
  description: "Defaults to true. For Git repositories, run this new thread in its own detached managed worktree created from committed HEAD. Set false only when the user explicitly needs the selected checkout itself. Non-Git and unborn repositories fall back to the selected directory.",
};
const newThreadNetworkProperty = {
  type: "boolean", default: false,
  description: "Choose from the user's task intent. Set true whenever completing the request requires outbound command network access, even if the user did not explicitly ask for network access—for example git fetch, git pull, git clone, installing dependencies or packages, curl, HTTP/API access, or downloads. Omit or set false for fully local work. Defaults to false and does not change filesystem access.",
};
const replyNetworkProperty = {
  type: "boolean",
  description: "Choose from the current task and saved thread state. Omit to inherit: an enabled thread stays enabled and a disabled or legacy thread stays disabled. Set true when this reply newly requires outbound command network access, even if the user only implies it—for example git fetch, git pull, git clone, installing dependencies or packages, curl, HTTP/API access, or downloads. Set false when networking must be disabled again. This does not change filesystem access.",
};

const newThreadBrowserProperty = {
  type: "boolean", default: false,
  description: "Set true when the task requires the official Codex Browser/Chrome backend for navigation, page inspection, interaction, screenshots, or browser-based QA. This is independent of networkAccess and never enables shell-launched Playwright, Chromium, Puppeteer, Chrome for Testing, wider filesystem access, or danger-full-access. Official Browser permissions and confirmations remain enforced by ChatGPT.",
};
const replyBrowserProperty = {
  type: "boolean",
  description: "Omit to inherit the thread's official Browser capability. Set true when this reply newly needs the official Codex Browser/Chrome backend and false to disable it again. This does not imply command network access and never enables shell Chromium or a wider sandbox.",
};

const tools = [
  {
    name: "codex",
    title: "Local Codex",
    description: "Start a background Codex job from cwd, any existing absolute folder you choose. Git repositories use a dedicated detached worktree from committed HEAD by default. Different canonical folders can run concurrently, and isolated worktrees let different threads from one repository run concurrently too. Set worktree false only when the user explicitly needs the selected checkout, where jobs are serialized through the queue. Replies reuse the thread workspace. Pass sourceTitle only when the host exposes the exact ChatGPT conversation title; otherwise omit it. Choose networkAccess from the user's task intent: set true when completing the request requires outbound command access such as git fetch, git pull, git clone, installing dependencies or packages, curl, HTTP/API access, or downloads, even if the user did not explicitly ask for network access; omit or use false for fully local command work. Choose browserAccess separately when the task needs the official Codex Browser/Chrome backend for navigation, page inspection, interaction, screenshots, or browser-based QA. browserAccess never enables shell-launched Playwright/Chromium, command networking, wider filesystem access, or danger-full-access. Use codex-folders to locate the narrowest relevant folder. Returns jobId immediately; start polling codex-status with waitMs=20000 and continue until terminal. Each valid status poll renews a 90-second default lease; if polling stops, queued or running work is cancelled. Never resubmit to check progress. Default Luna/max.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        requestId: requestIdProperty,
        cwd: { type: "string", minLength: 1, maxLength: 4096, description: "Absolute path to an existing source folder. Symlinks resolve to their target. Status returns canonical sourceCwd plus the actual execution cwd, which is the write boundary." },
        prompt: { type: "string", minLength: 1, maxLength: 100000 },
        sourceTitle: sourceTitleProperty,
        worktree: worktreeProperty,
        networkAccess: newThreadNetworkProperty,
        browserAccess: newThreadBrowserProperty,
        ...selectionProperties,
      },
      required: ["requestId", "cwd", "prompt"],
    },
    outputSchema: resultSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "codex-reply",
    title: "Local Codex Reply",
    description: "Start a background reply on an adapter-owned thread in its saved folder. Pass sourceTitle only when the host exposes the exact ChatGPT conversation title; omit it to inherit any exact title already saved for the thread. Omit networkAccess to inherit: enabled stays enabled and disabled stays disabled. Set true when this reply newly requires outbound command access, even if the user only implies it; set false when command networking must be disabled again. Omit browserAccess to inherit the saved official Browser capability; set true when the reply needs the official Codex Browser/Chrome backend and false to disable it. browserAccess is independent of networkAccess and never enables shell Chromium or a wider sandbox. Folder changes are not allowed; use codex for a new folder. Replies use the same per-folder queue. Returns jobId; start polling codex-status with waitMs=20000 and continue until terminal. Each valid status poll renews a 90-second default lease; if polling stops, queued or running work is cancelled. Omitted model/reasoningEffort retain thread settings; overrides persist. Reuse requestId on retries.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        requestId: requestIdProperty,
        threadId: { type: "string", minLength: 1, maxLength: 200 },
        prompt: { type: "string", minLength: 1, maxLength: 100000 },
        sourceTitle: sourceTitleProperty,
        networkAccess: replyNetworkProperty,
        browserAccess: replyBrowserProperty,
        ...selectionProperties,
      },
      required: ["requestId", "threadId", "prompt"],
    },
    outputSchema: resultSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "codex-status", title: "Local Codex Job Status",
    description: "Read a saved job and renew its polling lease while it is queued or running. Start immediately after submission and keep polling until completed, failed, cancelled, timed_out, or interrupted; stopping for longer than the configured lease cancels the job. For normal completion polling, optionally wait up to 20 seconds with waitMs=20000. For incremental visible activity, start with afterEventSeq=0 and waitMs=20000; the call returns as soon as a new event arrives or the job becomes terminal. Pass nextEventSeq back as afterEventSeq on the next poll. Events include externally visible prompts/messages/commands/results/approval state and never hidden reasoning. Known macOS Chromium sandbox failures are classified as execution-environment failures in the job snapshot/events.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      jobId: { type: "string", minLength: 1, maxLength: 200 },
      waitMs: { type: "integer", minimum: 0, maximum: 20000, default: 0 },
      afterEventSeq: { type: "integer", minimum: 0, description: "Incremental event cursor. Start at 0, then reuse nextEventSeq." },
      eventLimit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    }, required: ["jobId"] },
    outputSchema: resultSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "codex-cancel", title: "Cancel Local Codex Job",
    description: "Cancel a queued or running background job explicitly. Does not undo file changes. Poll codex-status until cancelled for running work; queued work cancels immediately. Cancelling an already terminal job returns its saved result.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      jobId: { type: "string", minLength: 1, maxLength: 200 },
    }, required: ["jobId"] },
    outputSchema: resultSchema(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  browserStatusTool,
  {
    name: "codex-folders", title: "Find Local Codex Folders",
    description: "List up to 100 child directory names, including directory symlinks, without reading file contents or starting work. Defaults to your home directory; pass an absolute path to browse elsewhere. Follow nextCursor with the same path for another page. Choose a task's folder automatically; no preapproved list is required.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      path: { type: "string", minLength: 1, maxLength: 4096 },
      cursor: { type: "string", minLength: 1, maxLength: 8192 },
    } },
    outputSchema: folderSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
const SCHEMA_FINGERPRINT = digest(JSON.stringify(tools));

const server = createServer(async (req, res) => {
  const disconnect = new AbortController();
  res.once("close", () => disconnect.abort());
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      return json(res, 200, { status: "ok" });
    }
    if (req.method === "GET" && req.url === "/readyz") {
      const healthy = ready && storageHealthy && runtimeHealthy && !shuttingDown;
      const active = [...activeJobs.values()];
      return json(res, healthy ? 200 : 503, {
        status: healthy ? "ready" : "unavailable", scope: "per_job", version: VERSION, schemaFingerprint: SCHEMA_FINGERPRINT,
        activeCalls: active.length, queuedCalls: jobQueue.length,
        activeJobId: active[0]?.jobId ?? null, activeCwd: active[0]?.cwd ?? null,
        activeJobIds: active.map(job => job.jobId), activeCwds: active.map(job => job.cwd),
        queuedJobIds: jobQueue.map(job => job.jobId), queuedCwds: jobQueue.map(job => job.cwd),
        maxConcurrency: MAX_CONCURRENCY, maxQueue: MAX_QUEUE, scheduling: "fifo-runnable-per-folder",
        pollLeaseMs: POLL_LEASE_MS,
        worktreesDefault: true, worktreeRetention: WORKTREE_RETENTION, worktreeRoot: WORKTREE_ROOT,
        browserAccessStatus: "official-backend",
      });
    }
    if (req.url?.startsWith("/.well-known/")) {
      return json(res, 404, { error: "not found" });
    }
    if (!authorized(req.headers.authorization)) {
      return json(res, 401, { error: "unauthorized" });
    }
    if (!ready || shuttingDown) return json(res, 503, { error: "adapter unavailable" });
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "method not allowed" });
    }

    const message = JSON.parse(await readBody(req));
    const response = await handleMcp(message, disconnect.signal);
    if (res.destroyed) return;
    if (response === null) {
      res.statusCode = 202;
      return res.end();
    }
    return json(res, 200, response, {
      "Mcp-Session-Id": "local-codex",
    });
  } catch (error) {
    return json(res, error?.statusCode || 500, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: error?.statusCode === 413 ? -32001 : -32603,
        message: safeError(error),
      },
    });
  }
});

server.listen(PORT, HOST, async () => {
  try {
    await loadThreadState();
    await worktreeManager.reconcile();
    await loadJobs();
    ready = true;
    process.stderr.write(`local-codex-adapter ready on http://${HOST}:${PORT}/mcp; scope=per_job\n`);
  } catch {
    process.stderr.write("local-codex-adapter job recovery failed; refusing work\n");
    server.close(() => process.exit(1));
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { void shutdown(); });
}

async function handleMcp(message, signal) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id ?? null, -32600, "invalid request");
  }
  if (!("id" in message)) {
    if (message.method === "notifications/cancelled") {
      for (const waiter of waiters.get(rpcKey(message.params?.requestId)) || []) waiter.abort();
    }
    return null;
  }

  switch (message.method) {
    case "server/discover":
      return rpcError(message.id, -32601, "method not found: server/discover");
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "local-codex", title: "Local Codex", version: VERSION },
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id: message.id, result: {} };
    case "tools/list":
      logCall("schema_served", { tool: "tools/list", status: "discovery", startedAt: Date.now() });
      return { jsonrpc: "2.0", id: message.id, result: { tools } };
    case "tools/call":
      return callTool(message, signal);
    case "localCodex/worktreeRestore":
      return restoreWorktreeForMonitor(message);
    default:
      return rpcError(message.id, -32601, `method not found: ${message.method}`);
  }
}

async function restoreWorktreeForMonitor(message) {
  const jobId = message.params?.jobId;
  assertIdentifier(jobId, "jobId");
  const job = jobs.get(jobId);
  if (!job) return rpcError(message.id, -32602, "unknown job");
  if (!terminalStatuses.has(job.status)) return rpcError(message.id, -32602, "job is not terminal");
  if (!job.worktreeId) return { jsonrpc: "2.0", id: message.id, result: { cwd: job.cwd, worktreeState: "direct" } };
  try {
    const record = await worktreeManager.prepare(job.worktreeId);
    job.cwd = record.executionCwd;
    job.gitCommonDir = record.commonGitDir;
    job.worktreeState = record.state;
    persistJob(job);
    return { jsonrpc: "2.0", id: message.id, result: { cwd: job.cwd, worktreeState: job.worktreeState } };
  } catch (error) {
    return rpcError(message.id, -32603, error.message || "worktree restore failed");
  }
}

async function callTool(message, signal) {
  const name = message.params?.name;
  const args = message.params?.arguments || {};
  try {
    if (name === "codex-browser-status") {
      validateArguments(args, ["cwd"]);
      const cwd = await canonicalDirectory(args.cwd, "cwd");
      return toolResult(message.id, await probeBrowserBackend({ cwd, codexBin: CODEX_BIN, adapterVersion: VERSION, signal }));
    }
    if (name === "codex-folders") {
      validateArguments(args, ["path", "cursor"]);
      return toolResult(message.id, await listFolders(args));
    }
    if (name === "codex" || name === "codex-reply") {
      validateArguments(args, name === "codex" ? ["requestId", "cwd", "prompt", "sourceTitle", "worktree", "networkAccess", "browserAccess", "model", "reasoningEffort"]
        : ["requestId", "threadId", "prompt", "sourceTitle", "networkAccess", "browserAccess", "model", "reasoningEffort"]);
      const missing = tools.find(tool => tool.name === name).inputSchema.required.filter(field => args[field] === undefined);
      if (missing.length) {
        throw callError("schema_outdated", `Local Codex ${VERSION} is missing required fields: ${missing.join(", ")}. In ChatGPT, open Local Codex > Manage > Refresh, then start a fresh chat. No job was started.`);
      }
      assertIdentifier(args.requestId, "requestId");
      assertPrompt(args.prompt);
      const suppliedSourceTitle = args.sourceTitle === undefined ? null : normalizeSourceTitle(args.sourceTitle);
      assertSelectionArguments(args);
      if (args.networkAccess !== undefined && typeof args.networkAccess !== "boolean") {
        throw callError("invalid_request", "networkAccess must be true or false when provided");
      }
      if (args.browserAccess !== undefined && typeof args.browserAccess !== "boolean") {
        throw callError("invalid_request", "browserAccess must be true or false when provided");
      }
      if (args.worktree !== undefined && typeof args.worktree !== "boolean") {
        throw callError("invalid_request", "worktree must be true or false when provided");
      }
      if (name === "codex-reply" && !threadFolders.has(args.threadId)) {
        throw callError("unknown_thread", "threadId was not created by this Local Codex adapter");
      }
      const sourceCwd = name === "codex" ? await canonicalDirectory(args.cwd, "cwd") : threadSourceCwds.get(args.threadId) || threadFolders.get(args.threadId);
      const networkAccess = args.networkAccess ?? (name === "codex-reply" ? threadNetworkAccess.get(args.threadId) : false) ?? false;
      const browserAccess = args.browserAccess ?? (name === "codex-reply" ? threadBrowserAccess.get(args.threadId) : false) ?? false;
      const sourceTitle = suppliedSourceTitle ?? (name === "codex-reply" ? threadSourceTitles.get(args.threadId) : null) ?? null;
      const codexThreadName = name === "codex-reply" ? threadCodexNames.get(args.threadId) ?? null : null;
      const browserTurnMetadata = browserAccess ? extractBrowserTurnMetadata(message.params?._meta) : null;
      if (browserAccess && !browserTurnMetadata) {
        throw callError("browser_host_context_unavailable", "Official Browser Use requires a live ChatGPT turn context. Refresh Local Codex tools and start the browser job from ChatGPT; no job was started.");
      }
      const key = digest(args.requestId);
      const fingerprintInput = [sourceCwd, name, args.prompt, args.threadId ?? null,
        MODEL_ALIASES.get(args.model) || args.model || null, args.reasoningEffort ?? null];
      // Keep omitted-field fingerprints byte-for-byte compatible with pre-v3.1
      // saved jobs. Explicit capability values are still distinct requests.
      if (args.networkAccess !== undefined) fingerprintInput.push(args.networkAccess);
      if (args.browserAccess !== undefined) fingerprintInput.push(args.browserAccess);
      if (args.sourceTitle !== undefined) fingerprintInput.push(suppliedSourceTitle);
      if (args.worktree !== undefined) fingerprintInput.push(args.worktree);
      const fingerprint = digest(JSON.stringify(fingerprintInput));
      const prior = requests.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw callError("request_conflict", "requestId already belongs to different arguments");
        renewJobLease(prior);
        return toolResult(message.id, snapshot(prior));
      }
      if (!storageHealthy) throw callError("storage_error", "Job storage unavailable; refusing new work");
      if (!runtimeHealthy) throw callError("unavailable", "Job process cleanup could not be verified; restart the adapter before starting new work");
      if (shuttingDown) throw callError("unavailable", "Adapter is shutting down; no work was started");
      if (signal?.aborted) throw callError("request_cancelled", "Request disconnected before acceptance");
      const jobId = randomUUID();
      let workspace;
      if (name === "codex") {
        try { workspace = await worktreeManager.plan({ id: jobId, sourceCwd, enabled: args.worktree !== false }); }
        catch (error) { throw callError(error.code || "worktree_plan_failed", error.message || "Unable to plan worktree"); }
      } else {
        const worktreeId = threadWorktreeIds.get(args.threadId);
        workspace = worktreeId ? worktreeManager.get(worktreeId) : null;
        if (!workspace) {
          workspace = {
            id: null,
            sourceCwd,
            executionCwd: threadFolders.get(args.threadId),
            baseSha: null,
            commonGitDir: null,
            state: "direct",
            reason: "legacy_or_direct",
          };
        }
      }
      const concurrent = requests.get(key);
      if (concurrent) {
        if (workspace.id) await worktreeManager.abandon(workspace.id);
        if (concurrent.fingerprint !== fingerprint) throw callError("request_conflict", "requestId already belongs to different arguments");
        renewJobLease(concurrent);
        return toolResult(message.id, snapshot(concurrent));
      }
      const cwd = workspace.executionCwd;
      const startNow = canRunFolder(cwd);
      if (!startNow && jobQueue.length >= MAX_QUEUE) {
        if (workspace.id) await worktreeManager.abandon(workspace.id);
        throw callError("queue_full", `Local Codex queue is full (${MAX_QUEUE}); retry with the same requestId after another job finishes`);
      }
      const job = {
        jobId, requestKey: key, fingerprint, tool: name, cwd, sourceCwd,
        workspaceKind: workspace.id ? "worktree" : "direct",
        worktreeId: workspace.id, worktreeState: workspace.state,
        worktreeReason: workspace.reason ?? null, baseSha: workspace.baseSha ?? null,
        gitCommonDir: workspace.commonGitDir ?? null,
        status: startNow ? "starting" : "queued", threadId: args.threadId ?? null, turnId: null,
        model: null, reasoningEffort: null, networkAccess, browserAccess,
        browserBackend: browserAccess ? "official_codex" : "none", browserTurnMetadata, settingsStatus: "pending",
        sourceTitle, codexThreadName,
        startedAt: Date.now(), updatedAt: Date.now(), eventSeq: 0,
        pollLeaseMs: POLL_LEASE_MS, leaseExpiresAt: Date.now() + POLL_LEASE_MS,
      };
      // Acceptance is durable before work is started or queued. Visible prompts
      // and activity may also be persisted in the private Guard/job-event stream;
      // restart recovery still marks queued/running work interrupted rather than replaying it.
      try { persistJob(job); }
      catch (error) {
        if (workspace.id) await worktreeManager.abandon(workspace.id);
        throw error;
      }
      jobs.set(job.jobId, job);
      requests.set(key, job);
      job.done = new Promise(resolve => { job.resolveDone = resolve; });
      job.waiting = new Set();
      job.eventWaiting = new Set();
      job.runtimeArgs = args;
      scheduleJobLease(job);
      logCall("job_accepted", job);
      if (startNow) activateJob(job, false);
      else {
        jobQueue.push(job);
        logCall("job_queued", job);
      }
      return toolResult(message.id, snapshot(job));
    }
    if (name === "codex-status" || name === "codex-cancel") {
      validateArguments(args, name === "codex-status" ? ["jobId", "waitMs", "afterEventSeq", "eventLimit"] : ["jobId"]);
      assertIdentifier(args.jobId, "jobId");
      const job = jobs.get(args.jobId);
      if (!job) throw callError("unknown_job", "Unknown jobId; no work was started");
      if (name === "codex-cancel") {
        cancelJob(job, "cancelled");
        return toolResult(message.id, snapshot(job));
      }
      const waitMs = args.waitMs ?? 0;
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 20000) {
        throw callError("invalid_wait", "waitMs must be an integer between 0 and 20000");
      }
      const wantsEvents = args.afterEventSeq !== undefined || args.eventLimit !== undefined;
      if (wantsEvents) {
        const afterEventSeq = args.afterEventSeq ?? 0;
        const eventLimit = args.eventLimit ?? 50;
        if (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0) {
          throw callError("invalid_event_cursor", "afterEventSeq must be a non-negative integer");
        }
        if (!Number.isInteger(eventLimit) || eventLimit < 1 || eventLimit > 100) {
          throw callError("invalid_event_limit", "eventLimit must be an integer between 1 and 100");
        }
        renewJobLease(job);
        await waitForJobEvents(job, afterEventSeq, waitMs, message.id, signal);
        return toolResult(message.id, { ...snapshot(job), ...(await eventSnapshot(job, afterEventSeq, eventLimit)) });
      }
      renewJobLease(job);
      await waitForJob(job, waitMs, message.id, signal);
      return toolResult(message.id, snapshot(job));
    }
    return rpcError(message.id, -32602, "unknown tool");
  } catch (error) {
    const errorCode = error.callCode || "invalid_request";
    logCall("call_rejected", { tool: tools.some(tool => tool.name === name) ? name : "unknown", status: "rejected", startedAt: Date.now() }, errorCode);
    return toolResult(message.id, { status: "error", errorCode, message: safeError(error),
      ...(errorCode === "schema_outdated" ? { adapterVersion: VERSION, schemaFingerprint: SCHEMA_FINGERPRINT } : {}),
    }, true);
  }
}

async function handleBrowserMcpMessage(message, session, signal) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id ?? null, -32600, "invalid request");
  }
  if (!("id" in message)) return null;
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0", id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "local-codex-official-browser", title: "Local Codex Official Browser", version: VERSION },
      },
    };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: browserMcpTools } };
  if (message.method !== "tools/call") return rpcError(message.id, -32601, `method not found: ${message.method}`);
  if (signal?.aborted) return browserMcpToolResult(message.id, [{ type: "text", text: "Official Browser request cancelled" }], true);

  const name = message.params?.name;
  if (typeof name !== "string" || !name.startsWith("official_browser_")) {
    return browserMcpToolResult(message.id, [{ type: "text", text: "Unknown official Browser tool" }], true);
  }
  const action = name.slice("official_browser_".length);
  const task = async () => {
    logCall("browser_tool_requested", session.audit);
    try {
      const broker = await getBrowserSessionBroker(session);
      const result = await broker.execute(action, message.params?.arguments || {}, session.turnMetadata);
      logCall("browser_tool_completed", session.audit);
      return browserMcpToolResult(message.id, Array.isArray(result?.content) ? result.content : [], result?.isError === true, result?._meta);
    } catch (error) {
      logCall("browser_tool_failed", session.audit, error?.callCode || "browser_runtime_unavailable");
      const text = error?.callCode === "browser_tool_invalid" ? error.message : "Official Browser operation failed";
      return browserMcpToolResult(message.id, [{ type: "text", text }], true);
    }
  };
  const result = session.operation.then(task, task);
  session.operation = result.then(() => undefined, () => undefined);
  return result;
}

async function createBrowserSocketSession(audit) {
  const token = randomUUID();
  const socketPath = resolve(audit.cwd, `.lcb-${token.slice(0, 12)}.sock`);
  if (Buffer.byteLength(socketPath) > 100) {
    throw callError("browser_transport_unavailable", "The selected workspace path is too long for the private Browser socket; no model turn was started.");
  }
  const session = {
    token,
    socketPath,
    socketServer: null,
    connections: new Set(),
    jobId: audit.jobId,
    cwd: audit.cwd,
    turnMetadata: audit.browserTurnMetadata,
    audit,
    brokerPromise: null,
    operation: Promise.resolve(),
  };
  try { await rm(socketPath, { force: true }); } catch {}
  const socketServer = createNetServer(socket => {
    session.connections.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { socket.destroy(); return; }
        if (!authenticated) {
          if (message?.token !== token) { socket.destroy(); return; }
          authenticated = true;
          continue;
        }
        void handleBrowserMcpMessage(message, session).then(response => {
          if (response && !socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
        }).catch(() => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(rpcError(message?.id ?? null, -32603, "Official Browser operation failed"))}\n`);
        });
      }
    });
    socket.on("close", () => session.connections.delete(socket));
    socket.on("error", () => session.connections.delete(socket));
  });
  session.socketServer = socketServer;
  await new Promise((resolvePromise, rejectPromise) => {
    socketServer.once("error", rejectPromise);
    socketServer.listen(socketPath, () => {
      socketServer.removeListener("error", rejectPromise);
      resolvePromise();
    });
  }).catch(async () => {
    try { await rm(socketPath, { force: true }); } catch {}
    throw callError("browser_transport_unavailable", "Unable to create the private Browser socket inside the selected workspace; no model turn was started.");
  });
  try { await chmod(socketPath, 0o600); }
  catch {
    socketServer.close();
    try { await rm(socketPath, { force: true }); } catch {}
    throw callError("browser_transport_unavailable", "Unable to protect the private Browser socket; no model turn was started.");
  }
  browserSessions.set(token, session);
  return session;
}

function getBrowserSessionBroker(session) {
  session.brokerPromise ??= createOfficialBrowserBroker({ cwd: session.cwd, codexBin: CODEX_BIN, adapterVersion: VERSION })
    .then(broker => {
      logCall("browser_broker_ready", session.audit);
      return broker;
    }, error => {
      logCall("browser_broker_failed", session.audit, error?.callCode || "browser_runtime_unavailable");
      throw error;
    });
  return session.brokerPromise;
}

async function disposeBrowserSession(session) {
  browserSessions.delete(session.token);
  for (const connection of session.connections || []) connection.destroy();
  if (session.socketServer?.listening) {
    await new Promise(resolvePromise => session.socketServer.close(resolvePromise));
  }
  try { await rm(session.socketPath, { force: true }); } catch {}
  if (!session.brokerPromise) return;
  try {
    await Promise.race([
      session.brokerPromise.then(broker => broker.close()),
      new Promise(resolvePromise => setTimeout(resolvePromise, 2000)),
    ]);
  } catch {}
}

function browserMcpToolResult(id, content, isError, meta) {
  return {
    jsonrpc: "2.0", id,
    result: {
      content,
      ...(isError ? { isError: true } : {}),
      ...(meta && typeof meta === "object" ? { _meta: meta } : {}),
    },
  };
}

function canRunFolder(cwd) {
  return activeJobs.size < MAX_CONCURRENCY && !activeFolders.has(cwd);
}

function scheduleJobLease(job) {
  clearTimeout(job.leaseTimer);
  delete job.leaseTimer;
  if (terminalStatuses.has(job.status) || job.stopReason || job.cleanupStarted || !job.leaseExpiresAt) return;
  const remaining = Math.max(0, job.leaseExpiresAt - Date.now());
  job.leaseTimer = setTimeout(() => {
    delete job.leaseTimer;
    if (terminalStatuses.has(job.status) || job.stopReason || job.cleanupStarted) return;
    logCall("job_polling_expired", job, "polling_expired");
    try {
      cancelJob(job, "cancelled", {
        errorCode: "polling_expired",
        message: `Job cancelled because codex-status was not polled within ${POLL_LEASE_MS} milliseconds`,
      });
    } catch {
      storageHealthy = false;
    }
  }, remaining);
  job.leaseTimer.unref();
}

function renewJobLease(job) {
  if (terminalStatuses.has(job.status) || job.stopReason || job.cleanupStarted) return;
  job.pollLeaseMs = POLL_LEASE_MS;
  job.leaseExpiresAt = Date.now() + POLL_LEASE_MS;
  persistJob(job);
  scheduleJobLease(job);
}

function clearJobLease(job) {
  clearTimeout(job.leaseTimer);
  delete job.leaseTimer;
  delete job.leaseExpiresAt;
}

function activateJob(job, updatePersistentStatus = true) {
  if (shuttingDown || terminalStatuses.has(job.status) || job.stopReason) return;
  if (!canRunFolder(job.cwd)) {
    if (!jobQueue.includes(job)) jobQueue.push(job);
    if (job.status !== "queued") {
      job.status = "queued";
      persistJob(job);
      logCall("job_queued", job);
    }
    return;
  }
  if (updatePersistentStatus) {
    job.status = "starting";
    persistJob(job);
  }
  activeJobs.set(job.jobId, job);
  activeFolders.add(job.cwd);
  logCall("job_started", job);
  setImmediate(() => { void executeJob(job, job.runtimeArgs); });
}

function scheduleJobs() {
  if (shuttingDown || !storageHealthy || !runtimeHealthy) return;
  while (activeJobs.size < MAX_CONCURRENCY) {
    const index = jobQueue.findIndex(job => job.status === "queued" && !activeFolders.has(job.cwd));
    if (index < 0) return;
    const [job] = jobQueue.splice(index, 1);
    if (terminalStatuses.has(job.status) || job.stopReason) continue;
    try {
      activateJob(job, true);
    } catch (error) {
      storageHealthy = false;
      job.status = "failed";
      job.errorCode = error.callCode || "storage_error";
      job.message = safeError(error);
      job.finishedAt = Date.now();
      logCall("job_failed", job, job.errorCode);
      settleJob(job);
      return;
    }
  }
}

async function executeJob(job, args) {
  try {
    if (job.stopReason) throw callError(job.stopReason, "Job stopped before execution");
    if (job.worktreeId) {
      let workspace;
      try { workspace = await worktreeManager.prepare(job.worktreeId); }
      catch (error) { throw callError(error.code || "worktree_create_failed", error.message); }
      job.cwd = workspace.executionCwd;
      job.sourceCwd = workspace.sourceCwd;
      job.worktreeState = workspace.state;
      job.baseSha = workspace.baseSha;
      job.gitCommonDir = workspace.commonGitDir;
      persistJob(job);
    }
    await verifyPinnedDirectory(job.cwd);
    if (job.stopReason) throw callError(job.stopReason, "Job stopped before execution");
    job.status = "running";
    persistJob(job);
    const result = await runCodex(args, job.threadId, job);
    job.content = result.content;
    job.status = "completed";
  } catch (error) {
    if (error.callCode === "process_cleanup_failed") {
      job.status = "failed";
      job.errorCode = error.callCode;
      job.message = safeError(error);
    } else {
      job.status = job.stopReason || (error.callCode === "timeout" ? "timed_out" : "failed");
      job.errorCode ||= error.callCode || "job_failed";
      job.message ||= safeError(error);
    }
  } finally {
    clearJobLease(job);
    job.finishedAt = Date.now();
    try { persistJob(job); } catch { storageHealthy = false; }
    logCall(`job_${job.status}`, job, job.errorCode);
    activeJobs.delete(job.jobId);
    activeFolders.delete(job.cwd);
    settleJob(job);
    scheduleJobs();
    setImmediate(() => {
      void pruneManagedWorktrees().catch(() => {
        process.stderr.write("local-codex-adapter worktree pruning deferred\n");
      });
    });
  }
}

async function pruneManagedWorktrees() {
  const protectedIds = new Set(
    [...activeJobs.values(), ...jobQueue]
      .map(job => job.worktreeId)
      .filter(Boolean)
  );
  const pruned = await worktreeManager.prune(protectedIds);
  if (!pruned.length) return;
  for (const record of pruned) {
    for (const job of jobs.values()) {
      if (job.worktreeId !== record.id) continue;
      job.worktreeState = record.state;
      try { persistJob(job); } catch { storageHealthy = false; }
    }
  }
}

function cancelJob(job, reason, details = {}) {
  if (terminalStatuses.has(job.status) || job.stopReason) return;
  clearJobLease(job);
  if (job.status === "queued") {
    job.stopReason = reason;
    job.status = reason;
    job.errorCode = details.errorCode || reason;
    job.message = details.message || (reason === "cancelled" ? "Job cancelled before execution" : "Job interrupted before execution");
    job.finishedAt = Date.now();
    const index = jobQueue.indexOf(job);
    if (index >= 0) jobQueue.splice(index, 1);
    if (job.worktreeId) void worktreeManager.abandon(job.worktreeId);
    try { persistJob(job); }
    finally {
      logCall(`job_${job.status}`, job, job.errorCode);
      settleJob(job);
      scheduleJobs();
    }
    return;
  }
  job.stopReason = reason;
  job.status = "cancelling";
  job.errorCode = details.errorCode || job.errorCode;
  job.message = details.message || job.message;
  // Cancellation must still stop the child if the disk is full.
  try { persistJob(job); } finally { job.stop?.(reason); }
  logCall("job_cancelling", job);
}

function settleJob(job) {
  clearJobLease(job);
  for (const finish of job.waiting || []) finish();
  for (const finish of job.eventWaiting || []) finish();
  job.resolveDone?.();
}

function snapshot(job) {
  return {
    jobId: job.jobId, status: job.status, cwd: job.cwd, threadId: job.threadId, turnId: job.turnId,
    sourceCwd: job.sourceCwd || job.cwd,
    workspaceKind: job.workspaceKind || "direct",
    ...(job.worktreeId ? { worktreeId: job.worktreeId, worktreeState: job.worktreeState || "planned" } : {}),
    ...(job.worktreeReason ? { worktreeReason: job.worktreeReason } : {}),
    ...(job.baseSha ? { baseSha: job.baseSha } : {}),
    model: job.model, reasoningEffort: job.reasoningEffort,
    ...(job.sourceTitle ? { sourceTitle: job.sourceTitle } : {}),
    ...(job.codexThreadName ? { codexThreadName: job.codexThreadName } : {}),
    networkAccess: job.networkAccess ?? false, browserAccess: job.browserAccess ?? false,
    browserBackend: job.browserBackend ?? (job.browserAccess ? "official_codex" : "none"),
    startedAt: job.startedAt, updatedAt: job.updatedAt,
    pollLeaseMs: job.pollLeaseMs ?? POLL_LEASE_MS,
    ...(job.leaseExpiresAt ? { leaseExpiresAt: job.leaseExpiresAt } : {}),
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.content !== undefined ? { content: job.content } : {}),
    ...(job.environmentErrorCode ? { environmentErrorCode: job.environmentErrorCode, environmentMessage: job.environmentMessage } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode, message: job.message } : {}),
  };
}

function persistJob(job) {
  job.updatedAt = Date.now();
  const record = { ...snapshot(job), requestKey: job.requestKey, fingerprint: job.fingerprint,
    tool: job.tool, settingsStatus: job.settingsStatus,
    ...(job.gitCommonDir ? { gitCommonDir: job.gitCommonDir } : {}) };
  const target = resolve(JOBS_DIR, `${job.jobId}.json`);
  writePrivateJson(target, record);
}

function writePrivateJson(target, record) {
  const temporary = `${target}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "w", 0o600);
    writeFileSync(fd, JSON.stringify(record) + "\n");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, target);
    fd = openSync(dirname(target), "r");
    fsyncSync(fd);
  } catch {
    storageHealthy = false;
    throw callError("storage_error", "Unable to save job state; refusing new work");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function loadJobs() {
  for (const file of await readdir(JOBS_DIR)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
    const job = JSON.parse(await readFile(resolve(JOBS_DIR, file), "utf8"));
    if (`${job.jobId}.json` !== file || !/^[a-f0-9]{64}$/.test(job.requestKey) ||
        !/^[a-f0-9]{64}$/.test(job.fingerprint) || requests.has(job.requestKey)) {
      throw new Error("Invalid job record");
    }
    if (job.cwd === undefined) {
      job.cwd = await legacyCwd();
      writePrivateJson(resolve(JOBS_DIR, file), job); // Keep original fingerprint, answer, and timestamps.
    }
    if (typeof job.cwd !== "string" || !isAbsolute(job.cwd)) throw new Error("Invalid job folder");
    if (job.sourceCwd === undefined) job.sourceCwd = job.cwd;
    if (typeof job.sourceCwd !== "string" || !isAbsolute(job.sourceCwd)) throw new Error("Invalid job source folder");
    if (job.workspaceKind === undefined) job.workspaceKind = "direct";
    if (!["direct", "worktree"].includes(job.workspaceKind)) throw new Error("Invalid job workspace kind");
    if (job.worktreeId !== undefined && job.worktreeId !== null) {
      const record = worktreeManager.get(job.worktreeId);
      if (!record || record.executionCwd !== job.cwd) throw new Error("Invalid job worktree state");
      job.worktreeState = record.state;
      job.gitCommonDir = record.commonGitDir;
    } else {
      job.worktreeId = null;
      job.worktreeState = "direct";
      job.gitCommonDir = null;
    }
    if (job.networkAccess === undefined) job.networkAccess = false;
    if (typeof job.networkAccess !== "boolean") throw new Error("Invalid job network setting");
    if (job.browserAccess === undefined) job.browserAccess = false;
    if (typeof job.browserAccess !== "boolean") throw new Error("Invalid job browser setting");
    if (job.browserBackend === undefined) job.browserBackend = job.browserAccess ? "official_codex" : "none";
    if (!["none", "official_codex"].includes(job.browserBackend)) throw new Error("Invalid job browser backend");
    if (job.sourceTitle !== undefined) job.sourceTitle = validatePersistedTitle(job.sourceTitle, "job source title");
    if (job.codexThreadName !== undefined) job.codexThreadName = validatePersistedTitle(job.codexThreadName, "job Codex thread name");
    if (job.threadId && threadFolders.has(job.threadId) && threadFolders.get(job.threadId) !== job.cwd) {
      throw new Error("Job and thread folder mismatch");
    }
    if (job.threadId && job.sourceTitle && !threadSourceTitles.has(job.threadId)) {
      threadSourceTitles.set(job.threadId, job.sourceTitle);
    }
    if (job.threadId && job.codexThreadName && !threadCodexNames.has(job.threadId)) {
      threadCodexNames.set(job.threadId, job.codexThreadName);
    }
    job.eventSeq = await loadEventSeq(job.jobId);
    job.eventWaiting = new Set();
    clearJobLease(job);
    if (!terminalStatuses.has(job.status)) {
      job.status = "interrupted";
      job.errorCode = "adapter_restarted";
      job.message = "Adapter restarted before completion. Work was not replayed; inspect the thread before requesting new work.";
      job.finishedAt = Date.now();
      persistJob(job);
    }
    if (job.worktreeId) {
      const record = worktreeManager.get(job.worktreeId);
      if (terminalStatuses.has(job.status) && record && ["planned", "creating", "failed"].includes(record.state)) {
        await worktreeManager.abandon(job.worktreeId);
        job.worktreeId = null;
        job.workspaceKind = "direct";
        job.worktreeState = "direct";
        job.cwd = job.sourceCwd;
        persistJob(job);
      }
    }
    jobs.set(job.jobId, job);
    requests.set(job.requestKey, job);
  }
}

function waitForJob(job, waitMs, id, signal) {
  if (!waitMs || terminalStatuses.has(job.status) || signal?.aborted) return;
  const controller = new AbortController();
  const key = rpcKey(id);
  const group = waiters.get(key) || new Set();
  waiters.set(key, group);
  group.add(controller);
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", finish);
      signal?.removeEventListener("abort", finish);
      group.delete(controller);
      if (!group.size) waiters.delete(key);
      job.waiting?.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    controller.signal.addEventListener("abort", finish, { once: true });
    signal?.addEventListener("abort", finish, { once: true });
    job.waiting?.add(finish);
  });
}

function waitForJobEvents(job, afterEventSeq, waitMs, id, signal) {
  if (!waitMs || (job.eventSeq ?? 0) > afterEventSeq || terminalStatuses.has(job.status) || signal?.aborted) return;
  const controller = new AbortController();
  const key = rpcKey(id);
  const group = waiters.get(key) || new Set();
  waiters.set(key, group);
  group.add(controller);
  job.eventWaiting ??= new Set();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", finish);
      signal?.removeEventListener("abort", finish);
      group.delete(controller);
      if (!group.size) waiters.delete(key);
      job.eventWaiting?.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    controller.signal.addEventListener("abort", finish, { once: true });
    signal?.addEventListener("abort", finish, { once: true });
    job.eventWaiting.add(finish);
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const closed = new Promise(resolve => server.close(resolve));
  for (const group of waiters.values()) for (const waiter of group) waiter.abort();
  for (const job of [...jobQueue]) {
    try { cancelJob(job, "interrupted"); } catch { /* best effort; shutdown still proceeds */ }
  }
  const active = [...activeJobs.values()];
  for (const job of active) {
    try { cancelJob(job, "interrupted"); } catch { /* stop is called even on storage failure */ }
  }
  await Promise.all(active.map(job => job.done));
  server.closeAllConnections();
  await closed;
  process.exit(storageHealthy && runtimeHealthy ? 0 : 1);
}

async function canonicalDirectory(value, label = "path") {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0") || !isAbsolute(value)) {
    throw callError("invalid_directory", `${label} must be an absolute path to an existing directory. Refresh Local Codex tools if cwd is missing.`);
  }
  try {
    const canonical = await realpath(value);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Not a directory");
    return canonical;
  } catch {
    throw callError("invalid_directory", `${label} is not an accessible existing directory; no work was started`);
  }
}

async function verifyPinnedDirectory(cwd) {
  if (await canonicalDirectory(cwd, "cwd") !== cwd) {
    throw callError("folder_changed", "The saved folder now resolves elsewhere. Start a new thread with an explicit cwd; access was not widened.");
  }
}

async function listFolders(args) {
  const path = await canonicalDirectory(args.path ?? homedir());
  let after = null;
  if (args.cursor !== undefined) {
    try {
      if (typeof args.cursor !== "string" || !args.cursor || args.cursor.length > 8192) throw new Error();
      const cursor = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8"));
      if (cursor.pathHash !== digest(path) || typeof cursor.after !== "string" || !cursor.after || cursor.after.includes("/") || cursor.after.includes("\0")) throw new Error();
      after = cursor.after;
    } catch { throw callError("invalid_cursor", "Invalid directory cursor; use nextCursor with the same path"); }
  }
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch { throw callError("directory_unreadable", "Cannot list this directory"); }
  const directories = [];
  // Inspect only directory metadata; never open child file contents.
  for (const entry of entries) {
    if (entry.isDirectory()) directories.push(entry.name);
    else if (entry.isSymbolicLink()) {
      try { if ((await stat(resolve(path, entry.name))).isDirectory()) directories.push(entry.name); }
      catch { /* omit broken or inaccessible symlinks */ }
    }
  }
  const remaining = directories.sort().filter(name => after === null || name > after);
  const page = remaining.slice(0, 100);
  const nextCursor = remaining.length > 100
    ? Buffer.from(JSON.stringify({ pathHash: digest(path), after: page.at(-1) })).toString("base64url") : null;
  return { status: "ok", path, directories: page, nextCursor };
}

function folderSchema() {
  return { type: "object", additionalProperties: false, properties: {
    status: { type: "string", enum: ["ok", "error"] },
    path: { type: "string" }, directories: { type: "array", items: { type: "string" }, maxItems: 100 },
    nextCursor: { type: ["string", "null"] }, errorCode: { type: "string" }, message: { type: "string" },
  }, required: ["status"] };
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function rpcKey(id) { return JSON.stringify([typeof id, id]); }
function assertIdentifier(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw callError("invalid_request", `${name} must be a non-empty string no longer than 200 characters`);
  }
}
function validateArguments(args, keys) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => !keys.includes(k))) {
    throw callError("invalid_request", "Unexpected tool arguments");
  }
}

function extractBrowserTurnMetadata(meta) {
  let value = meta?.["x-codex-turn-metadata"];
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.session_id !== "string" || typeof value.turn_id !== "string") return null;
  return {
    session_id: value.session_id,
    turn_id: value.turn_id,
    thread_id: typeof value.thread_id === "string" ? value.thread_id : value.session_id,
    thread_source: typeof value.thread_source === "string" ? value.thread_source : "user",
    ...(typeof value.model === "string" ? { model: value.model } : {}),
  };
}

async function runCodex(args, existingThreadId, audit) {
  if (audit.browserAccess) {
    let probe;
    try {
      probe = await probeBrowserBackend({ cwd: audit.cwd, codexBin: CODEX_BIN, adapterVersion: VERSION });
    } catch {
      throw callError("browser_runtime_unavailable", "The official Codex Browser runtime probe failed; no model turn was started.");
    }
    if (probe.officialBrowserBackend !== "available") {
      const errorCode = probe.officialBrowserBackend === "policy_blocked" ? "browser_policy_blocked"
        : probe.officialBrowserBackend === "plugin_disabled" ? "browser_plugin_unavailable"
          : probe.probeSupport?.browserRuntimeSetup === "unsupported" || probe.probeSupport?.mcpServerStatus !== "ok"
            ? "browser_transport_unavailable"
          : "browser_runtime_unavailable";
      throw callError(errorCode, `${probe.message} No model turn was started.`);
    }
    audit.browserBackend = "official_codex";
    logCall("browser_backend_selected", audit);
  }
  const browserSession = audit.browserAccess ? await createBrowserSocketSession(audit) : null;
  return new Promise((resolvePromise, rejectPromise) => {
    const cwd = audit.cwd;
    const appServerArgs = [
      "app-server", "--listen", "stdio://", "-c", permissionConfig(cwd, audit.networkAccess, audit.gitCommonDir),
      "-c", "mcp_servers.node_repl.enabled=false",
      "-c", "mcp_servers.playwright.enabled=false",
    ];
    if (audit.browserAccess) {
      appServerArgs.push(
        "-c", `mcp_servers.local_codex_browser.command=${JSON.stringify(process.execPath)}`,
        "-c", `mcp_servers.local_codex_browser.args=${JSON.stringify([BROWSER_PROXY_PATH, "--socket", browserSession.socketPath, "--token", browserSession.token])}`,
      );
    }
    const child = spawn(CODEX_BIN, appServerArgs, {
      cwd,
      detached: process.platform !== "win32",
      // Do not forward raw app-server stderr to the shared audit log.
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env },
    });
    let stdoutBuffer = "";
    let threadId = existingThreadId;
    let turnId = null;
    const messages = new Map();
    let settled = false;
    let selected;
    let turnSubmitted = false;
    let turnConfirmed = false;
    let turnCompleted = false;
    let finalMetadataRequested = false;
    let requestSequence = 0;
    const pending = new Map();
    let interruptTimer;
    let exited = false;
    let progressAt = 0;

    const timer = setTimeout(() => {
      try { cancelJob(audit, "timed_out"); } catch { /* cancellation still stops the child */ }
    }, CALL_TIMEOUT_MS);
    timer.unref();

    child.on("error", () => finish(callError("spawn_failed", "Unable to start Codex app-server")));
    child.on("exit", code => {
      exited = true;
      if (!settled) finish(callError("server_exit", `Codex app-server exited with code ${code}`));
    });
    child.stdin.on("error", () => finish(callError("server_pipe", "Codex connection closed")));
    child.stdout.on("data", chunk => {
      stdoutBuffer += chunk.toString();
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error("Codex app-server returned invalid JSON"));
          return;
        }
        try { onMessage(message); } catch (error) { finish(error); }
      }
    });

    audit.stop = reason => {
      const error = callError(reason, reason === "timed_out" ? "Codex job reached its execution limit" : "Codex job interrupted");
      if (settled) return;
      if (threadId && turnId) {
        // Wait briefly for turn/completed, then fall back to terminating the process group.
        interruptTimer = setTimeout(() => finish(error), 1000);
        void request("turn/interrupt", { threadId, turnId }).catch(() => finish(error));
      } else finish(error);
    };
    if (audit.stopReason) audit.stop(audit.stopReason);
    else void start();

    async function start() {
      try {
        await request("initialize", {
          clientInfo: { name: "local_codex_tunnel", title: "Local Codex Tunnel", version: VERSION },
          capabilities: { experimentalApi: true },
        });
        send({ method: "initialized", params: {} });
        const models = await listModels();
        // Existing Codex history owns model/reasoning reply defaults. The
        // adapter separately pins bridge capabilities because each app-server
        // process receives a job-scoped permission profile/environment.
        const prior = existingThreadId
          ? await request("thread/resume", threadParams(cwd, audit.networkAccess, audit.browserAccess, existingThreadId))
          : DEFAULT_SETTINGS;
        selected = selectSettings(args, prior, models);
        Object.assign(audit, selected, { settingsStatus: "requested" });
        logCall("settings_requested", audit);

        const threadResponse = existingThreadId
          ? prior
          : await request("thread/start", threadParams(cwd, audit.networkAccess, audit.browserAccess, null, selected));
        if (threadResponse?.thread?.cwd && threadResponse.thread.cwd !== cwd) {
          throw callError("folder_mismatch", "Codex returned a different thread folder; no turn was started");
        }
        threadId = threadResponse?.thread?.id || threadId;
        if (!threadId) throw new Error("Codex did not return a thread id");
        audit.threadId = threadId;
        if (audit.browserAccess) logCall("browser_backend_ready", audit);
        threadFolders.set(threadId, cwd);
        threadSourceCwds.set(threadId, audit.sourceCwd || cwd);
        threadWorkspaceKinds.set(threadId, audit.workspaceKind || "direct");
        if (audit.worktreeId) {
          threadWorktreeIds.set(threadId, audit.worktreeId);
          const bound = await worktreeManager.bindThread(audit.worktreeId, threadId);
          audit.worktreeState = bound.state;
        }
        threadNetworkAccess.set(threadId, audit.networkAccess);
        threadBrowserAccess.set(threadId, audit.browserAccess ?? false);
        if (audit.sourceTitle) threadSourceTitles.set(threadId, audit.sourceTitle);
        updateCodexThreadName(audit, threadResponse?.thread?.name);
        saveThreadState();
        persistJob(audit);
        if (!existingThreadId) confirmSettings(threadResponse.model, threadResponse.reasoningEffort);
        turnSubmitted = true;
        const turnResponse = await request("turn/start", turnParams(cwd, threadId, args.prompt, selected, audit.browserAccess));
        turnId = turnResponse?.turn?.id || turnId;
        audit.turnId = turnId;
        persistJob(audit);
        // Re-resuming a loaded thread does not apply overrides, but reports its
        // effective settings. turn/start is what actually changes reply settings.
        // A fresh rollout may not yet be flushed to disk and cannot be resumed
        // immediately. Its thread/start response already confirmed both fields.
        if (existingThreadId) {
          const effective = await request("thread/resume", threadParams(cwd, audit.networkAccess, audit.browserAccess, threadId));
          updateCodexThreadName(audit, effective?.thread?.name);
          confirmSettings(effective.model, effective.reasoningEffort);
        }
        turnConfirmed = true;
        completeIfReady();
      } catch (error) {
        finish(error);
      }
    }

    function onMessage(message) {
      if (settled) return;
      if (message?.method === "localCodex/visibleEvent") {
        recordBridgeEvent(audit, message.params?.event);
        return;
      }
      if (message.id !== undefined && pending.has(String(message.id))) {
        const entry = pending.get(String(message.id));
        pending.delete(String(message.id));
        if (message.error) {
          const error = callError("server_request_failed", `Codex app-server rejected ${entry.method}`);
          error.rpcCode = message.error?.code;
          entry.reject(error);
        }
        else entry.resolve(message.result);
        return;
      }
      const method = message.method;
      const params = message.params || {};
      if (params.threadId && threadId && params.threadId !== threadId) return;
      if (method === "thread/name/updated") {
        updateCodexThreadName(audit, params.name ?? params.thread?.name);
      }
      if (method === "turn/started") {
        turnId = params.turn?.id || params.turnId || turnId;
        audit.turnId = turnId;
        persistJob(audit);
        logCall("turn_started", audit);
        if (!existingThreadId && selected) logCall("settings_confirmed", audit);
      }
      if (method === "thread/settings/updated" && turnSubmitted && selected) {
        try {
          confirmSettings(params.threadSettings?.model, params.threadSettings?.effort);
        } catch (error) {
          finish(error);
        }
      }
      if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
        const key = params.itemId || "delta";
        const prior = messages.get(key) || { text: "", phase: null };
        prior.text += params.delta;
        messages.set(key, prior);
      }
      if (method === "item/completed") {
        const item = params.item || {};
        if (item.type === "agentMessage" || item.type === "AgentMessage") {
          messages.set(item.id || "delta", { text: extractText(item), phase: item.phase });
        }
      }
      if (typeof method === "string" && method.startsWith("item/") && Date.now() - progressAt >= 10000) {
        progressAt = Date.now();
        logCall("job_progress", audit);
      }
      if (method === "turn/completed") {
        const completed = params.turn || params;
        if (!turnId || !completed.id || completed.id === turnId) {
          const status = completed.status || "completed";
          if (audit.stopReason) {
            finish(callError(audit.stopReason, "Codex job interrupted"));
          } else if (status !== "completed") {
            finish(callError("turn_failed", `Codex turn did not complete successfully`));
          } else {
            turnCompleted = true;
            completeIfReady();
          }
        }
      }
    }

    function request(method, params) {
      return new Promise((resolve, reject) => {
        if (settled) return reject(callError("call_ended", "Codex call already ended"));
        const id = ++requestSequence;
        pending.set(String(id), { resolve, reject, method });
        send({ method, id, params });
      });
    }

    function completeIfReady() {
      if (!turnCompleted || !turnConfirmed || finalMetadataRequested) return;
      finalMetadataRequested = true;
      void refreshFinalMetadata().finally(() => {
        if (settled) return;
        const values = [...messages.values()];
        const final = values.filter(item => item.phase === "final_answer");
        finish(null, { threadId, content: (final.length ? final : values).map(item => item.text).join("\n").trim() });
      });
    }

    async function refreshFinalMetadata() {
      try {
        const result = await Promise.race([
          request("thread/read", { threadId, includeTurns: false }),
          new Promise(resolve => {
            const timeout = setTimeout(() => resolve(null), 300);
            timeout.unref();
          }),
        ]);
        updateCodexThreadName(audit, result?.thread?.name);
      } catch {
        // Older App Servers may not support thread/read. The visible prompt
        // remains an honest fallback and job completion must not depend on a title.
      }
    }

    function send(value) {
      if (!settled && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`);
    }

    async function listModels() {
      const models = [];
      const cursors = new Set();
      let cursor;
      do {
        const page = await request("model/list", { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page?.data)) throw callError("catalog_invalid", "Codex returned an invalid model catalog");
        models.push(...page.data);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw callError("catalog_invalid", "Codex model catalog pagination repeated");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return models;
    }

    function confirmSettings(model, reasoningEffort) {
      if (model !== selected.model || reasoningEffort !== selected.reasoningEffort) {
        audit.settingsStatus = "mismatch";
        throw callError("settings_mismatch", "Codex did not confirm the selected model and reasoning level; no fallback is allowed");
      }
      Object.assign(audit, { model, reasoningEffort, settingsStatus: "confirmed" });
      persistJob(audit);
      logCall("settings_confirmed", audit);
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      audit.cleanupStarted = true;
      clearJobLease(audit);
      clearTimeout(timer);
      clearTimeout(interruptTimer);
      delete audit.stop;
      for (const entry of pending.values()) entry.reject(error || new Error("Codex call ended"));
      pending.clear();
      signalChild("SIGTERM");
      void finishAfterCleanup(error, value);
    }

    async function finishAfterCleanup(error, value) {
      let finalError = error;
      let gone = false;
      try {
        gone = await waitForProcessGroupExit(PROCESS_TERM_GRACE_MS);
        if (!gone) {
          signalChild("SIGKILL");
          gone = await waitForProcessGroupExit(PROCESS_KILL_VERIFY_MS);
        }
      } catch {
        gone = false;
      }
      if (!gone) {
        runtimeHealthy = false;
        finalError = callError("process_cleanup_failed", "Codex process-group cleanup could not be verified; the adapter is unavailable until restarted");
        logCall("job_cleanup_failed", audit, finalError.callCode);
      }
      try {
        if (browserSession) await disposeBrowserSession(browserSession);
      } catch {
        if (!finalError) finalError = callError("browser_cleanup_failed", "Official Browser cleanup failed");
      }
      delete audit.cleanupStarted;
      if (finalError) rejectPromise(finalError);
      else resolvePromise(value);
    }

    async function waitForProcessGroupExit(waitMs) {
      if (!child.pid) return true;
      const deadline = Date.now() + waitMs;
      for (;;) {
        if (process.platform === "win32") {
          if (exited || child.exitCode !== null || child.signalCode !== null) return true;
        } else {
          try {
            process.kill(-child.pid, 0);
          } catch (error) {
            if (error.code === "ESRCH") return true;
            if (error.code !== "EPERM") throw error;
          }
        }
        if (Date.now() >= deadline) return false;
        await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(PROCESS_CHECK_INTERVAL_MS, deadline - Date.now())));
      }
    }

    function signalChild(signal) {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code === "ESRCH") return;
        // macOS can deny group signals to a protected, orphaned completion
        // hook after Codex exits. Do not confuse that with failed job storage.
        // Still terminate our own child and wait for its confirmed exit.
        if (error.code === "EPERM") {
          logCall("job_cleanup_group_denied", audit);
          if (!exited) {
            try { child.kill(signal); } catch { /* verification below decides health */ }
          }
        } else logCall("job_cleanup_signal_failed", audit, "process_cleanup_failed");
      }
    }
  });
}

function recordBridgeEvent(job, event) {
  if (!event || typeof event !== "object") return;
  const seq = event.seq;
  const type = typeof event.type === "string" ? event.type : "";
  if (!Number.isSafeInteger(seq) || seq < 1 || seq <= (job.eventSeq ?? 0) || !VISIBLE_EVENT_TYPES.has(type)) return;
  const record = {
    seq,
    time: typeof event.time === "string" ? event.time.slice(0, 100) : new Date().toISOString(),
    type,
    data: sanitizeEventValue(event.data),
  };
  try {
    appendFileSync(resolve(JOB_EVENTS_DIR, `${job.jobId}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    job.eventSeq = seq;
    if (type === "browser.environment_blocked") {
      job.environmentErrorCode = "browser_sandbox_blocked";
      job.environmentMessage = typeof record.data?.message === "string"
        ? record.data.message
        : "Chromium/Playwright was blocked by the macOS Codex sandbox before reliable browser assertions could run.";
      persistJob(job);
    }
    for (const finish of [...(job.eventWaiting || [])]) finish();
  } catch {
    process.stderr.write("local-codex-adapter job event log unavailable\n");
  }
}

function sanitizeEventValue(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return value.replaceAll("\0", "").slice(0, 65536);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeEventValue(item, depth + 1));
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/reasoning|encrypted/i.test(key)) continue;
    out[key] = sanitizeEventValue(item, depth + 1);
  }
  return out;
}

async function readEventRecords(jobId) {
  let text;
  try { text = await readFile(resolve(JOB_EVENTS_DIR, `${jobId}.jsonl`), "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw callError("event_storage_error", "Unable to read saved job events");
  }
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.type !== "string" ||
          !VISIBLE_EVENT_TYPES.has(event.type) || !event.time) continue;
      events.push({ seq: event.seq, time: String(event.time).slice(0, 100), type: event.type, data: sanitizeEventValue(event.data) });
    } catch { /* ignore an incomplete/truncated last line rather than losing prior events */ }
  }
  return events.sort((a, b) => a.seq - b.seq);
}

async function loadEventSeq(jobId) {
  const events = await readEventRecords(jobId);
  return events.at(-1)?.seq ?? 0;
}

async function eventSnapshot(job, afterEventSeq, eventLimit) {
  const records = await readEventRecords(job.jobId);
  const events = records.filter(event => event.seq > afterEventSeq).slice(0, eventLimit);
  const nextEventSeq = events.at(-1)?.seq ?? afterEventSeq;
  return {
    events,
    nextEventSeq,
    eventsDone: terminalStatuses.has(job.status) && nextEventSeq >= (job.eventSeq ?? 0),
  };
}

function browserInstructions(browserAccess) {
  return browserAccess
    ? "Official Codex Browser Use is enabled for this job through the local_codex_browser MCP server. Use only its official_browser_open, official_browser_snapshot, official_browser_get_text, official_browser_click, official_browser_fill, official_browser_press, official_browser_screenshot, and official_browser_close tools. Do not call node_repl, Playwright MCP, Computer Use, or browser packages directly. Never launch Playwright, Chromium, Puppeteer, Chrome, or another browser as a shell process. Browser access does not widen command network or filesystem permissions."
    : "Official Browser Use is disabled for this job. Do not invoke Browser, Chrome, Computer Use, node_repl browser services, or shell-launched browser processes.";
}

function threadParams(cwd, networkAccess, browserAccess, threadId, settings) {
  const params = {
    cwd,
    approvalPolicy: "never",
    permissions: "local-codex-tunnel",
    developerInstructions: `Operate only inside ${cwd}. Command network access is ${networkAccess ? "enabled" : "disabled"}. ${browserInstructions(browserAccess)} Do not request broader access.`,
  };
  if (threadId) params.threadId = threadId;
  if (settings) {
    params.model = settings.model;
    params.config = { model_reasoning_effort: settings.reasoningEffort };
  }
  return params;
}

function turnParams(cwd, threadId, prompt, settings, browserAccess) {
  const params = {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd,
    approvalPolicy: "never",
    permissions: "local-codex-tunnel",
    model: settings.model,
    effort: settings.reasoningEffort,
  };
  if (browserAccess) {
    params.additionalContext = {
      "local-codex-browser-access": { kind: "application", value: browserInstructions(true) },
    };
  }
  return params;
}

function toolResult(id, result, isError = false) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: result,
      ...(isError ? { isError: true } : {}),
      content: [{ type: "text", text: JSON.stringify(result) }],
    },
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function json(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const error = new Error("request body too large");
        error.statusCode = 413;
        rejectPromise(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectPromise);
    req.on("aborted", () => rejectPromise(callError("request_cancelled", "Request aborted")));
  });
}

function authorized(header) {
  const expected = Buffer.from(expectedAuthorization);
  const actual = Buffer.from(header || "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function assertPrompt(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100000) {
    throw new Error("prompt must be a non-empty string no longer than 100000 characters");
  }
}

function normalizeSourceTitle(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw callError("invalid_request", "sourceTitle must be a single-line exact title without control characters");
  }
  const title = value.trim();
  if (!title || Array.from(title).length > 200) {
    throw callError("invalid_request", "sourceTitle must be between 1 and 200 characters");
  }
  return title;
}

function validatePersistedTitle(value, label) {
  if (typeof value !== "string" || !value || Array.from(value).length > 200 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function sanitizeCodexThreadName(value) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  return Array.from(clean).slice(0, 200).join("") || null;
}

function updateCodexThreadName(job, value) {
  const title = sanitizeCodexThreadName(value);
  if (!title || job.codexThreadName === title) return;
  job.codexThreadName = title;
  if (job.threadId) threadCodexNames.set(job.threadId, title);
  saveThreadState();
  persistJob(job);
}

function assertSelectionArguments(args) {
  for (const [key, max] of [["model", 200], ["reasoningEffort", 32]]) {
    if (args[key] !== undefined && (typeof args[key] !== "string" ||
        !args[key].trim() || args[key].length > max)) {
      throw callError("invalid_selection", `${key} must be a non-empty string no longer than ${max} characters`);
    }
  }
}

function selectSettings(args, prior, models) {
  const rawModel = args.model ?? prior.model;
  const model = MODEL_ALIASES.get(rawModel) || rawModel;
  const reasoningEffort = args.reasoningEffort ?? prior.reasoningEffort;
  const entry = models.find(item => item.model === model);
  if (!entry) {
    throw callError("unsupported_model", `Unsupported model. Available models: ${models.map(item => item.model).join(", ")}`);
  }
  const efforts = (entry.supportedReasoningEfforts || []).map(item => item.reasoningEffort);
  if (!efforts.includes(reasoningEffort)) {
    throw callError("unsupported_effort", `Unsupported reasoning level for ${model}. Supported choices: ${efforts.join(", ")}. Specify reasoningEffort explicitly; no fallback is applied.`);
  }
  return { model, reasoningEffort };
}

function callError(code, message) {
  return Object.assign(new Error(message), { callCode: code });
}

function logCall(event, audit, errorCode) {
  // Only this explicit metadata allowlist reaches the shared log. Never pass
  // request arguments, upstream errors, prompts, output, or raw stderr here.
  const entry = {
    time: new Date().toISOString(), level: errorCode ? "ERROR" : "INFO",
    component: "local-codex-adapter", event, adapterVersion: VERSION, schemaFingerprint: SCHEMA_FINGERPRINT,
    jobId: audit.jobId, tool: audit.tool, status: audit.status,
    threadId: audit.threadId, turnId: audit.turnId,
    workspaceKind: audit.workspaceKind || "direct", worktreeState: audit.worktreeState || null,
    model: audit.model, reasoningEffort: audit.reasoningEffort,
    networkAccess: audit.networkAccess ?? false, browserAccess: audit.browserAccess ?? false,
    browserBackend: audit.browserBackend ?? (audit.browserAccess ? "official_codex" : "none"),
    settingsStatus: audit.settingsStatus,
    durationMs: Date.now() - audit.startedAt,
    ...(errorCode ? { errorCode } : {}),
  };
  // One append per line, using O_APPEND just like tunnel-client. Reopen for
  // each event so rotation never leaves this writer on an old inode.
  try { appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); }
  catch { process.stderr.write("local-codex-adapter audit log unavailable\n"); }
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  return extractText(value.content || value.message || []);
}

function resultSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      jobId: { type: "string" },
      cwd: { type: "string" },
      sourceCwd: { type: "string" },
      workspaceKind: { type: "string", enum: ["direct", "worktree"] },
      worktreeId: { type: "string" },
      worktreeState: { type: "string", enum: ["planned", "creating", "ready", "snapshotted", "failed"] },
      worktreeReason: { type: "string" },
      baseSha: { type: "string" },
      status: { type: "string", enum: ["queued", "starting", "running", "cancelling", "completed", "failed", "cancelled", "timed_out", "interrupted", "busy", "error"] },
      activeJobId: { type: "string" },
      threadId: { type: ["string", "null"] },
      turnId: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      reasoningEffort: { type: ["string", "null"] },
      sourceTitle: { type: "string" },
      codexThreadName: { type: "string" },
      networkAccess: { type: "boolean" },
      browserAccess: { type: "boolean" },
      browserBackend: { type: "string", enum: ["none", "official_codex"] },
      startedAt: { type: "number" },
      updatedAt: { type: "number" },
      pollLeaseMs: { type: "number" },
      leaseExpiresAt: { type: "number" },
      finishedAt: { type: "number" },
      elapsedMs: { type: "number" },
      content: { type: "string" },
      environmentErrorCode: { type: "string" },
      environmentMessage: { type: "string" },
      events: {
        type: "array", maxItems: 100,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            seq: { type: "integer" }, time: { type: "string" }, type: { type: "string" }, data: { type: ["object", "null"] },
          },
          required: ["seq", "time", "type", "data"],
        },
      },
      nextEventSeq: { type: "integer" },
      eventsDone: { type: "boolean" },
      errorCode: { type: "string" },
      message: { type: "string" },
      adapterVersion: { type: "string" },
      schemaFingerprint: { type: "string" },
    },
    required: ["status"],
  };
}

async function loadThreadState() {
  try {
    threadState = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return;
  }
  if (!Array.isArray(threadState.threadIds) || (threadState.schemaVersion ?? 1) > 5) throw new Error("Invalid thread state");
  let migrated = false;
  for (const id of threadState.threadIds) {
    if (typeof id !== "string" || !id) throw new Error("Invalid thread id");
    const saved = threadState.threadCwds?.[id];
    const cwd = saved ?? await legacyCwd();
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Invalid thread folder");
    const sourceCwd = threadState.threadSourceCwds?.[id] ?? cwd;
    if (typeof sourceCwd !== "string" || !isAbsolute(sourceCwd)) throw new Error("Invalid thread source folder");
    const workspaceKind = threadState.threadWorkspaceKinds?.[id] ?? "direct";
    if (!["direct", "worktree"].includes(workspaceKind)) throw new Error("Invalid thread workspace kind");
    const worktreeId = threadState.threadWorktreeIds?.[id];
    if (worktreeId !== undefined) {
      const record = worktreeManager.get(worktreeId);
      if (!record || record.threadId !== id || record.executionCwd !== cwd) throw new Error("Invalid thread worktree mapping");
    }
    const networkAccess = threadState.threadNetworkAccess?.[id] ?? false;
    if (typeof networkAccess !== "boolean") throw new Error("Invalid thread network setting");
    const browserAccess = threadState.threadBrowserAccess?.[id] ?? false;
    if (typeof browserAccess !== "boolean") throw new Error("Invalid thread browser setting");
    const sourceTitle = threadState.threadSourceTitles?.[id];
    if (sourceTitle !== undefined) validatePersistedTitle(sourceTitle, "thread source title");
    const codexThreadName = threadState.threadCodexNames?.[id];
    if (codexThreadName !== undefined) validatePersistedTitle(codexThreadName, "thread Codex name");
    threadFolders.set(id, cwd);
    threadSourceCwds.set(id, sourceCwd);
    threadWorkspaceKinds.set(id, workspaceKind);
    if (worktreeId) threadWorktreeIds.set(id, worktreeId);
    threadNetworkAccess.set(id, networkAccess);
    threadBrowserAccess.set(id, browserAccess);
    if (sourceTitle) threadSourceTitles.set(id, sourceTitle);
    if (codexThreadName) threadCodexNames.set(id, codexThreadName);
    if ((threadState.schemaVersion ?? 1) < 5 || saved === undefined ||
        threadState.threadNetworkAccess?.[id] === undefined ||
        threadState.threadBrowserAccess?.[id] === undefined) migrated = true;
  }
  if (migrated) saveThreadState();
}

function saveThreadState() {
  threadState = { ...threadState, schemaVersion: 5, threadIds: [...threadFolders.keys()],
    threadCwds: Object.fromEntries(threadFolders),
    threadSourceCwds: Object.fromEntries(threadSourceCwds),
    threadWorkspaceKinds: Object.fromEntries(threadWorkspaceKinds),
    threadWorktreeIds: Object.fromEntries(threadWorktreeIds),
    threadNetworkAccess: Object.fromEntries(threadNetworkAccess),
    threadBrowserAccess: Object.fromEntries(threadBrowserAccess),
    threadSourceTitles: Object.fromEntries(threadSourceTitles),
    threadCodexNames: Object.fromEntries(threadCodexNames) };
  writePrivateJson(STATE_FILE, threadState);
}

async function legacyCwd() {
  if (threadState.legacyCwd) {
    if (typeof threadState.legacyCwd !== "string" || !isAbsolute(threadState.legacyCwd)) throw new Error("Invalid legacy folder");
    return threadState.legacyCwd;
  }
  if (!legacyRootInput) throw new Error("LOCAL_CODEX_ROOT is required to migrate legacy state");
  const cwd = await canonicalDirectory(legacyRootInput, "LOCAL_CODEX_ROOT");
  threadState.legacyCwd = cwd;
  threadState.threadIds ??= [];
  // Pin the migration source before writing any job, even if there are no old threads.
  writePrivateJson(STATE_FILE, threadState);
  return cwd;
}

function safeError(error) {
  const message = error?.callCode ? error.message : "Local Codex operation failed";
  return message.replaceAll(expectedAuthorization, "[REDACTED]").slice(0, 4000);
}

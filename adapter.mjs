#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { browserStatusTool, probeBrowserBackend } from "./browser-probe.mjs";

// Only used to migrate pre-v3 records; never used as a new job's default.
const legacyRootInput = process.env.LOCAL_CODEX_ROOT;
const HOST = process.env.LOCAL_CODEX_HOST || "127.0.0.1";
const PORT = Number(process.env.LOCAL_CODEX_PORT || "8765");
const CODEX_BIN = process.env.LOCAL_CODEX_BIN || "codex";
const TOKEN_FILE = process.env.LOCAL_CODEX_TOKEN_FILE;
const STATE_FILE = process.env.LOCAL_CODEX_STATE_FILE ||
  resolve(homedir(), "Library/Application Support/local-codex-tunnel/threads.json");
const LOG_FILE = process.env.LOCAL_CODEX_LOG_FILE ||
  resolve(homedir(), "Library/Application Support/tunnel-client/logs/local-codex.log");
const JOBS_DIR = process.env.LOCAL_CODEX_JOBS_DIR || resolve(dirname(STATE_FILE), "jobs");
const JOB_EVENTS_DIR = process.env.LOCAL_CODEX_JOB_EVENTS_DIR || resolve(dirname(STATE_FILE), "job-events");
const VERSION = "3.2.0";
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
const MAX_CONCURRENCY = Number(process.env.LOCAL_CODEX_MAX_CONCURRENCY || "4");
const MAX_QUEUE = Number(process.env.LOCAL_CODEX_MAX_QUEUE || "100");
const VISIBLE_EVENT_TYPES = new Set([
  "session.started", "session.error", "session.ended",
  "chatgpt.prompt", "thread.started", "turn.requested", "turn.started", "turn.completed", "turn.interrupt_requested",
  "settings.updated", "assistant.delta", "item.started", "item.completed",
  "approval.requested", "approval.resolved", "approval.server_resolved",
  "browser.environment_blocked",
]);
function permissionConfig(cwd, networkAccess) {
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
  return `permissions.local-codex-tunnel={description="Local Codex", workspace_roots={${JSON.stringify(cwd)}=true}, filesystem={${reads}, ":workspace_roots"={${workspace}}}, network={enabled=${networkAccess}}}`;
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("LOCAL_CODEX_PORT must be an integer between 1 and 65535");
}
if (HOST !== "127.0.0.1" && HOST !== "::1") throw new Error("LOCAL_CODEX_HOST must be loopback");
if (!Number.isSafeInteger(CALL_TIMEOUT_MS) || CALL_TIMEOUT_MS <= 0 || CALL_TIMEOUT_MS > 2147483647) {
  throw new Error("LOCAL_CODEX_CALL_TIMEOUT_MS must be a positive timer-safe integer");
}
if (!Number.isSafeInteger(MAX_CONCURRENCY) || MAX_CONCURRENCY < 1 || MAX_CONCURRENCY > 1024) {
  throw new Error("LOCAL_CODEX_MAX_CONCURRENCY must be an integer between 1 and 1024");
}
if (!Number.isSafeInteger(MAX_QUEUE) || MAX_QUEUE < 0 || MAX_QUEUE > 100000) {
  throw new Error("LOCAL_CODEX_MAX_QUEUE must be an integer between 0 and 100000");
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
let threadState = {};
await mkdir(dirname(LOG_FILE), { recursive: true, mode: 0o700 });
appendFileSync(LOG_FILE, "", { mode: 0o600 });
await mkdir(JOBS_DIR, { recursive: true, mode: 0o700 });
await mkdir(JOB_EVENTS_DIR, { recursive: true, mode: 0o700 });
await mkdir(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
const jobs = new Map();
const requests = new Map();
const waiters = new Map();
const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
const activeJobs = new Map();
const activeFolders = new Set();
const jobQueue = [];
let ready = false;
let shuttingDown = false;
let storageHealthy = true;
const requestIdProperty = {
  type: "string", minLength: 1, maxLength: 200,
  description: "Generate a unique ID for new work. Reuse this exact ID and arguments on retries; never retry with a new ID.",
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
  description: "Set true when the task requires launching a local browser process such as Playwright, Chromium, Puppeteer, or Chrome for Testing. This is independent of networkAccess. On macOS, current upstream Codex does not expose the scoped Mach-port permission Chromium needs, so true fails clearly before a job starts instead of weakening the sandbox. On other platforms this records browser intent without widening filesystem or network access.",
};
const replyBrowserProperty = {
  type: "boolean",
  description: "Omit to inherit the thread's browserAccess state. Set true when this reply newly requires launching a local browser process. Set false to disable it again. This does not imply network access. On macOS, true fails clearly before a job starts while upstream Codex lacks a safe scoped Chromium/Mach permission.",
};

const tools = [
  {
    name: "codex",
    title: "Local Codex",
    description: "Start a background Codex job in cwd, any existing absolute folder you choose. Choose networkAccess from the user's task intent, not only explicit wording: set true when completing the request requires outbound access such as git fetch, git pull, git clone, dependency or package installation, curl, HTTP/API access, or downloads, even if the user never mentions network access; omit or use false for fully local work. Choose browserAccess separately when the task requires Playwright, Chromium, Puppeteer, or Chrome for Testing. browserAccess does not imply network access or wider filesystem access; on macOS it currently fails clearly before starting because upstream Codex lacks a safe scoped Chromium Mach-port permission. No directory allowlist or per-folder approval. Use codex-folders to locate the narrowest folder relevant to the user's task. Writes stay inside its canonical path. Jobs in different canonical folders can run concurrently up to the configured limit; jobs for an already-active folder are serialized through the queue. Returns jobId immediately; poll codex-status with waitMs=20000, never resubmit to check progress. Default Luna/max.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        requestId: requestIdProperty,
        cwd: { type: "string", minLength: 1, maxLength: 4096, description: "Absolute path to an existing working folder. Symlinks resolve to their target; the returned canonical cwd is the write boundary." },
        prompt: { type: "string", minLength: 1, maxLength: 100000 },
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
    description: "Start a background reply on an adapter-owned thread, using its saved folder. Omit networkAccess to inherit: enabled stays enabled and disabled stays disabled. Set true when this reply newly requires outbound access such as git fetch, git pull, git clone, dependency or package installation, curl, HTTP/API access, or downloads, even if the user only implies it; set false when networking must be disabled again. Omit browserAccess to inherit the saved browser capability; set true when the reply needs a local browser process and false to disable it again. browserAccess is independent of networkAccess and on macOS browserAccess=true currently fails clearly before work starts because upstream Codex lacks a safe scoped Chromium Mach-port permission. Folder changes are not allowed; use codex for a new folder. Replies use the same per-folder serialization and bounded queue as new jobs. Returns jobId; poll codex-status with waitMs=20000. Omitted model/reasoningEffort retain thread settings; overrides persist. Reuse requestId on retries.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        requestId: requestIdProperty,
        threadId: { type: "string", minLength: 1, maxLength: 200 },
        prompt: { type: "string", minLength: 1, maxLength: 100000 },
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
    description: "Read a saved job. For normal completion polling, optionally wait up to 20 seconds with waitMs=20000. For incremental visible activity, start with afterEventSeq=0 and waitMs=20000; the call returns as soon as a new event arrives or the job becomes terminal. Pass nextEventSeq back as afterEventSeq on the next poll. Events include externally visible prompts/messages/commands/results/approval state and never hidden reasoning. Known macOS Chromium sandbox failures are classified as execution-environment failures in the job snapshot/events.",
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
      const healthy = ready && storageHealthy && !shuttingDown;
      const active = [...activeJobs.values()];
      return json(res, healthy ? 200 : 503, {
        status: healthy ? "ready" : "unavailable", scope: "per_job", version: VERSION, schemaFingerprint: SCHEMA_FINGERPRINT,
        activeCalls: active.length, queuedCalls: jobQueue.length,
        activeJobId: active[0]?.jobId ?? null, activeCwd: active[0]?.cwd ?? null,
        activeJobIds: active.map(job => job.jobId), activeCwds: active.map(job => job.cwd),
        queuedJobIds: jobQueue.map(job => job.jobId), queuedCwds: jobQueue.map(job => job.cwd),
        maxConcurrency: MAX_CONCURRENCY, maxQueue: MAX_QUEUE, scheduling: "fifo-runnable-per-folder",
        browserAccessStatus: process.platform === "darwin" ? "upstream-sandbox-blocked" : "available",
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
    default:
      return rpcError(message.id, -32601, `method not found: ${message.method}`);
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
      validateArguments(args, name === "codex" ? ["requestId", "cwd", "prompt", "networkAccess", "browserAccess", "model", "reasoningEffort"]
        : ["requestId", "threadId", "prompt", "networkAccess", "browserAccess", "model", "reasoningEffort"]);
      const missing = tools.find(tool => tool.name === name).inputSchema.required.filter(field => args[field] === undefined);
      if (missing.length) {
        throw callError("schema_outdated", `Local Codex ${VERSION} is missing required fields: ${missing.join(", ")}. In ChatGPT, open Local Codex > Manage > Refresh, then start a fresh chat. No job was started.`);
      }
      assertIdentifier(args.requestId, "requestId");
      assertPrompt(args.prompt);
      assertSelectionArguments(args);
      if (args.networkAccess !== undefined && typeof args.networkAccess !== "boolean") {
        throw callError("invalid_request", "networkAccess must be true or false when provided");
      }
      if (args.browserAccess !== undefined && typeof args.browserAccess !== "boolean") {
        throw callError("invalid_request", "browserAccess must be true or false when provided");
      }
      if (name === "codex-reply" && !threadFolders.has(args.threadId)) {
        throw callError("unknown_thread", "threadId was not created by this Local Codex adapter");
      }
      const cwd = name === "codex" ? await canonicalDirectory(args.cwd, "cwd") : threadFolders.get(args.threadId);
      const networkAccess = args.networkAccess ?? (name === "codex-reply" ? threadNetworkAccess.get(args.threadId) : false) ?? false;
      const browserAccess = args.browserAccess ?? (name === "codex-reply" ? threadBrowserAccess.get(args.threadId) : false) ?? false;
      if (browserAccess && process.platform === "darwin") {
        throw callError("browser_access_unavailable",
          "browserAccess is not safely available on macOS with current upstream Codex. Chromium/Playwright requires global Mach port permissions that the scoped Codex permission profile cannot grant. No job was started and the sandbox was not weakened. Use codex-browser-status to check whether the official Codex Browser Use backend is available on this host, or use a browser-capable Linux/Docker environment.");
      }
      const key = digest(args.requestId);
      const fingerprintInput = [cwd, name, args.prompt, args.threadId ?? null,
        MODEL_ALIASES.get(args.model) || args.model || null, args.reasoningEffort ?? null];
      // Keep omitted-field fingerprints byte-for-byte compatible with pre-v3.1
      // saved jobs. Explicit capability values are still distinct requests.
      if (args.networkAccess !== undefined) fingerprintInput.push(args.networkAccess);
      if (args.browserAccess !== undefined) fingerprintInput.push(args.browserAccess);
      const fingerprint = digest(JSON.stringify(fingerprintInput));
      const prior = requests.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw callError("request_conflict", "requestId already belongs to different arguments");
        return toolResult(message.id, snapshot(prior));
      }
      if (!storageHealthy) throw callError("storage_error", "Job storage unavailable; refusing new work");
      if (shuttingDown) throw callError("unavailable", "Adapter is shutting down; no work was started");
      if (signal?.aborted) throw callError("request_cancelled", "Request disconnected before acceptance");
      const startNow = canRunFolder(cwd);
      if (!startNow && jobQueue.length >= MAX_QUEUE) {
        throw callError("queue_full", `Local Codex queue is full (${MAX_QUEUE}); retry with the same requestId after another job finishes`);
      }
      const job = {
        jobId: randomUUID(), requestKey: key, fingerprint, tool: name, cwd,
        status: startNow ? "starting" : "queued", threadId: args.threadId ?? null, turnId: null,
        model: null, reasoningEffort: null, networkAccess, browserAccess, settingsStatus: "pending",
        startedAt: Date.now(), updatedAt: Date.now(), eventSeq: 0,
      };
      // Acceptance is durable before work is started or queued. Visible prompts
      // and activity may also be persisted in the private Guard/job-event stream;
      // restart recovery still marks queued/running work interrupted rather than replaying it.
      persistJob(job);
      jobs.set(job.jobId, job);
      requests.set(key, job);
      job.done = new Promise(resolve => { job.resolveDone = resolve; });
      job.waiting = new Set();
      job.eventWaiting = new Set();
      job.runtimeArgs = args;
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
        await waitForJobEvents(job, afterEventSeq, waitMs, message.id, signal);
        return toolResult(message.id, { ...snapshot(job), ...(await eventSnapshot(job, afterEventSeq, eventLimit)) });
      }
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

function canRunFolder(cwd) {
  return activeJobs.size < MAX_CONCURRENCY && !activeFolders.has(cwd);
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
  if (shuttingDown || !storageHealthy) return;
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
    await verifyPinnedDirectory(job.cwd);
    if (job.stopReason) throw callError(job.stopReason, "Job stopped before execution");
    job.status = "running";
    persistJob(job);
    const result = await runCodex(args, job.threadId, job);
    job.content = result.content;
    job.status = "completed";
  } catch (error) {
    job.status = job.stopReason || (error.callCode === "timeout" ? "timed_out" : "failed");
    job.errorCode = error.callCode || "job_failed";
    job.message = safeError(error);
  } finally {
    job.finishedAt = Date.now();
    try { persistJob(job); } catch { storageHealthy = false; }
    logCall(`job_${job.status}`, job, job.errorCode);
    activeJobs.delete(job.jobId);
    activeFolders.delete(job.cwd);
    settleJob(job);
    scheduleJobs();
  }
}

function cancelJob(job, reason) {
  if (terminalStatuses.has(job.status) || job.stopReason) return;
  if (job.status === "queued") {
    job.stopReason = reason;
    job.status = reason;
    job.errorCode = reason;
    job.message = reason === "cancelled" ? "Job cancelled before execution" : "Job interrupted before execution";
    job.finishedAt = Date.now();
    const index = jobQueue.indexOf(job);
    if (index >= 0) jobQueue.splice(index, 1);
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
  // Cancellation must still stop the child if the disk is full.
  try { persistJob(job); } finally { job.stop?.(reason); }
  logCall("job_cancelling", job);
}

function settleJob(job) {
  for (const finish of job.waiting || []) finish();
  for (const finish of job.eventWaiting || []) finish();
  job.resolveDone?.();
}

function snapshot(job) {
  return {
    jobId: job.jobId, status: job.status, cwd: job.cwd, threadId: job.threadId, turnId: job.turnId,
    model: job.model, reasoningEffort: job.reasoningEffort,
    networkAccess: job.networkAccess ?? false, browserAccess: job.browserAccess ?? false,
    startedAt: job.startedAt, updatedAt: job.updatedAt,
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
    tool: job.tool, settingsStatus: job.settingsStatus };
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
    if (job.networkAccess === undefined) job.networkAccess = false;
    if (typeof job.networkAccess !== "boolean") throw new Error("Invalid job network setting");
    if (job.browserAccess === undefined) job.browserAccess = false;
    if (typeof job.browserAccess !== "boolean") throw new Error("Invalid job browser setting");
    if (job.threadId && threadFolders.has(job.threadId) && threadFolders.get(job.threadId) !== job.cwd) {
      throw new Error("Job and thread folder mismatch");
    }
    job.eventSeq = await loadEventSeq(job.jobId);
    job.eventWaiting = new Set();
    if (!terminalStatuses.has(job.status)) {
      job.status = "interrupted";
      job.errorCode = "adapter_restarted";
      job.message = "Adapter restarted before completion. Work was not replayed; inspect the thread before requesting new work.";
      job.finishedAt = Date.now();
      persistJob(job);
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
  process.exit(storageHealthy ? 0 : 1);
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

function runCodex(args, existingThreadId, audit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const cwd = audit.cwd;
    const child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://", "-c", permissionConfig(cwd, audit.networkAccess)], {
      cwd,
      detached: process.platform !== "win32",
      // Do not forward raw app-server stderr to the shared audit log.
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, LOCAL_CODEX_BROWSER_ACCESS: String(audit.browserAccess ?? false) },
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
          ? await request("thread/resume", threadParams(cwd, audit.networkAccess, existingThreadId))
          : DEFAULT_SETTINGS;
        selected = selectSettings(args, prior, models);
        Object.assign(audit, selected, { settingsStatus: "requested" });
        logCall("settings_requested", audit);

        const threadResponse = existingThreadId
          ? prior
          : await request("thread/start", threadParams(cwd, audit.networkAccess, null, selected));
        if (threadResponse?.thread?.cwd && threadResponse.thread.cwd !== cwd) {
          throw callError("folder_mismatch", "Codex returned a different thread folder; no turn was started");
        }
        threadId = threadResponse?.thread?.id || threadId;
        if (!threadId) throw new Error("Codex did not return a thread id");
        audit.threadId = threadId;
        threadFolders.set(threadId, cwd);
        threadNetworkAccess.set(threadId, audit.networkAccess);
        threadBrowserAccess.set(threadId, audit.browserAccess ?? false);
        saveThreadState();
        persistJob(audit);
        if (!existingThreadId) confirmSettings(threadResponse.model, threadResponse.reasoningEffort);
        turnSubmitted = true;
        const turnResponse = await request("turn/start", turnParams(cwd, threadId, args.prompt, selected));
        turnId = turnResponse?.turn?.id || turnId;
        audit.turnId = turnId;
        persistJob(audit);
        // Re-resuming a loaded thread does not apply overrides, but reports its
        // effective settings. turn/start is what actually changes reply settings.
        // A fresh rollout may not yet be flushed to disk and cannot be resumed
        // immediately. Its thread/start response already confirmed both fields.
        if (existingThreadId) {
          const effective = await request("thread/resume", threadParams(cwd, audit.networkAccess, threadId));
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
        if (message.error) entry.reject(callError("server_request_failed", `Codex app-server rejected ${entry.method}`));
        else entry.resolve(message.result);
        return;
      }
      const method = message.method;
      const params = message.params || {};
      if (params.threadId && threadId && params.threadId !== threadId) return;
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
      if (turnCompleted && turnConfirmed) {
        const values = [...messages.values()];
        const final = values.filter(item => item.phase === "final_answer");
        finish(null, { threadId, content: (final.length ? final : values).map(item => item.text).join("\n").trim() });
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
      clearTimeout(timer);
      clearTimeout(interruptTimer);
      delete audit.stop;
      for (const entry of pending.values()) entry.reject(error || new Error("Codex call ended"));
      pending.clear();
      const resolveAfterExit = () => {
        clearTimeout(killTimer);
        signalChild("SIGKILL"); // Remove any remaining children before releasing this folder lock.
        if (error) rejectPromise(error);
        else resolvePromise(value);
      };
      signalChild("SIGTERM");
      const killTimer = setTimeout(() => {
        signalChild("SIGKILL");
      }, 2000);
      if (exited || !child.pid) resolveAfterExit();
      else child.once("exit", resolveAfterExit);
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
            try { child.kill(signal); } catch { storageHealthy = false; }
          }
        } else storageHealthy = false;
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

function threadParams(cwd, networkAccess, threadId, settings) {
  const params = {
    cwd,
    approvalPolicy: "never",
    permissions: "local-codex-tunnel",
    developerInstructions: `Operate only inside ${cwd}. Command network access is ${networkAccess ? "enabled" : "disabled"}. Do not request broader access.`,
  };
  if (threadId) params.threadId = threadId;
  if (settings) {
    params.model = settings.model;
    params.config = { model_reasoning_effort: settings.reasoningEffort };
  }
  return params;
}

function turnParams(cwd, threadId, prompt, settings) {
  return {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd,
    approvalPolicy: "never",
    permissions: "local-codex-tunnel",
    model: settings.model,
    effort: settings.reasoningEffort,
  };
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
    model: audit.model, reasoningEffort: audit.reasoningEffort,
    networkAccess: audit.networkAccess ?? false, browserAccess: audit.browserAccess ?? false,
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
      status: { type: "string", enum: ["queued", "starting", "running", "cancelling", "completed", "failed", "cancelled", "timed_out", "interrupted", "busy", "error"] },
      activeJobId: { type: "string" },
      threadId: { type: ["string", "null"] },
      turnId: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      reasoningEffort: { type: ["string", "null"] },
      networkAccess: { type: "boolean" },
      browserAccess: { type: "boolean" },
      startedAt: { type: "number" },
      updatedAt: { type: "number" },
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
  if (!Array.isArray(threadState.threadIds) || (threadState.schemaVersion ?? 1) > 4) throw new Error("Invalid thread state");
  let migrated = false;
  for (const id of threadState.threadIds) {
    if (typeof id !== "string" || !id) throw new Error("Invalid thread id");
    const saved = threadState.threadCwds?.[id];
    const cwd = saved ?? await legacyCwd();
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Invalid thread folder");
    const networkAccess = threadState.threadNetworkAccess?.[id] ?? false;
    if (typeof networkAccess !== "boolean") throw new Error("Invalid thread network setting");
    const browserAccess = threadState.threadBrowserAccess?.[id] ?? false;
    if (typeof browserAccess !== "boolean") throw new Error("Invalid thread browser setting");
    threadFolders.set(id, cwd);
    threadNetworkAccess.set(id, networkAccess);
    threadBrowserAccess.set(id, browserAccess);
    if (saved === undefined || threadState.threadNetworkAccess?.[id] === undefined ||
        threadState.threadBrowserAccess?.[id] === undefined) migrated = true;
  }
  if (migrated) saveThreadState();
}

function saveThreadState() {
  // browserAccess is an additive optional map in the existing v4 state shape;
  // keep the version stable so older v4 readers can ignore the new field.
  threadState = { ...threadState, schemaVersion: 4, threadIds: [...threadFolders.keys()],
    threadCwds: Object.fromEntries(threadFolders),
    threadNetworkAccess: Object.fromEntries(threadNetworkAccess),
    threadBrowserAccess: Object.fromEntries(threadBrowserAccess) };
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

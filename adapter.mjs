#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";

const rootInput = process.env.LOCAL_CODEX_ROOT;
if (!rootInput) {
  throw new Error("LOCAL_CODEX_ROOT is required");
}

const ROOT = await realpath(resolve(rootInput));
const HOST = process.env.LOCAL_CODEX_HOST || "127.0.0.1";
const PORT = Number(process.env.LOCAL_CODEX_PORT || "8765");
const CODEX_BIN = process.env.LOCAL_CODEX_BIN || "codex";
const TOKEN_FILE = process.env.LOCAL_CODEX_TOKEN_FILE;
const STATE_FILE = process.env.LOCAL_CODEX_STATE_FILE ||
  resolve(homedir(), "Library/Application Support/local-codex-tunnel/threads.json");
const LOG_FILE = process.env.LOCAL_CODEX_LOG_FILE ||
  resolve(homedir(), "Library/Application Support/tunnel-client/logs/local-codex.log");
const VERSION = "1.1.0";
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
const CALL_TIMEOUT_MS = Number(process.env.LOCAL_CODEX_CALL_TIMEOUT_MS || "300000");
const rootToml = JSON.stringify(ROOT);
const PERMISSION_CONFIG = `permissions.local-codex-tunnel={description="Local Codex", workspace_roots={${rootToml}=true}, filesystem={":minimal"="read", ":workspace_roots"={"."="write"}}, network={enabled=false}}`;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("LOCAL_CODEX_PORT must be an integer between 1 and 65535");
}
if (!Number.isFinite(CALL_TIMEOUT_MS) || CALL_TIMEOUT_MS <= 0) {
  throw new Error("LOCAL_CODEX_CALL_TIMEOUT_MS must be positive");
}

if (!TOKEN_FILE) {
  throw new Error("LOCAL_CODEX_TOKEN_FILE is required");
}

const expectedAuthorization = (await readFile(TOKEN_FILE, "utf8")).trim();
if (!expectedAuthorization) {
  throw new Error("local adapter token is empty");
}

const allowedThreads = await loadAllowedThreads();
await mkdir(dirname(LOG_FILE), { recursive: true, mode: 0o700 });
appendFileSync(LOG_FILE, "", { mode: 0o600 });
let callQueue = Promise.resolve();
let activeCalls = 0;
let queuedCalls = 0;

const tools = [
  {
    name: "codex",
    title: "Local Codex",
    description: `Run Codex inside ${ROOT}. Default: Luna with max reasoning. Optional model/reasoningEffort override the defaults. Filesystem writes are limited to this repository and command network access is disabled.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 100000 },
        ...selectionProperties,
      },
      required: ["prompt"],
    },
    outputSchema: resultSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "codex-reply",
    title: "Local Codex Reply",
    description: "Continue a Local Codex thread previously created by this adapter. Omitted model/reasoningEffort keep the thread's last settings; overrides persist for subsequent replies.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", minLength: 1, maxLength: 200 },
        prompt: { type: "string", minLength: 1, maxLength: 100000 },
        ...selectionProperties,
      },
      required: ["threadId", "prompt"],
    },
    outputSchema: resultSchema(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      return json(res, 200, { status: "ok" });
    }
    if (req.method === "GET" && req.url === "/readyz") {
      return json(res, 200, { status: "ready", root: ROOT, version: VERSION, activeCalls, queuedCalls });
    }
    if (req.url?.startsWith("/.well-known/")) {
      return json(res, 404, { error: "not found" });
    }
    if (!authorized(req.headers.authorization)) {
      return json(res, 401, { error: "unauthorized" });
    }
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "method not allowed" });
    }

    const message = JSON.parse(await readBody(req));
    const response = await handleMcp(message);
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

server.listen(PORT, HOST, () => {
  process.stderr.write(`local-codex-adapter ready on http://${HOST}:${PORT}/mcp; root=${ROOT}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function handleMcp(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id ?? null, -32600, "invalid request");
  }
  if (!("id" in message)) {
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
      return { jsonrpc: "2.0", id: message.id, result: { tools } };
    case "tools/call":
      return queueCall(() => callTool(message));
    default:
      return rpcError(message.id, -32601, `method not found: ${message.method}`);
  }
}

async function callTool(message) {
  const name = message.params?.name;
  const args = message.params?.arguments || {};
  const audit = {
    requestId: randomUUID(), tool: name === "codex-reply" ? "codex-reply" : "codex",
    threadId: null, turnId: null, model: null, reasoningEffort: null,
    settingsStatus: "pending", startedAt: Date.now(),
  };
  activeCalls++;
  try {
    logCall("call_started", audit);
    assertSelectionArguments(args);
    if (name === "codex") {
      assertPrompt(args.prompt);
      const result = await runCodex(args, null, audit);
      allowedThreads.add(result.threadId);
      await saveAllowedThreads();
      logCall("call_completed", audit);
      return toolResult(message.id, result);
    }
    if (name === "codex-reply") {
      assertPrompt(args.prompt);
      if (typeof args.threadId !== "string" || !allowedThreads.has(args.threadId)) {
        throw callError("unknown_thread", "threadId was not created by this Local Codex adapter");
      }
      audit.threadId = args.threadId;
      const result = await runCodex(args, args.threadId, audit);
      logCall("call_completed", audit);
      return toolResult(message.id, result);
    }
    logCall("call_failed", audit, "unknown_tool");
    return rpcError(message.id, -32602, `unknown tool: ${String(name)}`);
  } catch (error) {
    logCall(error?.callCode === "timeout" ? "call_timed_out" : "call_failed", audit,
      error?.callCode || "call_error");
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError: true,
        content: [{ type: "text", text: safeError(error) }],
      },
    };
  } finally {
    activeCalls--;
  }
}

function runCodex(args, existingThreadId, audit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://", "-c", PERMISSION_CONFIG], {
      cwd: ROOT,
      // Do not forward raw app-server stderr to the shared audit log.
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env },
    });
    let stdoutBuffer = "";
    let threadId = existingThreadId;
    let turnId = null;
    let content = "";
    let settled = false;
    let selected;
    let turnSubmitted = false;
    let turnConfirmed = false;
    let turnCompleted = false;
    let requestSequence = 0;
    const pending = new Map();

    const timer = setTimeout(() => finish(callError("timeout", "Codex call timed out")), CALL_TIMEOUT_MS);
    timer.unref();

    child.on("error", () => finish(callError("spawn_failed", "Unable to start Codex app-server")));
    child.on("exit", code => {
      if (!settled) finish(callError("server_exit", `Codex app-server exited with code ${code}`));
    });
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
        onMessage(message);
      }
    });

    void start();

    async function start() {
      try {
        await request("initialize", {
          clientInfo: { name: "local_codex_tunnel", title: "Local Codex Tunnel", version: VERSION },
          capabilities: { experimentalApi: true },
        });
        send({ method: "initialized", params: {} });
        const models = await listModels();
        // Existing Codex history, not the global config or an adapter settings cache,
        // owns reply defaults. This also supports the original threadIds-only state.
        const prior = existingThreadId
          ? await request("thread/resume", threadParams(existingThreadId))
          : DEFAULT_SETTINGS;
        selected = selectSettings(args, prior, models);
        Object.assign(audit, selected, { settingsStatus: "requested" });
        logCall("settings_requested", audit);

        const threadResponse = existingThreadId
          ? prior
          : await request("thread/start", threadParams(null, selected));
        threadId = threadResponse?.thread?.id || threadId;
        if (!threadId) throw new Error("Codex did not return a thread id");
        audit.threadId = threadId;
        if (!existingThreadId) confirmSettings(threadResponse.model, threadResponse.reasoningEffort);
        turnSubmitted = true;
        const turnResponse = await request("turn/start", turnParams(threadId, args.prompt, selected));
        turnId = turnResponse?.turn?.id || turnId;
        audit.turnId = turnId;
        // Re-resuming a loaded thread does not apply overrides, but reports its
        // effective settings. turn/start is what actually changes reply settings.
        // A fresh rollout may not yet be flushed to disk and cannot be resumed
        // immediately. Its thread/start response already confirmed both fields.
        if (existingThreadId) {
          const effective = await request("thread/resume", threadParams(threadId));
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
      if (message.id !== undefined && pending.has(String(message.id))) {
        const entry = pending.get(String(message.id));
        pending.delete(String(message.id));
        if (message.error) entry.reject(callError("server_request_failed", `Codex app-server rejected ${entry.method}: ${message.error.message || "request failed"}`));
        else entry.resolve(message.result);
        return;
      }
      const method = message.method;
      const params = message.params || {};
      if (params.threadId && threadId && params.threadId !== threadId) return;
      if (method === "turn/started") {
        turnId = params.turn?.id || params.turnId || turnId;
        audit.turnId = turnId;
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
        content += params.delta;
      }
      if (method === "item/completed") {
        const item = params.item || {};
        if (!content && (item.type === "agentMessage" || item.type === "AgentMessage")) {
          content = extractText(item);
        }
      }
      if (method === "turn/completed") {
        const completed = params.turn || params;
        if (!turnId || !completed.id || completed.id === turnId) {
          const status = completed.status || "completed";
          if (status !== "completed") {
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
      if (turnCompleted && turnConfirmed) finish(null, { threadId, content: content.trim() });
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
      logCall("settings_confirmed", audit);
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const entry of pending.values()) entry.reject(error || new Error("Codex call ended"));
      pending.clear();
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2000);
      killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
      if (error) rejectPromise(error);
      else resolvePromise(value);
    }
  });
}

function threadParams(threadId, settings) {
  const params = {
    cwd: ROOT,
    approvalPolicy: "never",
    permissions: "local-codex-tunnel",
    developerInstructions: `Operate only inside ${ROOT}. Network access is disabled. Do not request broader access.`,
  };
  if (threadId) params.threadId = threadId;
  if (settings) {
    params.model = settings.model;
    params.config = { model_reasoning_effort: settings.reasoningEffort };
  }
  return params;
}

function turnParams(threadId, prompt, settings) {
  return {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd: ROOT,
    approvalPolicy: "never",
    model: settings.model,
    effort: settings.reasoningEffort,
  };
}

function toolResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: result,
      content: [{ type: "text", text: result.content }],
    },
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function json(res, status, body, headers = {}) {
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
    component: "local-codex-adapter", event,
    requestId: audit.requestId, tool: audit.tool,
    threadId: audit.threadId, turnId: audit.turnId,
    model: audit.model, reasoningEffort: audit.reasoningEffort,
    settingsStatus: audit.settingsStatus,
    durationMs: Date.now() - audit.startedAt,
    ...(errorCode ? { errorCode } : {}),
  };
  // One append per line, using O_APPEND just like tunnel-client. Reopen for
  // each event so rotation never leaves this writer on an old inode.
  appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
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
      threadId: { type: "string" },
      content: { type: "string" },
    },
    required: ["threadId", "content"],
  };
}

function queueCall(fn) {
  queuedCalls++;
  const run = () => { queuedCalls--; return fn(); };
  const next = callQueue.then(run, run);
  callQueue = next.catch(() => {});
  return next;
}

async function loadAllowedThreads() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return new Set(Array.isArray(parsed.threadIds) ? parsed.threadIds.filter(value => typeof value === "string") : []);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return new Set();
  }
}

async function saveAllowedThreads() {
  await mkdir(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ threadIds: [...allowedThreads] }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_FILE);
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(expectedAuthorization, "[REDACTED]").slice(0, 4000);
}

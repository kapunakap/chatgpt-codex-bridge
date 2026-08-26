#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
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
const MAX_BODY = 1024 * 1024;
const CALL_TIMEOUT_MS = Number(process.env.LOCAL_CODEX_CALL_TIMEOUT_MS || "300000");
const rootToml = JSON.stringify(ROOT);
const PERMISSION_CONFIG = `permissions.local-codex-tunnel={description="Local Codex", workspace_roots={${rootToml}=true}, filesystem={":minimal"="read", ":workspace_roots"={"."="write"}}, network={enabled=false}}`;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("LOCAL_CODEX_PORT must be an integer between 1 and 65535");
}

if (!TOKEN_FILE) {
  throw new Error("LOCAL_CODEX_TOKEN_FILE is required");
}

const expectedAuthorization = (await readFile(TOKEN_FILE, "utf8")).trim();
if (!expectedAuthorization) {
  throw new Error("local adapter token is empty");
}

const allowedThreads = await loadAllowedThreads();
let callQueue = Promise.resolve();

const tools = [
  {
    name: "codex",
    title: "Local Codex",
    description: `Run Codex inside ${ROOT}. Filesystem writes are limited to this repository and network access is disabled.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 100000 },
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
    description: "Continue a Local Codex thread previously created by this adapter.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", minLength: 1, maxLength: 200 },
        prompt: { type: "string", minLength: 1, maxLength: 100000 },
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
      return json(res, 200, { status: "ready", root: ROOT });
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
          serverInfo: { name: "local-codex", title: "Local Codex", version: "1.0.0" },
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
  try {
    if (name === "codex") {
      assertPrompt(args.prompt);
      const result = await runCodex(args.prompt, null);
      allowedThreads.add(result.threadId);
      await saveAllowedThreads();
      return toolResult(message.id, result);
    }
    if (name === "codex-reply") {
      assertPrompt(args.prompt);
      if (typeof args.threadId !== "string" || !allowedThreads.has(args.threadId)) {
        throw new Error("threadId was not created by this Local Codex adapter");
      }
      const result = await runCodex(args.prompt, args.threadId);
      return toolResult(message.id, result);
    }
    return rpcError(message.id, -32602, `unknown tool: ${String(name)}`);
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError: true,
        content: [{ type: "text", text: safeError(error) }],
      },
    };
  }
}

function runCodex(prompt, existingThreadId) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://", "-c", PERMISSION_CONFIG], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let threadId = existingThreadId;
    let turnId = null;
    let content = "";
    let settled = false;
    const pending = new Map();

    const timer = setTimeout(() => finish(new Error("Codex call timed out")), CALL_TIMEOUT_MS);
    timer.unref();

    child.stderr.on("data", chunk => {
      stderrBuffer = (stderrBuffer + chunk.toString()).slice(-8000);
    });
    child.on("error", finish);
    child.on("exit", code => {
      if (!settled) finish(new Error(`codex app-server exited with code ${code}: ${stderrBuffer.trim()}`));
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
        await request(1, "initialize", {
          clientInfo: { name: "local_codex_tunnel", title: "Local Codex Tunnel", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        });
        send({ method: "initialized", params: {} });
        const threadResponse = existingThreadId
          ? await request(2, "thread/resume", threadParams(existingThreadId))
          : await request(2, "thread/start", threadParams());
        threadId = threadResponse?.thread?.id || threadId;
        if (!threadId) throw new Error("Codex did not return a thread id");
        const turnResponse = await request(3, "turn/start", turnParams(threadId, prompt));
        turnId = turnResponse?.turn?.id || turnId;
      } catch (error) {
        finish(error);
      }
    }

    function onMessage(message) {
      if (message.id !== undefined && pending.has(String(message.id))) {
        const entry = pending.get(String(message.id));
        pending.delete(String(message.id));
        if (message.error) entry.reject(new Error(message.error.message || "Codex app-server request failed"));
        else entry.resolve(message.result);
        return;
      }
      const method = message.method;
      const params = message.params || {};
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
            finish(new Error(completed.error?.message || `Codex turn ended with status ${status}`));
          } else {
            finish(null, { threadId, content: content.trim() });
          }
        }
      }
    }

    function request(id, method, params) {
      return new Promise((resolve, reject) => {
        pending.set(String(id), { resolve, reject });
        send({ method, id, params });
      });
    }

    function send(value) {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`);
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const entry of pending.values()) entry.reject(error || new Error("Codex call ended"));
      pending.clear();
      child.kill("SIGTERM");
      if (error) rejectPromise(error);
      else resolvePromise(value);
    }
  });
}

function threadParams(threadId) {
  const params = {
    cwd: ROOT,
    approvalPolicy: "never",
    permissions: "local-codex-tunnel",
    developerInstructions: `Operate only inside ${ROOT}. Network access is disabled. Do not request broader access.`,
  };
  if (threadId) params.threadId = threadId;
  return params;
}

function turnParams(threadId, prompt) {
  return {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd: ROOT,
    approvalPolicy: "never",
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
  const next = callQueue.then(fn, fn);
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

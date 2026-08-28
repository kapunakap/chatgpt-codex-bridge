#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync,
  rmSync, writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import readline from "node:readline";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator < 0) fail("usage: local-codex-guard-proxy --real-bin PATH --guard-dir DIR --network-access true|false -- ARGS...");
const options = parseOptions(argv.slice(0, separator));
const childArgs = argv.slice(separator + 1);
const realBin = options.get("real-bin");
const guardDir = options.get("guard-dir");
const networkAccess = options.get("network-access") === "true";
if (!realBin || !guardDir || !options.has("network-access")) fail("missing proxy configuration");

const cwd = realpathSync(process.cwd());
const sessionId = randomUUID();
const sessionsDir = join(guardDir, "sessions");
const eventsDir = join(guardDir, "events");
const approvalsDir = join(guardDir, "approvals");
for (const dir of [guardDir, sessionsDir, eventsDir, approvalsDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const sessionFile = join(sessionsDir, `${sessionId}.json`);
const eventsFile = join(eventsDir, `${sessionId}.jsonl`);
let sequence = 0;
let session = {
  sessionId, pid: process.pid, cwd, networkAccess, startedAt: Date.now(), updatedAt: Date.now(),
  status: "starting", threadId: null, turnId: null, realBin: basename(realBin),
};
writePrivateJson(sessionFile, session);
appendFileSync(eventsFile, "", { mode: 0o600 });
emit("session.started", { cwd, networkAccess });

const command = realBin.endsWith(".mjs") ? process.execPath : realBin;
const commandArgs = realBin.endsWith(".mjs") ? [realBin, ...childArgs] : childArgs;
const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env } });
let shuttingDown = false;
const pendingApprovals = new Map();

child.on("error", error => {
  emit("session.error", { message: safeText(error.message) });
});
child.on("exit", (code, signal) => {
  session.status = "ended";
  session.exitCode = code;
  session.signal = signal;
  persistSession();
  emit("session.ended", { exitCode: code, signal });
  for (const pending of pendingApprovals.values()) clearInterval(pending.timer);
  process.exit(signal ? 1 : (code ?? 1));
});
child.stdin.on("error", () => {});

const adapterInput = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
adapterInput.on("line", line => {
  let message;
  try { message = JSON.parse(line); }
  catch { child.stdin.write(`${line}\n`); return; }
  const rewritten = rewriteClientMessage(message);
  observeClientMessage(rewritten);
  if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(rewritten)}\n`);
});
adapterInput.on("close", () => {
  if (!child.stdin.destroyed) child.stdin.end();
});

const codexOutput = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
codexOutput.on("line", line => {
  let message;
  try { message = JSON.parse(line); }
  catch { process.stdout.write(`${line}\n`); return; }
  // This method is reserved for proxy -> adapter observability. Never allow a
  // child app-server to spoof one of these notifications.
  if (message?.method === "localCodex/visibleEvent") return;
  if (isApprovalRequest(message)) {
    holdApproval(message);
    return;
  }
  observeServerMessage(message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill(signal);
  });
}

function parseOptions(values) {
  const result = new Map();
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i];
    const value = values[i + 1];
    if (!key?.startsWith("--") || value === undefined) fail("invalid proxy options");
    result.set(key.slice(2), value);
  }
  return result;
}

function rewriteClientMessage(message) {
  if (!["thread/start", "thread/resume", "turn/start"].includes(message?.method)) return message;
  return {
    ...message,
    params: {
      ...(message.params || {}),
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
    },
  };
}

function observeClientMessage(message) {
  if (message?.method === "turn/start") {
    const prompt = extractInputText(message.params?.input);
    if (prompt) emit("chatgpt.prompt", { text: prompt });
    emit("turn.requested", {
      model: message.params?.model ?? null,
      effort: message.params?.effort ?? null,
      approvalPolicy: message.params?.approvalPolicy,
    });
  } else if (message?.method === "turn/interrupt") {
    emit("turn.interrupt_requested", {});
  }
}

function observeServerMessage(message) {
  const method = message?.method;
  const params = message?.params || {};
  if (typeof method !== "string") return;
  if (/reasoning/i.test(method)) return;
  if (params.threadId && session.threadId !== params.threadId) {
    session.threadId = params.threadId;
    persistSession();
  }
  if (method === "thread/started" && params.thread?.id) {
    session.threadId = params.thread.id;
    session.status = "running";
    persistSession();
    emit("thread.started", { threadId: session.threadId });
    return;
  }
  if (method === "turn/started") {
    session.turnId = params.turn?.id || params.turnId || session.turnId;
    session.status = "running";
    persistSession();
    emit("turn.started", { turnId: session.turnId });
    return;
  }
  if (method === "turn/completed") {
    emit("turn.completed", { status: params.turn?.status || params.status || "completed" });
    return;
  }
  if (method === "thread/settings/updated") {
    emit("settings.updated", sanitize(params.threadSettings || {}));
    return;
  }
  if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
    emit("assistant.delta", { text: safeText(params.delta, 32768) });
    return;
  }
  if (method === "item/started" || method === "item/completed") {
    const item = sanitizeVisibleItem(params.item);
    if (item) emit(method === "item/started" ? "item.started" : "item.completed", { item });
    return;
  }
  if (method === "serverRequest/resolved") {
    emit("approval.server_resolved", sanitize(params));
  }
}

function isApprovalRequest(message) {
  return message?.id !== undefined && [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ].includes(message?.method);
}

function holdApproval(message) {
  const approvalId = randomUUID();
  const pendingFile = join(approvalsDir, `${approvalId}.pending.json`);
  const decisionFile = join(approvalsDir, `${approvalId}.decision.json`);
  const params = sanitize(message.params || {});
  const pending = {
    approvalId, sessionId, requestId: message.id, method: message.method, params,
    cwd, networkAccess, createdAt: Date.now(), decisionFile,
  };
  writePrivateJson(pendingFile, pending);
  session.status = "held";
  persistSession();
  emit("approval.requested", {
    approvalId, method: message.method, params, networkAccess,
    note: "No action will execute until approved.",
  });

  const timer = setInterval(() => {
    if (!existsSync(decisionFile)) return;
    let decision;
    try {
      decision = JSON.parse(readFileSync(decisionFile, "utf8"))?.decision;
    } catch {
      return;
    }
    if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return;
    clearInterval(timer);
    pendingApprovals.delete(approvalId);
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision } })}\n`);
    rmSync(pendingFile, { force: true });
    rmSync(decisionFile, { force: true });
    session.status = pendingApprovals.size ? "held" : "running";
    persistSession();
    emit("approval.resolved", { approvalId, decision });
  }, 100);
  timer.unref?.();
  pendingApprovals.set(approvalId, { timer, pendingFile, decisionFile });
}

function extractInputText(input) {
  if (!Array.isArray(input)) return "";
  return input.filter(item => item?.type === "text" && typeof item.text === "string").map(item => item.text).join("\n").trim();
}

function sanitizeVisibleItem(item) {
  if (!item || typeof item !== "object") return null;
  const type = String(item.type || "");
  if (/reasoning/i.test(type)) return null;
  return sanitize(item);
}

function sanitize(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return safeText(value, 65536);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1));
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/reasoning|encrypted/i.test(key)) continue;
    out[key] = sanitize(item, depth + 1);
  }
  return out;
}

function safeText(value, max = 4096) {
  return String(value ?? "").replaceAll("\0", "").slice(0, max);
}

function emit(type, data) {
  const event = {
    seq: ++sequence, time: new Date().toISOString(), sessionId, cwd,
    threadId: session.threadId, turnId: session.turnId, type, data: sanitize(data),
  };
  try { appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, { mode: 0o600 }); }
  catch { /* monitoring must never widen or break the execution boundary */ }
  // Mirror the exact same sanitized public event into the app-server stream.
  // The adapter reserves this notification and can expose it incrementally to
  // ChatGPT without independently parsing raw logs or private reasoning.
  try {
    process.stdout.write(`${JSON.stringify({ method: "localCodex/visibleEvent", params: { event } })}\n`);
  } catch { /* the local JSONL stream remains authoritative for the host TUI */ }
}

function persistSession() {
  session.updatedAt = Date.now();
  writePrivateJson(sessionFile, session);
}

function writePrivateJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

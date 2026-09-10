#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import {
  createTraceStoreFromEnv,
  folderFingerprint,
  newTraceId,
} from "../observability.mjs";

const SECURE_BIN = process.env.LOCAL_CODEX_SECURE_BIN;
if (!SECURE_BIN || !isAbsolute(SECURE_BIN)) throw new Error("LOCAL_CODEX_SECURE_BIN must be an absolute path");
await access(SECURE_BIN, constants.X_OK);

const requestedArgs = process.argv.slice(2);
const appServerMode = requestedArgs[0] === "app-server";

if (!appServerMode) {
  const child = spawn(SECURE_BIN, requestedArgs, { stdio: "inherit", env: process.env, cwd: process.cwd() });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { try { child.kill(signal); } catch {} });
  }
  child.on("error", () => process.exit(1));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  await runInstrumented();
}

async function runInstrumented() {
  const store = await createTraceStoreFromEnv(process.env);
  const runtimeId = `run_${randomUUID()}`;
  const fp = folderFingerprint(process.cwd());
  let traceContext = null;
  let contextResolved = false;
  const queuedEvents = [];

  const contextPromise = findTraceContext(store, fp, 5000).then(value => {
    traceContext = value || { traceId: newTraceId("runtime"), jobId: undefined };
    contextResolved = true;
    for (const event of queuedEvents.splice(0)) writeEvent(event);
    return traceContext;
  });

  function writeEvent(event) {
    try {
      store.append({
        ...event,
        source: "runtime",
        runtimeId,
        traceId: traceContext?.traceId,
        jobId: traceContext?.jobId,
        folderFingerprint: fp,
      });
    } catch {
      // Observability must never break Codex execution.
    }
  }

  function emit(event, fields = {}) {
    const record = { time: new Date().toISOString(), event, ...fields };
    if (!contextResolved) queuedEvents.push(record);
    else writeEvent(record);
  }

  const child = spawn(SECURE_BIN, requestedArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  emit("codex.process.started");

  const pending = new Map();
  let stdinBuffer = "";
  let stdoutBuffer = "";
  let turnCompleted = false;
  let cleanupStarted = false;

  function inspectOutbound(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.id === undefined || typeof message.method !== "string") return;
    const id = String(message.id);
    const method = message.method;
    pending.set(id, { method, startedAt: Date.now() });
    if (method === "initialize") emit("codex.app_server.initialize.requested");
    else if (method === "thread/start" || method === "thread/resume") emit("codex.thread.requested");
    else if (method === "turn/start") emit("codex.turn.requested");
    else if (method === "turn/interrupt") emit("job.cleanup.requested");
  }

  function inspectInbound(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.id !== undefined && pending.has(String(message.id))) {
      const entry = pending.get(String(message.id));
      pending.delete(String(message.id));
      const stageDurationMs = Date.now() - entry.startedAt;
      const failed = Boolean(message.error);
      if (entry.method === "initialize") {
        emit(failed ? "codex.app_server.failed" : "codex.app_server.ready", {
          stageDurationMs,
          ...(failed ? { errorCode: "app_server_start_failed" } : {}),
        });
      } else if (entry.method === "thread/start" || entry.method === "thread/resume") {
        emit(failed ? "codex.thread.failed" : "codex.thread.started", {
          stageDurationMs,
          ...(failed ? { errorCode: "thread_start_failed" } : {}),
        });
      } else if (entry.method === "turn/start") {
        emit(failed ? "codex.turn.submit_failed" : "codex.turn.submitted", {
          stageDurationMs,
          ...(failed ? { errorCode: "turn_start_failed" } : {}),
        });
      }
      return;
    }
    const method = message?.method;
    const params = message?.params || {};
    if (method === "turn/started") emit("codex.turn.started");
    if (method === "turn/completed") {
      const status = params.turn?.status || params.status || "completed";
      turnCompleted = true;
      emit(status === "completed" ? "codex.turn.completed" : "codex.turn.failed", {
        terminalOutcome: status,
        ...(status === "completed" ? {} : { errorCode: "turn_failed" }),
      });
    }
  }

  child.stdin.on("error", () => {});
  process.stdin.on("data", chunk => {
    child.stdin.write(chunk);
    stdinBuffer += chunk.toString();
    for (;;) {
      const index = stdinBuffer.indexOf("\n");
      if (index < 0) break;
      const line = stdinBuffer.slice(0, index).trim();
      stdinBuffer = stdinBuffer.slice(index + 1);
      if (line) inspectOutbound(line);
    }
  });
  process.stdin.on("end", () => child.stdin.end());
  process.stdin.on("error", () => child.stdin.end());

  child.stdout.on("data", chunk => {
    process.stdout.write(chunk);
    stdoutBuffer += chunk.toString();
    for (;;) {
      const index = stdoutBuffer.indexOf("\n");
      if (index < 0) break;
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line) inspectInbound(line);
    }
  });
  child.stderr.on("data", chunk => process.stderr.write(chunk));

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!cleanupStarted) {
        cleanupStarted = true;
        emit("job.cleanup.started", { detail: signal });
      }
      try { child.kill(signal); } catch {}
    });
  }

  const exit = await new Promise(resolvePromise => {
    child.on("error", () => resolvePromise({ code: 1, signal: null, spawnError: true }));
    child.on("exit", (code, signal) => resolvePromise({ code, signal, spawnError: false }));
  });
  if (!cleanupStarted) {
    cleanupStarted = true;
    emit("job.cleanup.started", { detail: exit.spawnError ? "spawn_error" : "process_exit" });
  }
  emit("job.cleanup.completed", {
    processExitCode: exit.code ?? undefined,
    processSignal: exit.signal ?? undefined,
    ...(exit.spawnError ? { errorCode: "app_server_start_failed" } : {}),
    observed: true,
  });
  if (!turnCompleted && exit.spawnError) emit("codex.app_server.failed", { errorCode: "app_server_start_failed" });
  await contextPromise;
  process.exit(exit.code ?? (exit.signal ? 1 : 0));
}

async function findTraceContext(store, fingerprint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const record = await store.loadFolderTrace(fingerprint);
      if (record?.traceId) return record;
    } catch {
      return null;
    }
    if (Date.now() >= deadline) return null;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
  }
}

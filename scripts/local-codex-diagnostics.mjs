#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createTraceStoreFromEnv } from "../observability.mjs";

const command = process.argv[2] || "doctor";

function parsePort(value) {
  const port = Number(value || "8765");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("LOCAL_CODEX_PORT must be an integer between 1 and 65535");
  return port;
}

function endpoint(env = process.env) {
  const host = env.LOCAL_CODEX_HOST || "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(host)) throw new Error("LOCAL_CODEX_HOST must be loopback");
  return `http://${host === "::1" ? "[::1]" : host}:${parsePort(env.LOCAL_CODEX_PORT)}`;
}

async function token(env = process.env) {
  if (!env.LOCAL_CODEX_TOKEN_FILE) throw new Error("LOCAL_CODEX_TOKEN_FILE is required");
  return (await readFile(env.LOCAL_CODEX_TOKEN_FILE, "utf8")).trim();
}

let rpcSequence = 0;
async function mcpRequest(message, env = process.env, timeoutMs = 25000) {
  const response = await fetch(`${endpoint(env)}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: await token(env) },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(`MCP HTTP ${response.status}`), { response: body });
  return body;
}

async function callTool(name, args, env = process.env, timeoutMs = 25000) {
  const body = await mcpRequest({
    jsonrpc: "2.0", id: ++rpcSequence, method: "tools/call", params: { name, arguments: args },
  }, env, timeoutMs);
  const structured = body?.result?.structuredContent;
  if (!structured || body?.result?.isError || structured.status === "error") {
    const error = new Error(structured?.message || `Local Codex tool ${name} failed`);
    error.errorCode = structured?.errorCode || "mcp_validation_failed";
    error.structured = structured;
    throw error;
  }
  return structured;
}

async function spawnVersion(binary) {
  return new Promise(resolvePromise => {
    let output = "";
    let settled = false;
    let timer;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(value); } };
    let child;
    try { child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return finish({ ok: false, detail: "not executable" }); }
    timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish({ ok: false, detail: "timed out" }); }, 2000);
    timer.unref();
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 256) output = output.slice(0, 256); });
    child.on("error", () => finish({ ok: false, detail: "spawn failed" }));
    child.on("exit", code => finish(code === 0
      ? { ok: true, detail: output.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim().slice(0, 128) || "available" }
      : { ok: false, detail: `exit ${code}` }));
  });
}

function row(check, level, detail) {
  return { check, level, detail: String(detail || "").replace(/\s+/gu, " ").slice(0, 180) };
}

function printRows(rows) {
  const checkWidth = Math.max(5, ...rows.map(item => item.check.length));
  const levelWidth = 6;
  process.stdout.write(`${"CHECK".padEnd(checkWidth)}  ${"RESULT".padEnd(levelWidth)}  DETAIL\n`);
  for (const item of rows) process.stdout.write(`${item.check.padEnd(checkWidth)}  ${item.level.padEnd(levelWidth)}  ${item.detail}\n`);
}

export async function runDoctor(env = process.env) {
  const rows = [];
  const configFile = env.LOCAL_CODEX_CONFIG_FILE;
  if (configFile) {
    try { await access(configFile, constants.R_OK); rows.push(row("config", "PASS", "configuration readable")); }
    catch { rows.push(row("config", "FAIL", "configuration unreadable")); }
  } else rows.push(row("config", "WARN", "LOCAL_CODEX_CONFIG_FILE not set; using environment/defaults"));

  let auth = null;
  try {
    auth = await token(env);
    const tokenStat = await stat(env.LOCAL_CODEX_TOKEN_FILE);
    const privateMode = (tokenStat.mode & 0o077) === 0;
    rows.push(row("token", privateMode && auth ? "PASS" : "FAIL", privateMode ? "private permissions" : `mode ${(tokenStat.mode & 0o777).toString(8)} is too broad`));
  } catch { rows.push(row("token", "FAIL", "token missing or unreadable")); }

  let health = null;
  try {
    const response = await fetch(`${endpoint(env)}/healthz`, { signal: AbortSignal.timeout(1500) });
    health = await response.json();
    rows.push(row("proxy_health", response.ok ? "PASS" : "FAIL", response.ok ? "trace proxy responding" : `HTTP ${response.status}`));
  } catch { rows.push(row("proxy_health", "FAIL", "trace proxy unreachable")); }

  let ready = null;
  try {
    const response = await fetch(`${endpoint(env)}/readyz`, { signal: AbortSignal.timeout(3000) });
    ready = await response.json();
    rows.push(row("adapter_ready", ready?.dependencies?.adapter === "ready" ? "PASS" : "FAIL", ready?.dependencies?.adapter || ready?.status || `HTTP ${response.status}`));
    rows.push(row("trace_storage", ready?.dependencies?.traceStorage === "ready" ? "PASS" : "FAIL", ready?.dependencies?.traceStorage || "unknown"));
    rows.push(row("scheduler", ready?.dependencies?.scheduler === "ready" ? "PASS" : "FAIL", `${ready?.dependencies?.scheduler || "unknown"}; active=${ready?.activeCalls ?? "?"} queued=${ready?.queuedCalls ?? "?"}`));
    rows.push(row("runtime_cleanup", ready?.dependencies?.runtimeCleanup === "ready" ? "PASS" : "FAIL", ready?.dependencies?.runtimeCleanup || "unknown"));
    rows.push(row("polling_lease", ready?.dependencies?.pollingLease === "ready" ? "PASS" : "FAIL", ready?.pollLeaseMs ? `${ready.pollLeaseMs} ms` : "unknown"));
    const tunnelState = ready?.dependencies?.tunnelClient || "unknown";
    rows.push(row("tunnel_client", tunnelState === "ready" ? "PASS" : ["not_started", "unknown"].includes(tunnelState) ? "WARN" : "FAIL", tunnelState));
  } catch {
    rows.push(row("adapter_ready", "FAIL", "readyz unavailable"));
    rows.push(row("trace_storage", "FAIL", "readyz unavailable"));
    rows.push(row("scheduler", "FAIL", "readyz unavailable"));
    rows.push(row("runtime_cleanup", "FAIL", "readyz unavailable"));
    rows.push(row("polling_lease", "FAIL", "readyz unavailable"));
    rows.push(row("tunnel_client", "WARN", "not observable"));
  }

  const version = await spawnVersion(env.LOCAL_CODEX_REAL_BIN || "codex");
  rows.push(row("codex_cli", version.ok ? "PASS" : "FAIL", version.detail));

  const stateFile = env.LOCAL_CODEX_STATE_FILE || resolve(process.env.HOME || ".", "Library/Application Support/local-codex-tunnel/threads.json");
  const stateDir = dirname(stateFile);
  try {
    const probe = resolve(stateDir, `.doctor-write-${process.pid}-${randomUUID().slice(0, 8)}`);
    await writeFile(probe, "ok\n", { mode: 0o600 });
    await chmod(probe, 0o600);
    await rm(probe, { force: true });
    rows.push(row("storage_rw", "PASS", "private state directory writable"));
  } catch { rows.push(row("storage_rw", "FAIL", "private state directory is not writable")); }

  if (auth) {
    try {
      await mcpRequest({ jsonrpc: "2.0", id: ++rpcSequence, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "local-codex-doctor", version: "1" }, capabilities: {} } }, env, 3000);
      const list = await mcpRequest({ jsonrpc: "2.0", id: ++rpcSequence, method: "tools/list", params: {} }, env, 3000);
      const tools = list?.result?.tools || [];
      const required = ["codex", "codex-status", "codex-trace-receipt"];
      const missing = required.filter(name => !tools.some(tool => tool?.name === name));
      rows.push(row("local_mcp", missing.length ? "FAIL" : "PASS", missing.length ? `missing tools: ${missing.join(", ")}` : `${tools.length} tools; trace schema present`));
    } catch { rows.push(row("local_mcp", "FAIL", "authenticated MCP request path failed")); }
  } else rows.push(row("local_mcp", "FAIL", "token unavailable"));

  printRows(rows);
  process.stdout.write("\nNOTE: local-codex-doctor can verify the local adapter, tunnel-client health endpoint, Codex runtime and MCP path. It cannot prove that a real ChatGPT turn traversed the OpenAI tunnel; use the ChatGPT canary and its trace receipt for that proof.\n");
  const failed = rows.some(item => item.level === "FAIL");
  return { ok: !failed, rows, health, ready };
}

export async function runCanary(env = process.env) {
  const stateFile = env.LOCAL_CODEX_STATE_FILE || resolve(process.env.HOME || ".", "Library/Application Support/local-codex-tunnel/threads.json");
  const stateDir = dirname(stateFile);
  const cwd = await mkdtemp(resolve(stateDir, "canary-"));
  const requestId = `local-canary-${randomUUID()}`;
  const timeoutMs = Number(env.LOCAL_CODEX_CANARY_TIMEOUT_MS || "180000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 1800000) throw new Error("LOCAL_CODEX_CANARY_TIMEOUT_MS must be between 10000 and 1800000");
  let jobId = null;
  let traceId = null;
  let final = null;
  try {
    const submitted = await callTool("codex", {
      requestId,
      cwd,
      prompt: "Reply with exactly LOCAL_CODEX_CANARY_OK",
      worktree: false,
      networkAccess: false,
      browserAccess: false,
    }, env, 30000);
    jobId = submitted.jobId;
    traceId = submitted.traceId;
    if (!jobId) throw new Error("canary submission did not return jobId");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() >= deadline) throw new Error("local canary deadline exceeded");
      final = await callTool("codex-status", { jobId, waitMs: 20000 }, env, 25000);
      if (["completed", "failed", "cancelled", "timed_out", "interrupted"].includes(final.status)) break;
    }
    if (final.status !== "completed") {
      const error = new Error(`local canary ended ${final.status}`);
      error.errorCode = final.errorCode;
      throw error;
    }
    if (String(final.content || "").trim() !== "LOCAL_CODEX_CANARY_OK") throw new Error("local canary returned unexpected content");
    const receipt = await callTool("codex-trace-receipt", { jobId }, env, 5000);
    const output = {
      status: "PASS",
      jobId,
      traceId: traceId || receipt.traceId,
      terminalOutcome: final.status,
      receipt,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output;
  } catch (error) {
    if (jobId && !final?.status?.match(/^(completed|failed|cancelled|timed_out|interrupted)$/)) {
      try { await callTool("codex-cancel", { jobId }, env, 5000); } catch {}
    }
    const output = { status: "FAIL", jobId, traceId, errorCode: error.errorCode || "canary_failed", message: error.message };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    throw Object.assign(error, { canaryOutput: output });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function runReceipt(jobId, env = process.env) {
  if (!jobId) throw new Error("usage: local-codex-receipt <jobId>");
  const store = await createTraceStoreFromEnv(env);
  const receipt = await store.receipt(jobId);
  if (!receipt) throw new Error("No trace exists for this job");
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

async function main() {
  if (command === "doctor") {
    const result = await runDoctor();
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === "canary") {
    await runCanary();
    return;
  }
  if (command === "receipt") {
    await runReceipt(process.argv[3]);
    return;
  }
  throw new Error(`unknown diagnostics command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`${error?.message || "Local Codex diagnostics failed"}\n`);
    process.exitCode = 1;
  });
}

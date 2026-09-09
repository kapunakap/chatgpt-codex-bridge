#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  TERMINAL_JOB_STATUSES,
  createTraceStoreFromEnv,
  folderFingerprint,
  newTraceId,
  normalizeErrorCode,
  requestHash,
} from "../observability.mjs";

const MAX_BODY = 1024 * 1024;
const BRIDGE_VERSION = "3.6.0";
const RECEIPT_TOOL = {
  name: "codex-trace-receipt",
  title: "Local Codex Trace Receipt",
  description: "Return a sanitized end-to-end observability receipt for one Local Codex job. The receipt contains stage names/timings and normalized error codes, but never prompts, reasoning, file contents, credentials, account identifiers, or private absolute paths.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { jobId: { type: "string", minLength: 1, maxLength: 200 } },
    required: ["jobId"],
  },
  outputSchema: {
    type: "object",
    additionalProperties: true,
    properties: {
      status: { type: "string", enum: ["ok", "error"] },
      traceId: { type: "string" },
      jobId: { type: "string" },
      pass: { type: "boolean" },
      message: { type: "string" },
    },
    required: ["status"],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} must be an integer between 1 and 65535`);
  return port;
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1";
}

function authorized(expectedAuthorization, header) {
  const expected = Buffer.from(expectedAuthorization);
  const actual = Buffer.from(header || "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
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
    const chunks = [];
    let size = 0;
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
    req.on("aborted", () => rejectPromise(Object.assign(new Error("request aborted"), { errorCode: "cancelled" })));
  });
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function extractTool(message) {
  if (message?.method !== "tools/call") return null;
  const name = message.params?.name;
  return typeof name === "string" ? name : null;
}

function extractStructured(response) {
  return response?.result?.structuredContent && typeof response.result.structuredContent === "object"
    ? response.result.structuredContent : null;
}

function augmentToolResult(response, fields) {
  const structured = extractStructured(response);
  if (!structured) return response;
  Object.assign(structured, fields);
  if (Array.isArray(response.result?.content)) {
    const text = response.result.content.find(item => item?.type === "text" && typeof item.text === "string");
    if (text) text.text = JSON.stringify(structured);
  }
  return response;
}

function augmentToolSchemas(response) {
  const list = response?.result?.tools;
  if (!Array.isArray(list)) return response;
  for (const tool of list) {
    if (!["codex", "codex-reply", "codex-status", "codex-cancel"].includes(tool?.name)) continue;
    tool.outputSchema ??= { type: "object", properties: {}, additionalProperties: true };
    tool.outputSchema.properties ??= {};
    tool.outputSchema.properties.traceId = { type: "string", description: "Adapter-bound trace identifier for this job." };
    tool.outputSchema.properties.requestTraceId = { type: "string", description: "Trace identifier for this individual MCP request." };
    tool.outputSchema.properties.traceTimings = {
      type: "object",
      additionalProperties: { type: "number" },
      description: "Bounded operational timings in milliseconds; never prompt or content data.",
    };
  }
  if (!list.some(tool => tool?.name === RECEIPT_TOOL.name)) list.push(RECEIPT_TOOL);
  return response;
}

async function spawnVersion(binary) {
  return new Promise(resolvePromise => {
    let settled = false;
    let stdout = "";
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(value); } };
    let child;
    let timer;
    try { child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return finish({ healthy: false, errorCode: "codex_unavailable" }); }
    timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish({ healthy: false, errorCode: "codex_unavailable" }); }, 1500);
    timer.unref();
    child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 256) stdout = stdout.slice(0, 256); });
    child.on("error", () => finish({ healthy: false, errorCode: "codex_unavailable" }));
    child.on("exit", code => finish(code === 0
      ? { healthy: true, version: stdout.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim().slice(0, 128) }
      : { healthy: false, errorCode: "codex_unavailable" }));
  });
}

export async function createTraceProxy(options = {}) {
  const env = options.env || process.env;
  const host = options.host || env.LOCAL_CODEX_HOST || "127.0.0.1";
  if (!isLoopback(host)) throw new Error("LOCAL_CODEX_HOST must be loopback");
  const port = options.port || parsePort(env.LOCAL_CODEX_PORT || "8765", "LOCAL_CODEX_PORT");
  const adapterHost = options.adapterHost || env.LOCAL_CODEX_ADAPTER_HOST || "127.0.0.1";
  if (!isLoopback(adapterHost)) throw new Error("LOCAL_CODEX_ADAPTER_HOST must be loopback");
  const adapterPort = options.adapterPort || parsePort(env.LOCAL_CODEX_ADAPTER_PORT || String(port === 65535 ? 8766 : port + 1), "LOCAL_CODEX_ADAPTER_PORT");
  if (adapterPort === port && adapterHost === host) throw new Error("trace proxy and adapter must use different loopback ports");
  const tokenFile = options.tokenFile || env.LOCAL_CODEX_TOKEN_FILE;
  if (!tokenFile) throw new Error("LOCAL_CODEX_TOKEN_FILE is required");
  const expectedAuthorization = (await readFile(tokenFile, "utf8")).trim();
  if (!expectedAuthorization) throw new Error("local adapter token is empty");
  const traceStore = options.traceStore || await createTraceStoreFromEnv(env);
  const realCodexBin = env.LOCAL_CODEX_REAL_BIN || "codex";
  const sourceCommit = typeof env.LOCAL_CODEX_BRIDGE_SOURCE_COMMIT === "string" ? env.LOCAL_CODEX_BRIDGE_SOURCE_COMMIT.slice(0, 80) : "unknown";
  const tunnelHealthUrlFile = env.LOCAL_CODEX_TUNNEL_HEALTH_URL_FILE || null;
  const requestStats = { total: 0, transportFailures: 0, outcomes: new Map() };
  let codexProbe = { checkedAt: 0, healthy: false, errorCode: "codex_unavailable" };

  async function probeCodex() {
    if (Date.now() - codexProbe.checkedAt < 15000) return codexProbe;
    const value = await spawnVersion(realCodexBin);
    codexProbe = { ...value, checkedAt: Date.now() };
    return codexProbe;
  }

  async function probeTunnel() {
    if (!tunnelHealthUrlFile) return { healthy: false, status: "unknown" };
    let url;
    try { url = (await readFile(tunnelHealthUrlFile, "utf8")).trim(); } catch { return { healthy: false, status: "not_started" }; }
    if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d+\//.test(`${url}/`)) return { healthy: false, status: "invalid_health_url" };
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      return { healthy: response.ok, status: response.ok ? "ready" : `http_${response.status}` };
    } catch { return { healthy: false, status: "unreachable" }; }
  }

  async function fetchAdapter(path, init = {}) {
    return fetch(`http://${adapterHost}:${adapterPort}${path}`, init);
  }

  async function adapterJson(path) {
    const response = await fetchAdapter(path, { signal: AbortSignal.timeout(1200) });
    const body = await response.json();
    return { response, body };
  }

  async function observeSnapshot(snapshot, record, pollGapMs) {
    if (!snapshot || !record?.traceId || !snapshot.jobId) return record;
    const now = Date.now();
    const fp = typeof snapshot.cwd === "string" ? folderFingerprint(snapshot.cwd) : record.folderFingerprint;
    const common = {
      source: "proxy", traceId: record.traceId, jobId: snapshot.jobId, tool: record.tool,
      bridgeVersion: BRIDGE_VERSION, sourceCommit,
      folderFingerprint: fp, adapterVersion: snapshot.adapterVersion, schemaFingerprint: snapshot.schemaFingerprint,
      model: snapshot.model, reasoningEffort: snapshot.reasoningEffort,
      networkAccess: snapshot.networkAccess, browserAccess: snapshot.browserAccess,
    };
    if (["starting", "running", "cancelling"].includes(snapshot.status) && !["starting", "running", "cancelling"].includes(record.lastStatus)) {
      traceStore.append({ ...common, event: "job.started", status: snapshot.status, stageDurationMs: now - record.createdAt });
    }
    if (snapshot.threadId && !record.threadObserved) {
      traceStore.append({ ...common, event: "codex.thread.observed", status: snapshot.status, stageDurationMs: now - record.createdAt, observed: true });
      record.threadObserved = true;
    }
    if (snapshot.turnId && !record.turnObserved) {
      traceStore.append({ ...common, event: "codex.turn.observed", status: snapshot.status, stageDurationMs: now - record.createdAt, observed: true });
      record.turnObserved = true;
    }
    if (snapshot.errorCode === "polling_expired" && record.lastStatus !== snapshot.status) {
      traceStore.append({ ...common, event: "job.polling_expired", status: snapshot.status, errorCode: "polling_expired", terminalOutcome: snapshot.status });
    }
    if (TERMINAL_JOB_STATUSES.has(snapshot.status) && !record.terminalObserved) {
      const errorCode = normalizeErrorCode(snapshot.errorCode);
      traceStore.append({ ...common, event: "job.result.persisted", status: snapshot.status, errorCode, terminalOutcome: snapshot.status });
      traceStore.append({ ...common, event: "job.terminal.observed", status: snapshot.status, errorCode, terminalOutcome: snapshot.status, pollGapMs, observed: true });
      record.terminalObserved = true;
      const outcome = snapshot.status === "completed" ? "completed" : errorCode || snapshot.status;
      requestStats.outcomes.set(outcome, (requestStats.outcomes.get(outcome) || 0) + 1);
    }
    record.folderFingerprint = fp;
    record.lastStatus = snapshot.status;
    record.updatedAt = now;
    traceStore.saveJobTrace(snapshot.jobId, record);
    if (fp) traceStore.saveFolderTrace(fp, { traceId: record.traceId, jobId: snapshot.jobId, createdAt: record.createdAt });
    return record;
  }

  async function handleLocalReceipt(message, requestTraceId) {
    const jobId = message.params?.arguments?.jobId;
    if (typeof jobId !== "string" || !jobId || jobId.length > 200) {
      return toolResult(message.id, { status: "error", message: "jobId must be a non-empty string no longer than 200 characters", requestTraceId }, true);
    }
    let receipt;
    try { receipt = await traceStore.receipt(jobId); }
    catch { return toolResult(message.id, { status: "error", message: "Trace receipt storage is unavailable", requestTraceId }, true); }
    if (!receipt) return toolResult(message.id, { status: "error", message: "No trace exists for this job", requestTraceId }, true);
    return toolResult(message.id, { status: "ok", ...receipt, requestTraceId });
  }

  const server = createServer(async (req, res) => {
    const disconnect = new AbortController();
    res.once("close", () => disconnect.abort());
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        let adapterReachable = false;
        try { adapterReachable = (await fetchAdapter("/healthz", { signal: AbortSignal.timeout(500) })).ok; } catch {}
        return json(res, 200, { status: "ok", component: "local-codex-trace-proxy", adapterReachable });
      }
      if (req.method === "GET" && req.url === "/readyz") {
        let adapter;
        try { adapter = await adapterJson("/readyz"); }
        catch {
          return json(res, 503, {
            status: "unavailable", component: "local-codex-trace-proxy",
            dependencies: { proxy: "ready", adapter: "unreachable", traceStorage: traceStore.healthy ? "ready" : "failed" },
          });
        }
        const [codex, tunnel, storage] = await Promise.all([probeCodex(), probeTunnel(), traceStore.storageStatus()]);
        const localReady = adapter.response.ok && storage.healthy && codex.healthy;
        return json(res, localReady ? 200 : 503, {
          ...adapter.body,
          adapterVersion: adapter.body?.version || null,
          version: BRIDGE_VERSION,
          status: localReady ? "ready" : "unavailable",
          component: "local-codex-trace-proxy",
          integrationStatus: localReady && tunnel.healthy ? "end_to_end_ready" : localReady ? "local_ready_tunnel_unverified" : "unavailable",
          dependencies: {
            proxy: "ready",
            adapter: adapter.response.ok ? "ready" : "unavailable",
            traceStorage: storage.healthy ? "ready" : "failed",
            codexCli: codex.healthy ? "ready" : "unavailable",
            scheduler: adapter.body?.queuedCalls >= adapter.body?.maxQueue ? "saturated" : "ready",
            runtimeCleanup: adapter.body?.status === "ready" ? "ready" : "unavailable",
            pollingLease: Number.isFinite(adapter.body?.pollLeaseMs) ? "ready" : "unknown",
            browser: adapter.body?.browserAccessStatus || "unknown",
            tunnelClient: tunnel.status,
          },
          observability: {
            schemaVersion: 1,
            version: BRIDGE_VERSION,
            sourceCommit,
            traceStorageHealthy: storage.healthy,
            requestCount: requestStats.total,
            transportFailures: requestStats.transportFailures,
            terminalOutcomes: Object.fromEntries(requestStats.outcomes),
          },
          codexCliVersion: codex.version || null,
        });
      }
      if (!authorized(expectedAuthorization, req.headers.authorization)) return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && req.url === "/diagnostics") {
        const readyResponse = await fetch(`http://${host}:${server.address().port}/readyz`, { signal: AbortSignal.timeout(2500) });
        return json(res, readyResponse.status, await readyResponse.json());
      }
      if (req.url !== "/mcp" || req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return json(res, 405, { error: "method not allowed" });
      }

      const requestStartedAt = Date.now();
      requestStats.total += 1;
      const raw = await readBody(req);
      const requestTraceId = newTraceId("req");
      let message;
      try { message = JSON.parse(raw); }
      catch {
        traceStore.append({ source: "proxy", event: "mcp.request.rejected", requestTraceId, errorCode: "mcp_validation_failed" });
        return json(res, 200, rpcError(null, -32700, "parse error"));
      }
      const tool = extractTool(message);
      let traceId = newTraceId("trc");
      let jobRecord = null;
      let pollGapMs;
      if (["codex-status", "codex-cancel"].includes(tool)) {
        try { jobRecord = await traceStore.loadJobTrace(message.params?.arguments?.jobId); } catch {}
        if (jobRecord?.traceId) traceId = jobRecord.traceId;
      }
      traceStore.append({ source: "proxy", event: "mcp.request.received", traceId, requestTraceId, tool: tool || message.method, elapsedMs: 0, bridgeVersion: BRIDGE_VERSION, sourceCommit });
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        traceStore.append({ source: "proxy", event: "mcp.request.rejected", traceId, requestTraceId, tool: tool || "unknown", errorCode: "mcp_validation_failed" });
        return json(res, 200, rpcError(message?.id ?? null, -32600, "invalid request"));
      }
      traceStore.append({ source: "proxy", event: "mcp.request.validated", traceId, requestTraceId, tool: tool || message.method, stageDurationMs: Date.now() - requestStartedAt, bridgeVersion: BRIDGE_VERSION, sourceCommit });

      if (tool === RECEIPT_TOOL.name) {
        const localResponse = await handleLocalReceipt(message, requestTraceId);
        const localStructured = extractStructured(localResponse);
        const localTraceId = localStructured?.traceId || traceId;
        traceStore.append({ source: "proxy", event: "mcp.response.sent", traceId: localTraceId, requestTraceId, tool, elapsedMs: Date.now() - requestStartedAt });
        return json(res, 200, localResponse, { "Mcp-Session-Id": "local-codex" });
      }

      if (tool === "codex-status" && jobRecord) {
        const now = Date.now();
        pollGapMs = jobRecord.lastPollAt ? now - jobRecord.lastPollAt : 0;
        jobRecord.lastPollAt = now;
        traceStore.saveJobTrace(jobRecord.jobId, jobRecord);
        traceStore.append({ source: "proxy", event: "status.poll.received", traceId, requestTraceId, jobId: jobRecord.jobId, tool, pollGapMs });
      }

      let adapterResponse;
      try {
        adapterResponse = await fetchAdapter("/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: req.headers.authorization, "Mcp-Session-Id": req.headers["mcp-session-id"] || "local-codex" },
          body: raw,
          signal: disconnect.signal,
        });
      } catch {
        requestStats.transportFailures += 1;
        traceStore.append({ source: "proxy", event: "mcp.transport.failed", traceId, requestTraceId, tool: tool || message.method, errorCode: "transport_unreachable", elapsedMs: Date.now() - requestStartedAt });
        return json(res, 502, rpcError(message.id ?? null, -32603, "Local Codex adapter is unreachable"));
      }
      const text = await adapterResponse.text();
      let response;
      try { response = text ? JSON.parse(text) : null; }
      catch {
        traceStore.append({ source: "proxy", event: "mcp.transport.failed", traceId, requestTraceId, tool: tool || message.method, errorCode: "transport_unreachable", elapsedMs: Date.now() - requestStartedAt });
        return json(res, 502, rpcError(message.id ?? null, -32603, "Local Codex adapter returned invalid JSON"));
      }
      if (message.method === "initialize" && response?.result?.serverInfo) response.result.serverInfo.version = BRIDGE_VERSION;
      if (message.method === "tools/list") augmentToolSchemas(response);
      const snapshot = extractStructured(response);

      if (["codex", "codex-reply"].includes(tool) && snapshot?.jobId) {
        const fp = typeof snapshot.cwd === "string" ? folderFingerprint(snapshot.cwd) : undefined;
        const createdAt = Date.now();
        jobRecord = traceStore.saveJobTrace(snapshot.jobId, {
          traceId, jobId: snapshot.jobId, tool, requestHash: requestHash(message.params?.arguments?.requestId),
          folderFingerprint: fp, createdAt, lastStatus: snapshot.status,
        });
        if (fp) traceStore.saveFolderTrace(fp, { traceId, jobId: snapshot.jobId, createdAt });
        traceStore.append({
          source: "proxy", event: "job.accepted", traceId, requestTraceId, jobId: snapshot.jobId, tool,
          status: snapshot.status, folderFingerprint: fp, model: snapshot.model, reasoningEffort: snapshot.reasoningEffort,
          networkAccess: snapshot.networkAccess, browserAccess: snapshot.browserAccess,
          stageDurationMs: Date.now() - requestStartedAt, adapterVersion: snapshot.adapterVersion, schemaFingerprint: snapshot.schemaFingerprint, bridgeVersion: BRIDGE_VERSION, sourceCommit,
        });
        if (snapshot.status === "queued") traceStore.append({ source: "proxy", event: "job.queued", traceId, jobId: snapshot.jobId, tool, status: snapshot.status, folderFingerprint: fp });
        if (["starting", "running"].includes(snapshot.status)) traceStore.append({ source: "proxy", event: "job.started", traceId, jobId: snapshot.jobId, tool, status: snapshot.status, folderFingerprint: fp });
        await observeSnapshot(snapshot, jobRecord, 0);
      } else if (["codex-status", "codex-cancel"].includes(tool) && snapshot?.jobId && jobRecord) {
        await observeSnapshot(snapshot, jobRecord, pollGapMs || 0);
      }

      if (snapshot && jobRecord?.traceId) {
        augmentToolResult(response, { traceId: jobRecord.traceId, requestTraceId, traceTimings: { mcpRequestMs: Date.now() - requestStartedAt, ...(pollGapMs !== undefined ? { pollGapMs } : {}) } });
      }
      traceStore.append({ source: "proxy", event: "mcp.response.sent", traceId: jobRecord?.traceId || traceId, requestTraceId, jobId: snapshot?.jobId, tool: tool || message.method, elapsedMs: Date.now() - requestStartedAt });
      return json(res, adapterResponse.status, response, { "Mcp-Session-Id": adapterResponse.headers.get("mcp-session-id") || "local-codex" });
    } catch (error) {
      return json(res, error?.statusCode || 500, rpcError(null, -32603, "Local Codex observability proxy failed"));
    }
  });

  return {
    server,
    traceStore,
    host,
    port,
    adapterHost,
    adapterPort,
    listen() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(port, host, () => {
          server.removeListener("error", rejectPromise);
          resolvePromise(server.address());
        });
      });
    },
    close() {
      return new Promise(resolvePromise => {
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      });
    },
  };
}

async function main() {
  const proxy = await createTraceProxy();
  await proxy.listen();
  process.stderr.write(`local-codex-trace-proxy ready on http://${proxy.host}:${proxy.port}/mcp; adapter=${proxy.adapterHost}:${proxy.adapterPort}\n`);
  const shutdown = () => { void proxy.close().then(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`local-codex-trace-proxy failed: ${error?.message || "unknown error"}\n`);
    process.exit(1);
  });
}

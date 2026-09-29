import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const TRACE_SCHEMA_VERSION = 1;
export const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);

const SAFE_EVENT_KEYS = new Set([
  "schemaVersion", "time", "source", "event", "traceId", "requestTraceId", "runtimeId",
  "jobId", "tool", "status", "errorCode", "folderFingerprint", "model", "reasoningEffort",
  "networkAccess", "browserAccess", "elapsedMs", "stageDurationMs", "queueDepth", "activeCount",
  "pollGapMs", "processExitCode", "processSignal", "adapterVersion", "schemaFingerprint", "bridgeVersion", "sourceCommit",
  "requestHash", "terminalOutcome", "observed", "detail", "dependency", "healthy",
]);
const STRING_LIMITS = {
  source: 64, event: 96, traceId: 96, requestTraceId: 96, runtimeId: 96, jobId: 200,
  tool: 96, status: 64, errorCode: 96, folderFingerprint: 80, model: 200,
  reasoningEffort: 32, adapterVersion: 64, schemaFingerprint: 128, bridgeVersion: 64, sourceCommit: 80, requestHash: 80,
  terminalOutcome: 64, detail: 256, dependency: 64, processSignal: 32,
};
const NORMALIZED_ERROR_CODES = new Map([
  ["spawn_failed", "app_server_start_failed"],
  ["server_exit", "app_server_start_failed"],
  ["server_pipe", "app_server_start_failed"],
  ["timeout", "execution_timed_out"],
  ["storage_error", "storage_failed"],
  ["event_storage_error", "storage_failed"],
  ["adapter_restarted", "interrupted"],
  ["request_cancelled", "cancelled"],
  ["job_failed", "turn_failed"],
]);

export function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function folderFingerprint(cwd) {
  return `sha256:${digest(cwd).slice(0, 24)}`;
}

export function requestHash(requestId) {
  return requestId ? `sha256:${digest(requestId).slice(0, 24)}` : undefined;
}

export function newTraceId(prefix = "trc") {
  return `${prefix}_${randomUUID()}`;
}

export function normalizeErrorCode(code) {
  if (!code) return undefined;
  return NORMALIZED_ERROR_CODES.get(code) || String(code).slice(0, 96);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function sanitizeEvent(input) {
  const output = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    time: typeof input.time === "string" ? input.time.slice(0, 64) : new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_EVENT_KEYS.has(key) || key === "schemaVersion" || key === "time" || value === undefined) continue;
    if (typeof value === "string") {
      output[key] = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, STRING_LIMITS[key] || 256);
    } else if (typeof value === "boolean") output[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
  }
  if (output.errorCode) output.errorCode = normalizeErrorCode(output.errorCode);
  return output;
}

function writePrivateJson(target, value) {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  let fd;
  try {
    fd = openSync(temporary, "w", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, target);
    chmodSync(target, 0o600);
    try {
      fd = openSync(dirname(target), "r");
      fsyncSync(fd);
    } catch {
      // Some test/container filesystems do not permit opening a directory for fsync.
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
  }
}

function safeJobId(jobId) {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(jobId)) {
    throw new Error("invalid jobId");
  }
  return jobId;
}

export class TraceStore {
  constructor({ logFile, stateDir, maxBytes = 5 * 1024 * 1024, rotations = 3 } = {}) {
    if (!logFile || !stateDir) throw new Error("trace logFile and stateDir are required");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024 * 1024) {
      throw new Error("trace maxBytes must be between 1024 and 1073741824");
    }
    if (!Number.isSafeInteger(rotations) || rotations < 1 || rotations > 20) {
      throw new Error("trace rotations must be between 1 and 20");
    }
    this.logFile = resolve(logFile);
    this.stateDir = resolve(stateDir);
    this.jobDir = resolve(this.stateDir, "jobs");
    this.folderDir = resolve(this.stateDir, "folders");
    this.maxBytes = maxBytes;
    this.rotations = rotations;
    this.healthy = true;
    this.lastError = null;
  }

  async init() {
    await mkdir(dirname(this.logFile), { recursive: true, mode: 0o700 });
    await mkdir(this.jobDir, { recursive: true, mode: 0o700 });
    await mkdir(this.folderDir, { recursive: true, mode: 0o700 });
    appendFileSync(this.logFile, "", { mode: 0o600 });
    chmodSync(this.logFile, 0o600);
    return this;
  }

  append(event) {
    try {
      this.rotateIfNeeded();
      const clean = sanitizeEvent(event);
      appendFileSync(this.logFile, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
      this.healthy = true;
      this.lastError = null;
      return clean;
    } catch (error) {
      this.healthy = false;
      this.lastError = "trace_storage_failed";
      throw error;
    }
  }

  rotateIfNeeded() {
    let currentSize = 0;
    try { currentSize = statSync(this.logFile).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (currentSize < this.maxBytes) return;
    for (let index = this.rotations; index >= 1; index -= 1) {
      const source = index === 1 ? this.logFile : `${this.logFile}.${index - 1}`;
      const target = `${this.logFile}.${index}`;
      if (!existsSync(source)) continue;
      if (index === this.rotations && existsSync(target)) unlinkSync(target);
      renameSync(source, target);
    }
    appendFileSync(this.logFile, "", { mode: 0o600 });
    chmodSync(this.logFile, 0o600);
  }

  saveJobTrace(jobId, record) {
    safeJobId(jobId);
    const clean = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId: String(record.traceId).slice(0, 96),
      jobId,
      tool: typeof record.tool === "string" ? record.tool.slice(0, 96) : undefined,
      requestHash: typeof record.requestHash === "string" ? record.requestHash.slice(0, 80) : undefined,
      folderFingerprint: typeof record.folderFingerprint === "string" ? record.folderFingerprint.slice(0, 80) : undefined,
      createdAt: safeInteger(record.createdAt) ?? Date.now(),
      updatedAt: Date.now(),
      lastPollAt: safeInteger(record.lastPollAt),
      lastStatus: typeof record.lastStatus === "string" ? record.lastStatus.slice(0, 64) : undefined,
      threadObserved: record.threadObserved === true,
      turnObserved: record.turnObserved === true,
      terminalObserved: record.terminalObserved === true,
    };
    writePrivateJson(resolve(this.jobDir, `${jobId}.json`), clean);
    return clean;
  }

  async loadJobTrace(jobId) {
    safeJobId(jobId);
    try {
      const value = JSON.parse(await readFile(resolve(this.jobDir, `${jobId}.json`), "utf8"));
      if (value?.jobId !== jobId || typeof value.traceId !== "string") return null;
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  saveFolderTrace(fingerprint, record) {
    if (typeof fingerprint !== "string" || !/^sha256:[a-f0-9]{24}$/.test(fingerprint)) throw new Error("invalid folder fingerprint");
    const value = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      folderFingerprint: fingerprint,
      traceId: String(record.traceId).slice(0, 96),
      jobId: safeJobId(record.jobId),
      createdAt: safeInteger(record.createdAt) ?? Date.now(),
      expiresAt: safeInteger(record.expiresAt) ?? Date.now() + 24 * 60 * 60 * 1000,
    };
    writePrivateJson(resolve(this.folderDir, `${fingerprint.slice("sha256:".length)}.json`), value);
    return value;
  }

  async loadFolderTrace(fingerprint) {
    if (typeof fingerprint !== "string" || !/^sha256:[a-f0-9]{24}$/.test(fingerprint)) return null;
    try {
      const value = JSON.parse(await readFile(resolve(this.folderDir, `${fingerprint.slice("sha256:".length)}.json`), "utf8"));
      if (value?.folderFingerprint !== fingerprint || typeof value.traceId !== "string") return null;
      if (Number.isSafeInteger(value.expiresAt) && value.expiresAt < Date.now()) return null;
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async pruneFolderTraces(now = Date.now()) {
    let files;
    try { files = await readdir(this.folderDir); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
    await Promise.all(files.filter(file => /^[a-f0-9]{24}\.json$/.test(file)).map(async file => {
      const target = resolve(this.folderDir, file);
      try {
        const value = JSON.parse(await readFile(target, "utf8"));
        if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < now) await rm(target, { force: true });
      } catch { /* malformed private trace state is ignored here; doctor reports storage issues separately */ }
    }));
  }

  async readEvents({ traceId, jobId, maxEvents = 5000 } = {}) {
    if (!traceId && !jobId) throw new Error("traceId or jobId is required");
    const files = [];
    for (let index = this.rotations; index >= 1; index -= 1) files.push(`${this.logFile}.${index}`);
    files.push(this.logFile);
    const events = [];
    for (const file of files) {
      let text;
      try { text = await readFile(file, "utf8"); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (traceId && event.traceId !== traceId) continue;
        if (jobId && event.jobId !== jobId) continue;
        events.push(event);
        if (events.length >= maxEvents) return events;
      }
    }
    return events;
  }

  async receipt(jobId) {
    const record = await this.loadJobTrace(jobId);
    if (!record) return null;
    const events = await this.readEvents({ traceId: record.traceId });
    const byEvent = new Map();
    for (const event of events) if (!byEvent.has(event.event)) byEvent.set(event.event, event);
    const started = events[0]?.time ?? null;
    const ended = events.at(-1)?.time ?? null;
    const stages = events.map(event => ({
      event: event.event,
      time: event.time,
      ...(Number.isFinite(event.stageDurationMs) ? { stageDurationMs: event.stageDurationMs } : {}),
      ...(Number.isFinite(event.pollGapMs) ? { pollGapMs: event.pollGapMs } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    }));
    const terminalEvent = [...events].reverse().find(event =>
      ["job.terminal.observed", "codex.turn.completed", "codex.turn.failed", "job.polling_expired"].includes(event.event));
    const maxPollGapMs = events.reduce((max, event) => Math.max(max, Number(event.pollGapMs) || 0), 0);
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      pass: terminalEvent?.event === "job.terminal.observed" && terminalEvent?.terminalOutcome === "completed",
      traceId: record.traceId,
      jobId,
      startUtc: started,
      endUtc: ended,
      terminalOutcome: terminalEvent?.terminalOutcome || record.lastStatus || null,
      errorCode: terminalEvent?.errorCode || null,
      maxPollGapMs,
      observedStages: [...new Set(events.map(event => event.event))],
      stages,
      bridge: {
        adapterVersion: [...events].reverse().find(event => event.adapterVersion)?.adapterVersion || null,
        schemaFingerprint: [...events].reverse().find(event => event.schemaFingerprint)?.schemaFingerprint || null,
        observabilityVersion: [...events].reverse().find(event => event.bridgeVersion)?.bridgeVersion || null,
        sourceCommit: [...events].reverse().find(event => event.sourceCommit)?.sourceCommit || null,
      },
    };
  }

  async storageStatus() {
    try {
      const targets = [this.logFile, this.jobDir, this.folderDir];
      const statuses = [];
      for (const target of targets) {
        const details = await stat(target);
        statuses.push({ target: target === this.logFile ? "log" : target === this.jobDir ? "jobs" : "folders", mode: details.mode & 0o777 });
      }
      return { healthy: this.healthy, lastError: this.lastError, targets: statuses };
    } catch {
      return { healthy: false, lastError: "trace_storage_failed", targets: [] };
    }
  }
}

export function traceConfigFromEnv(env = process.env) {
  const stateFile = env.LOCAL_CODEX_STATE_FILE || resolve(process.env.HOME || ".", "Library/Application Support/local-codex-tunnel/threads.json");
  const stateBase = dirname(stateFile);
  const maxBytes = Number(env.LOCAL_CODEX_TRACE_LOG_MAX_BYTES || String(5 * 1024 * 1024));
  const rotations = Number(env.LOCAL_CODEX_TRACE_LOG_ROTATIONS || "3");
  return {
    logFile: env.LOCAL_CODEX_TRACE_LOG_FILE || resolve(stateBase, "trace-events.jsonl"),
    stateDir: env.LOCAL_CODEX_TRACE_STATE_DIR || resolve(stateBase, "traces"),
    maxBytes,
    rotations,
  };
}

export async function createTraceStoreFromEnv(env = process.env) {
  return new TraceStore(traceConfigFromEnv(env)).init();
}

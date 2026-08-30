#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  buildMonitorFrame,
  serializeMonitorFrame,
  VIEW_NAMES,
} from "./local-codex-watch-render.mjs";

const jobsDir = process.env.LOCAL_CODEX_JOBS_DIR;
const stateFile = process.env.LOCAL_CODEX_STATE_FILE;
const tokenFile = process.env.LOCAL_CODEX_TOKEN_FILE;
const host = process.env.LOCAL_CODEX_HOST || "127.0.0.1";
const port = Number(process.env.LOCAL_CODEX_PORT || "8765");
if (!jobsDir || !stateFile || !tokenFile) {
  process.stderr.write("local-codex watch requires LOCAL_CODEX_JOBS_DIR, LOCAL_CODEX_STATE_FILE, and LOCAL_CODEX_TOKEN_FILE\n");
  process.exit(2);
}

const guardDir = join(dirname(stateFile), "guard");
const sessionsDir = join(guardDir, "sessions");
const eventsDir = join(guardDir, "events");
const approvalsDir = join(guardDir, "approvals");
const jobEventsDir = process.env.LOCAL_CODEX_JOB_EVENTS_DIR || join(dirname(stateFile), "job-events");
const renderOnce = process.argv.includes("--once");
const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
let selectedJobId = null;
let view = 0;
let dirty = true;
let quitting = false;
let ready = null;
let follow = true;
let followCutoff = null;
let outputExpanded = false;
let approvalDetails = false;
let searching = false;
let searchQuery = "";
let terminalRestored = false;
let handoffActive = false;
let openConfirmationJobId = null;
let notice = "";
let noticeTimer = null;
let latest = { jobs: [], sessions: [], approvals: [] };

process.stdin.setEncoding("utf8");
process.stdin.resume();
enterMonitorTerminal();
process.on("exit", restoreTerminal);
process.on("SIGINT", () => { if (!handoffActive) quit(); });
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => quit());
process.stdout.on("resize", () => {
  dirty = true;
});
process.stdin.on("data", data => {
  void handleKey(data);
});

setInterval(() => {
  if (handoffActive) return;
  refresh();
  dirty = true;
}, 250).unref();
setInterval(() => {
  if (handoffActive) return;
  void probeReady();
}, 1500).unref();
setInterval(() => {
  if (dirty && !handoffActive) render();
}, 80).unref();

await probeReady();
refresh();
render();
if (renderOnce) {
  restoreTerminal();
  process.exit(0);
}

function refresh() {
  const jobs = readJsonDir(
    jobsDir,
    file => file.endsWith(".json") &&
      !file.endsWith(".pending.json") &&
      !file.endsWith(".decision.json")
  )
    .filter(job => typeof job.jobId === "string")
    .sort((a, b) => rankJob(a) - rankJob(b) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const sessions = readJsonDir(sessionsDir, file => file.endsWith(".json"));
  const jobById = new Map(jobs.map(job => [job.jobId, job]));
  const sessionById = new Map(sessions.map(session => [session.sessionId, session]));
  const approvals = readJsonDir(approvalsDir, file => file.endsWith(".pending.json"))
    .filter(approval => {
      if (approval.jobId) {
        const job = jobById.get(approval.jobId);
        return Boolean(job && !terminalStatuses.has(job.status));
      }
      if (approval.sessionId) {
        const session = sessionById.get(approval.sessionId);
        return Boolean(session && session.status !== "ended");
      }
      return false;
    });
  latest = { jobs, sessions, approvals };
  if (!selectedJobId || !jobById.has(selectedJobId)) {
    selectedJobId = jobs[0]?.jobId || null;
  }
}

async function probeReady() {
  try {
    const response = await fetch("http://" + host + ":" + String(port) + "/readyz", {
      signal: AbortSignal.timeout(800),
    });
    ready = response.ok ? await response.json() : null;
  } catch {
    ready = null;
  }
  dirty = true;
}

function readJsonDir(directory, keep) {
  if (!existsSync(directory)) return [];
  const output = [];
  for (const file of readdirSync(directory)) {
    if (!keep(file)) continue;
    try {
      output.push(JSON.parse(readFileSync(join(directory, file), "utf8")));
    } catch {
      // A file may be between its temporary and final names.
    }
  }
  return output;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-400)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function rankJob(job) {
  if (["starting", "running", "cancelling"].includes(job.status)) return 0;
  if (job.status === "queued") return 1;
  return 2;
}

function sessionFor(job) {
  if (!job) return null;
  const candidates = latest.sessions.filter(session => session.cwd === job.cwd);
  const exact = job.threadId
    ? candidates.filter(session => session.threadId === job.threadId)
    : [];
  if (exact.length) return nearestSession(exact, job);
  const active = candidates
    .filter(session => session.status !== "ended")
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (["starting", "running", "cancelling"].includes(job.status) && active.length) {
    return active[0];
  }
  return nearestSession(candidates, job);
}

function nearestSession(candidates, job) {
  return [...candidates].sort((a, b) => {
    return Math.abs((a.startedAt || 0) - (job.startedAt || 0)) -
      Math.abs((b.startedAt || 0) - (job.startedAt || 0));
  })[0] || null;
}

function approvalsFor(job) {
  if (!job) return [];
  const session = sessionFor(job);
  return latest.approvals
    .filter(item => item.jobId === job.jobId || (session && item.sessionId === session.sessionId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function currentEvents() {
  const job = selectedJob();
  return eventsFor(job, sessionFor(job));
}

function eventsFor(job, session) {
  if (!job) return [];
  const persisted = readJsonl(join(jobEventsDir, job.jobId + ".jsonl"));
  if (persisted.length) return persisted;
  return session ? readJsonl(join(eventsDir, session.sessionId + ".jsonl")) : [];
}

function selectedIndex() {
  return Math.max(0, latest.jobs.findIndex(job => job.jobId === selectedJobId));
}

function selectedJob() {
  return latest.jobs.find(job => job.jobId === selectedJobId) || null;
}

function scopedEvents(events) {
  let scoped = events;
  if (!follow) {
    if (followCutoff === null) followCutoff = events.at(-1)?.seq ?? 0;
    scoped = scoped.filter(event => (event.seq ?? 0) <= followCutoff);
  }
  if (searchQuery) {
    const needle = searchQuery.toLowerCase();
    scoped = scoped.filter(event => {
      try {
        return JSON.stringify(event).toLowerCase().includes(needle);
      } catch {
        return false;
      }
    });
  }
  return scoped;
}

function render() {
  dirty = false;
  const width = process.stdout.columns || 120;
  const height = process.stdout.rows || 36;
  const selected = selectedIndex();
  const job = selectedJob();
  const session = sessionFor(job);
  const approvals = approvalsFor(job);
  const events = scopedEvents(eventsFor(job, session));
  const jobs = latest.jobs.map(candidate => {
    return { ...candidate, held: approvalsFor(candidate).length > 0 };
  });
  const threadCount = new Set([
    ...latest.jobs.map(candidate => candidate.threadId),
    ...latest.sessions.map(candidate => candidate.threadId),
  ].filter(Boolean)).size;
  const lines = buildMonitorFrame({
    width,
    height,
    now: Date.now(),
    jobs,
    selectedIndex: selected,
    job,
    session,
    approvals,
    events,
    view,
    follow,
    outputExpanded,
    approvalDetails,
    searching,
    searchQuery,
    ready,
    heldCount: latest.approvals.length,
    threadCount,
    homeDir: process.env.HOME || "",
    notice,
  });
  process.stdout.write(serializeMonitorFrame(lines));
}

async function handleKey(data) {
  if (quitting || handoffActive) return;
  if (searching) {
    if (data === "\r" || data === "\n") {
      searching = false;
      dirty = true;
      return;
    }
    if (data === "\x1b") {
      searching = false;
      dirty = true;
      return;
    }
    if (data === "\x7f" || data === "\b") {
      searchQuery = searchQuery.slice(0, -1);
      dirty = true;
      return;
    }
    const printable = data.replace(/[\x00-\x1f\x7f]/g, "");
    if (printable) searchQuery = (searchQuery + printable).slice(0, 200);
    dirty = true;
    return;
  }
  if (data !== "o") openConfirmationJobId = null;
  if (data === "q" || data === "\u0003") return quit();
  if (data === "\t") {
    view = (view + 1) % VIEW_NAMES.length;
    dirty = true;
    return;
  }
  if (data === "f") {
    follow = !follow;
    followCutoff = follow ? null : (currentEvents().at(-1)?.seq ?? 0);
    dirty = true;
    return;
  }
  if (data === "/") {
    searching = true;
    searchQuery = "";
    dirty = true;
    return;
  }
  if (data === "l") {
    outputExpanded = !outputExpanded;
    dirty = true;
    return;
  }
  if (data === "d") {
    approvalDetails = !approvalDetails;
    dirty = true;
    return;
  }
  if (data === "j" || data === "\x1b[B") {
    const selected = selectedIndex();
    const next = Math.max(0, Math.min(Math.max(0, latest.jobs.length - 1), selected + 1));
    selectedJobId = latest.jobs[next]?.jobId || null;
    followCutoff = null;
    approvalDetails = false;
    dirty = true;
    return;
  }
  if (data === "k" || data === "\x1b[A") {
    const selected = selectedIndex();
    const next = Math.max(0, selected - 1);
    selectedJobId = latest.jobs[next]?.jobId || null;
    followCutoff = null;
    approvalDetails = false;
    dirty = true;
    return;
  }
  const job = selectedJob();
  const approval = approvalsFor(job)[0];
  if (data === "o") return openInCodex(job);
  if (data === "a" && approval) return decide(approval, "accept");
  if (data === "A" && approval) return decide(approval, "acceptForSession");
  if (data === "r" && approval) return decide(approval, "decline");
  if (data === "x" && job) return cancelJob(job.jobId);
}

async function openInCodex(job) {
  if (!job) return showNotice("No selected job to open.");
  if (!terminalStatuses.has(job.status)) return showNotice("Wait for this job to finish before opening Codex CLI.");
  if (!job.threadId) return showNotice("This job has no saved Codex thread.");
  if (job.browserAccess && openConfirmationJobId !== job.jobId) {
    openConfirmationJobId = job.jobId;
    return showNotice("ChatGPT Browser context is unavailable in CLI. Press o again to open.", 0);
  }
  openConfirmationJobId = null;
  const secureBin = process.env.LOCAL_CODEX_BIN;
  if (!secureBin) return showNotice("Secure Codex resume is not configured.");

  let authorization;
  try {
    authorization = readFileSync(tokenFile, "utf8").trim();
  } catch {
    return showNotice("Unable to authorize secure Codex resume.");
  }

  let resumeCwd = job.cwd;
  if (job.worktreeId) {
    try {
      const response = await fetch("http://" + host + ":" + String(port) + "/mcp", {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "watch-restore-" + String(Date.now()),
          method: "localCodex/worktreeRestore",
          params: { jobId: job.jobId },
        }),
        signal: AbortSignal.timeout(30000),
      });
      const result = await response.json();
      if (!response.ok || result.error || typeof result.result?.cwd !== "string") throw new Error();
      resumeCwd = result.result.cwd;
    } catch {
      return showNotice("Unable to restore this job's worktree.");
    }
  }

  handoffActive = true;
  clearNotice();
  restoreTerminal();
  process.stdin.pause();
  let exitCode = null;
  let failed = false;
  try {
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(secureBin, ["resume", job.threadId], {
        cwd: resumeCwd,
        stdio: "inherit",
        env: {
          ...process.env,
          LOCAL_CODEX_INTERACTIVE_RESUME: "1",
          LOCAL_CODEX_RESUME_TOKEN: authorization,
          LOCAL_CODEX_RESUME_NETWORK_ACCESS: String(job.networkAccess === true),
        },
      });
      child.once("error", reject);
      child.once("exit", code => resolve(code));
    });
  } catch {
    failed = true;
  } finally {
    process.stdin.resume();
    enterMonitorTerminal();
    handoffActive = false;
    refresh();
    dirty = true;
  }
  if (failed) showNotice("Unable to start Codex CLI.");
  else if (exitCode !== 0) showNotice("Codex CLI exited with status " + String(exitCode) + ".");
  else showNotice("Returned from Codex CLI.");
}

function showNotice(message, duration = 3500) {
  clearTimeout(noticeTimer);
  notice = message;
  dirty = true;
  if (duration > 0) {
    noticeTimer = setTimeout(() => {
      notice = "";
      noticeTimer = null;
      dirty = true;
    }, duration);
    noticeTimer.unref();
  }
}

function clearNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  notice = "";
}

function decide(approval, decision) {
  const target = join(approvalsDir, approval.approvalId + ".decision.json");
  const temporary = target + "." + String(process.pid) + ".tmp";
  writeFileSync(temporary, JSON.stringify({ decision, decidedAt: Date.now() }) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, target);
  dirty = true;
}

async function cancelJob(jobId) {
  try {
    const authorization = readFileSync(tokenFile, "utf8").trim();
    await fetch("http://" + host + ":" + String(port) + "/mcp", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "watch-" + String(Date.now()),
        method: "tools/call",
        params: {
          name: "codex-cancel",
          arguments: { jobId },
        },
      }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Visible state stays unchanged if cancellation fails.
  }
  dirty = true;
}

function quit() {
  if (quitting) return;
  quitting = true;
  restoreTerminal();
  process.exit(0);
}

function restoreTerminal() {
  if (terminalRestored) return;
  terminalRestored = true;
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {}
  try {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  } catch {}
}

function enterMonitorTerminal() {
  terminalRestored = false;
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  } catch {}
  try {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
  } catch {}
}

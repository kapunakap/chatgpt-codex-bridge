import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";

export const VIEW_NAMES = ["Conversation", "Events", "Raw log"];
export const MIN_MONITOR_WIDTH = 80;
export const MIN_MONITOR_HEIGHT = 24;

const ACTIVE_STATUSES = new Set(["starting", "running", "cancelling"]);

export function buildMonitorFrame(options = {}) {
  const width = dimension(options.width, 120);
  const height = dimension(options.height, 36);
  if (width < MIN_MONITOR_WIDTH || height < MIN_MONITOR_HEIGHT) {
    return renderTooSmall(width, height);
  }

  const jobs = Array.isArray(options.jobs) ? options.jobs : [];
  const selectedIndex = clamp(Number(options.selectedIndex) || 0, 0, Math.max(0, jobs.length - 1));
  const job = options.job || jobs[selectedIndex] || null;
  const approvals = Array.isArray(options.approvals) ? options.approvals : [];
  const events = Array.isArray(options.events) ? options.events : [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const bodyHeight = height - 7;
  const paneSpace = width - 4;
  const leftWidth = Math.max(24, Math.floor(paneSpace * 0.27));
  const rightWidth = Math.max(28, Math.floor(paneSpace * 0.25));
  const centerWidth = paneSpace - leftWidth - rightWidth;

  const left = renderJobs(jobs, selectedIndex, leftWidth, bodyHeight, now);
  const center = renderCenter({
    job,
    session: options.session || null,
    approvals,
    events,
    width: centerWidth,
    height: bodyHeight,
    view: clamp(Number(options.view) || 0, 0, VIEW_NAMES.length - 1),
    outputExpanded: Boolean(options.outputExpanded),
    approvalDetails: Boolean(options.approvalDetails),
    searchQuery: String(options.searchQuery || ""),
    now,
  });
  const right = renderInspector({
    job,
    session: options.session || null,
    approvals,
    events,
    ready: options.ready || null,
    width: rightWidth,
    height: bodyHeight,
    follow: options.follow !== false,
    outputExpanded: Boolean(options.outputExpanded),
    searchQuery: String(options.searchQuery || ""),
    homeDir: String(options.homeDir || ""),
    now,
  });

  const lines = [
    renderHeader({
      width,
      ready: options.ready || null,
      jobs,
      heldCount: Number(options.heldCount) || 0,
      threadCount: Number(options.threadCount) || 0,
      now,
    }),
    paneBorder("┌", "┬", "┐", leftWidth, centerWidth, rightWidth),
  ];
  for (let row = 0; row < bodyHeight; row += 1) {
    lines.push(
      "│" + fit(left[row] || "", leftWidth) +
      "│" + fit(center[row] || "", centerWidth) +
      "│" + fit(right[row] || "", rightWidth) + "│"
    );
  }
  lines.push(paneBorder("├", "┴", "┤", leftWidth, centerWidth, rightWidth));
  lines.push("│" + fit(renderTabs({
    width: width - 2,
    view: clamp(Number(options.view) || 0, 0, VIEW_NAMES.length - 1),
    follow: options.follow !== false,
    searchQuery: String(options.searchQuery || ""),
  }), width - 2) + "│");
  lines.push("├" + "─".repeat(width - 2) + "┤");
  lines.push("│" + fit(renderShortcuts({
    approvals,
    searching: Boolean(options.searching),
    searchQuery: String(options.searchQuery || ""),
    notice: String(options.notice || ""),
  }), width - 2) + "│");
  lines.push("└" + "─".repeat(width - 2) + "┘");
  return normalizeFrame(lines, width, height);
}

export function serializeMonitorFrame(lines) {
  let output = "\x1b[H\x1b[2J";
  for (let index = 0; index < lines.length; index += 1) {
    output += "\x1b[" + String(index + 1) + ";1H" + lines[index];
  }
  return output;
}

export function visibleWidth(value) {
  return Array.from(stripVTControlCharacters(String(value))).length;
}

function renderHeader({ width, ready, jobs, heldCount, threadCount, now }) {
  const running = jobs.filter(job => ACTIVE_STATUSES.has(job.status)).length;
  const queued = jobs.filter(job => job.status === "queued").length;
  const maximum = ready?.maxConcurrency ?? "?";
  const title = bold("LOCAL CODEX MONITOR");
  const status = ready ? green("● tunnel connected") : red("● tunnel offline");
  const metrics = [
    cyan("active " + String(running) + "/" + String(maximum)),
    amber("queued " + String(queued)),
    dim("threads " + String(threadCount)),
  ];
  if (heldCount) metrics.push(amber(String(heldCount) + " APPROVAL REQUIRED"));
  const left = title + "  " + status + "  " + metrics.join("  ");
  return joinLeftRight(left, formatClock(now), width);
}

function renderJobs(jobs, selectedIndex, width, height, now) {
  const output = Array.from({ length: height }, () => "");
  output[0] = joinLeftRight(bold("JOBS"), "AGE", width);
  const slots = Math.max(0, height - 1);
  const start = clamp(
    selectedIndex - Math.floor(slots / 2),
    0,
    Math.max(0, jobs.length - slots)
  );
  const visible = jobs.slice(start, start + slots);
  for (let index = 0; index < visible.length; index += 1) {
    const absoluteIndex = start + index;
    output[index + 1] = renderJobRow(
      visible[index],
      width,
      absoluteIndex === selectedIndex,
      now
    );
  }
  if (!jobs.length && height > 1) output[1] = dim("No jobs yet");

  const helper = [
    "Multiple repositories can run concurrently.",
    "Jobs targeting the same folder may wait due",
    "to folder lock.",
  ];
  const firstHelperRow = height - helper.length;
  if (visible.length + 2 < firstHelperRow) {
    for (let index = 0; index < helper.length; index += 1) {
      output[firstHelperRow + index] = dim(truncatePlain(helper[index], width));
    }
  }
  return output;
}

function renderJobRow(job, width, selected, now) {
  const status = job.held ? "! HOLD" : plainStateLabel(job.status);
  const name = basename(job.sourceCwd || job.cwd || "?");
  const jobAge = age(job, now);
  const plain = joinLeftRightPlain(status + "  " + name, jobAge, width);
  if (selected) return selectedRow(plain);
  const styledStatus = job.held ? amber(status) : colorState(status, job.status);
  return joinLeftRight(styledStatus + "  " + name, dim(jobAge), width);
}

function renderCenter({
  job,
  session,
  approvals,
  events,
  width,
  height,
  view,
  outputExpanded,
  approvalDetails,
  searchQuery,
  now,
}) {
  if (!job) return [bold("CONVERSATION"), dim("No Local Codex jobs found")];
  if (approvals.length) {
    return renderApproval({
      approval: approvals[0],
      job,
      session,
      width,
      height,
      approvalDetails,
    });
  }

  const output = [
    cyan(bold(basename(job.sourceCwd || job.cwd || "?"))),
    renderSource(sourceFor(job, events)),
    dim("┄".repeat(width)),
  ];
  if (!session && !events.length) {
    output.push(dim(job.status === "queued"
      ? "Waiting for scheduler / folder lock…"
      : "No live activity attached."));
    return output;
  }
  if (searchQuery && !events.length) {
    output.push(dim("No visible events match /" + searchQuery));
    return output;
  }

  const contentHeight = Math.max(0, height - output.length);
  let content;
  if (view === 2) {
    content = events.map(event => truncatePlain(safeJson(event), width));
  } else if (view === 1) {
    content = events.map(event => truncatePlain(formatEvent(event), width));
  } else {
    content = conversationLines(
      events,
      width,
      outputExpanded,
      ACTIVE_STATUSES.has(job.status),
      now
    );
  }
  output.push(...content.slice(-contentHeight));
  return output.slice(0, height);
}

function renderApproval({ approval, job, session, width, height, approvalDetails }) {
  const params = approval.params || {};
  const command = Array.isArray(params.command)
    ? params.command.join(" ")
    : (params.command || params.commandActions?.[0]?.command || "File change / privileged action");
  const reason = params.reason || "Codex requested host authorization before continuing.";
  const target = params.networkApprovalContext?.host || detectTarget(command);
  const additional = params.additionalPermissions || {};
  const remoteWrite = /git\s+push|gh\s+(?:pr|issue|release|repo)|curl.*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)|upload|publish|npm\s+publish/i.test(command);
  const output = [
    amber(bold("⚠ ACTION REQUIRES HOST APPROVAL")),
    "",
    dim("Job       ") + short(job.jobId),
    dim("Workspace ") + truncatePlain(job.cwd || "?", Math.max(1, width - 10)),
    dim("Thread    ") + short(params.threadId || session?.threadId),
    "",
    bold("PROPOSED ACTION"),
    ...wrapText(command, width).map(bold),
    "",
    bold("Reason"),
    ...wrapText(reason, width),
    "",
    bold("ACCESS CHANGE"),
    "Network access        " + (approval.networkAccess ? amber("ENABLED") : green("OFF")),
  ];
  if (additional.network?.enabled) output.push("Network delta         " + amber("OFF → ON"));
  output.push("Remote write          " + (remoteWrite ? red("POSSIBLE") : dim("not detected")));
  output.push("Host credentials      " + (approval.networkAccess ? amber("AVAILABLE") : green("FILTERED")));
  output.push("Workspace writes      " + green("ALLOWED"));
  if (target) output.push("External service      " + target);
  if (Object.keys(additional).length) {
    output.push("Additional perms      " + truncatePlain(safeJson(additional), Math.max(1, width - 22)));
  }
  output.push(remoteWrite || additional.network?.enabled
    ? red("RISK HIGH · authenticated/external write possible")
    : amber("RISK REVIEW REQUIRED"));
  output.push("", amber("No action will execute until approved."));
  if (approvalDetails) {
    output.push("", bold("DETAILS"));
    output.push(dim("Method     ") + truncatePlain(approval.method || "?", Math.max(1, width - 11)));
    output.push(dim("Request    ") + truncatePlain(String(approval.requestId ?? "?"), Math.max(1, width - 11)));
    if (params.itemId) output.push(dim("Item       ") + truncatePlain(params.itemId, Math.max(1, width - 11)));
    if (params.kind) output.push(dim("Kind       ") + params.kind);
    if (Array.isArray(params.availableDecisions)) {
      output.push(dim("Decisions  ") + truncatePlain(params.availableDecisions.join(", "), Math.max(1, width - 11)));
    }
    output.push(...wrapText(JSON.stringify(params, null, 2), width).map(dim));
  }
  output.push("", "[a] Approve once   [A] Approve for this job");
  output.push("[r] Reject          [x] Kill job   [d] Details");
  return output.slice(0, height);
}

function renderInspector({
  job,
  session,
  approvals,
  events,
  ready,
  width,
  height,
  follow,
  outputExpanded,
  searchQuery,
  homeDir,
  now,
}) {
  const output = [bold("JOB INSPECTOR"), dim("─".repeat(width))];
  if (!job) return output;
  const status = approvals.length ? amber("HOLD") : colorState(longStateLabel(job.status), job.status);
  const source = sourceFor(job, events);
  const fields = [
    ["STATUS", status],
    ["WORKSPACE", displayPath(job.cwd || "?", homeDir)],
    ["SOURCE REPO", displayPath(job.sourceCwd || job.cwd || "?", homeDir)],
    ["ISOLATION", job.workspaceKind || "direct"],
    ...(job.worktreeId ? [["WORKTREE", job.worktreeState || "planned"], ["BASE", short(job.baseSha)]] : []),
    ["SOURCE", source.kind + ": " + source.text],
    ["MODEL", job.model || "pending"],
    ["REASONING", job.reasoningEffort || "pending"],
    ["NETWORK", job.networkAccess ? amber("ON") : green("OFF")],
    ["THREAD", short(job.threadId || session?.threadId)],
    ["JOB", short(job.jobId)],
    ["STARTED", formatClock(job.startedAt)],
    ["ELAPSED", elapsed(job, now)],
  ];
  for (const [key, value] of fields) {
    output.push(fieldRow(key, value, width));
    output.push(dim("─".repeat(width)));
  }
  output.push(bold("SCHEDULER"));
  output.push(dim("─".repeat(width)));
  output.push(fieldRow("active", String(ready?.activeCalls ?? "?") + " / " + String(ready?.maxConcurrency ?? "?"), width));
  output.push(fieldRow("queued", String(ready?.queuedCalls ?? "?"), width));
  output.push(fieldRow("folder lock", basename(job.sourceCwd || job.cwd || "?"), width));
  output.push(dim("─".repeat(width)));
  output.push(bold("SANDBOX"));
  output.push(dim("─".repeat(width)));
  output.push(fieldRow("workspace", "write", width));
  output.push(fieldRow("network", job.networkAccess ? amber("enabled") : "off", width));
  output.push(fieldRow("host auth", job.networkAccess ? amber("available") : "filtered", width));
  output.push(fieldRow("cwd bound", green("yes"), width));
  output.push(dim("─".repeat(width)));
  output.push(fieldRow("follow", follow ? green("on") : amber("paused"), width));
  output.push(fieldRow("output", outputExpanded ? "expanded" : "collapsed", width));
  if (searchQuery) output.push(fieldRow("search", "/" + searchQuery, width));
  return output.slice(0, height);
}

function conversationLines(events, width, outputExpanded, active, now) {
  const output = [];
  const startedItems = new Set();
  let assistant = "";
  const flushAssistant = () => {
    if (!assistant) return;
    output.push(cyan(bold("CODEX")), ...wrapText(assistant, width), "");
    assistant = "";
  };

  for (const event of events) {
    if (event.type === "chatgpt.prompt") {
      flushAssistant();
      output.push(magenta(bold("CHATGPT")), ...wrapText(event.data?.text || "", width), "");
      continue;
    }
    if (event.type === "assistant.delta") {
      assistant += event.data?.text || "";
      continue;
    }
    if (event.type === "item.started" || event.type === "item.completed") {
      flushAssistant();
      const item = event.data?.item || {};
      const key = item.id || item.itemId || safeJson([item.type, item.command]);
      if (/commandExecution/i.test(item.type || "")) {
        const command = Array.isArray(item.command)
          ? item.command.join(" ")
          : (item.command || "command");
        if (!startedItems.has(key)) {
          output.push(dim("› " + truncatePlain(command, Math.max(1, width - 2))));
          startedItems.add(key);
        }
        if (event.type === "item.completed") {
          const commandOutput = item.aggregatedOutput || item.output || item.stdout;
          if (typeof commandOutput === "string" && commandOutput.trim()) {
            const lines = wrapText(commandOutput.trim(), width);
            if (!outputExpanded && lines.length > 3) {
              output.push(...lines.slice(0, 2).map(dim));
              output.push(dim("▸ command output " + String(lines.length) + " lines · [l] expand"));
            } else {
              output.push(...lines.map(dim));
              if (outputExpanded && lines.length > 3) {
                output.push(dim("▾ command output " + String(lines.length) + " lines · [l] collapse"));
              }
            }
          }
        }
      } else if (/fileChange/i.test(item.type || "") && !startedItems.has(key)) {
        output.push(dim("› file change " + String(item.status || "")));
        startedItems.add(key);
      }
      continue;
    }
    if (event.type === "turn.completed") {
      flushAssistant();
      output.push(green("✓ turn " + String(event.data?.status || "completed")), "");
      continue;
    }
    if (/error|failed/i.test(event.type || "")) {
      flushAssistant();
      output.push(red(formatEvent(event)));
    }
  }
  flushAssistant();
  if (active && events.at(-1)?.type !== "turn.completed") {
    const spinner = ["⠋", "⠙", "⠹", "⠸"][Math.floor(now / 250) % 4];
    output.push(cyan(spinner + " CODEX working…"));
  }
  return output;
}

function renderTabs({ width, view, follow, searchQuery }) {
  const tabs = VIEW_NAMES.map((name, index) => {
    return index === view ? cyan(underline(bold(name))) : dim(name);
  }).join("     ");
  let state = follow ? green("FOLLOW ●") : amber("FOLLOW ○");
  if (searchQuery) state = "/" + searchQuery + "  " + state;
  return joinLeftRight(tabs, state, width);
}

function renderShortcuts({ approvals, searching, searchQuery, notice }) {
  if (notice) return amber(notice);
  if (searching) {
    return amber("SEARCH") + " /" + searchQuery + "█  " + dim("Enter apply  Esc cancel  Backspace edit");
  }
  if (approvals.length) {
    return dim("↑↓/jk select  o open  Tab view  d details  a/A approve  r reject  x kill  q quit");
  }
  return dim("↑↓/jk select  o open  Tab view  f follow  / search  l output  d details  a/A/r approve  x kill  q quit");
}

function sourceFor(job, events) {
  const exact = cleanDisplayText(job?.sourceTitle);
  if (exact) return { kind: "CHATGPT", text: exact };
  const codex = cleanDisplayText(job?.codexThreadName);
  if (codex) return { kind: "CODEX (fallback)", text: codex };
  const prompt = (events || []).find(event => event?.type === "chatgpt.prompt")?.data?.text;
  const preview = cleanDisplayText(prompt);
  if (preview) return { kind: "PROMPT (fallback)", text: preview };
  return { kind: "SOURCE", text: "unavailable" };
}

function renderSource(source) {
  const label = source.kind === "CHATGPT" ? cyan(source.kind) : amber(source.kind);
  return label + ": " + source.text;
}

function cleanDisplayText(value) {
  if (typeof value !== "string") return "";
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function renderTooSmall(width, height) {
  const lines = Array.from({ length: height }, () => " ".repeat(width));
  const messages = [
    "LOCAL CODEX MONITOR",
    "Terminal is too small.",
    "Resize to at least " + String(MIN_MONITOR_WIDTH) + "x" + String(MIN_MONITOR_HEIGHT) + ".",
  ];
  const firstRow = Math.max(0, Math.floor((height - messages.length) / 2));
  for (let index = 0; index < messages.length && firstRow + index < height; index += 1) {
    const text = truncatePlain(messages[index], width);
    const left = Math.max(0, Math.floor((width - Array.from(text).length) / 2));
    lines[firstRow + index] = " ".repeat(left) + text + " ".repeat(Math.max(0, width - left - Array.from(text).length));
  }
  return lines;
}

function normalizeFrame(lines, width, height) {
  const normalized = lines.slice(0, height).map(line => fit(line, width));
  while (normalized.length < height) normalized.push(" ".repeat(width));
  return normalized;
}

function paneBorder(left, join, right, leftWidth, centerWidth, rightWidth) {
  return left + "─".repeat(leftWidth) + join +
    "─".repeat(centerWidth) + join +
    "─".repeat(rightWidth) + right;
}

function fieldRow(key, value, width) {
  const keyWidth = Math.min(11, Math.max(8, width - 10));
  return fit(dim(fitPlain(String(key), keyWidth)) + "│" + fit(" " + String(value), width - keyWidth - 1), width);
}

function joinLeftRight(left, right, width) {
  const rightText = truncatePlain(stripVTControlCharacters(String(right)), width);
  const rightWidth = visibleWidth(rightText);
  if (rightWidth >= width) return fit(rightText, width);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fit(left, leftWidth) + " " + rightText;
}

function joinLeftRightPlain(left, right, width) {
  const rightText = truncatePlain(right, width);
  const leftWidth = Math.max(0, width - Array.from(rightText).length - 1);
  return fitPlain(left, leftWidth) + " " + rightText;
}

function fit(value, width) {
  const string = String(value);
  const current = visibleWidth(string);
  if (current > width) return truncatePlain(stripVTControlCharacters(string), width);
  return string + " ".repeat(Math.max(0, width - current));
}

function fitPlain(value, width) {
  const text = truncatePlain(value, width);
  return text + " ".repeat(Math.max(0, width - Array.from(text).length));
}

function truncatePlain(value, width) {
  if (width <= 0) return "";
  const characters = Array.from(String(value));
  if (characters.length <= width) return characters.join("");
  if (width === 1) return "…";
  return characters.slice(0, width - 1).join("") + "…";
}

function wrapText(value, width) {
  if (width <= 0) return [];
  const output = [];
  for (const raw of String(value || "").split(/\r?\n/)) {
    let remaining = raw;
    if (!remaining) {
      output.push("");
      continue;
    }
    while (Array.from(remaining).length > width) {
      const characters = Array.from(remaining);
      let splitAt = characters.slice(0, width + 1).join("").lastIndexOf(" ");
      if (splitAt < Math.floor(width * 0.5)) splitAt = width;
      output.push(characters.slice(0, splitAt).join("").trimEnd());
      remaining = characters.slice(splitAt).join("").trimStart();
    }
    output.push(remaining);
  }
  return output;
}

function formatEvent(event) {
  const time = formatClock(event.time);
  if (event.type === "assistant.delta") {
    return time + " assistant " + JSON.stringify(event.data?.text || "");
  }
  if (event.type === "chatgpt.prompt") {
    return time + " ChatGPT prompt " + truncatePlain(event.data?.text || "", 80);
  }
  if (event.type === "approval.requested") {
    return time + " SECURITY GATE awaiting host approval";
  }
  return time + " " + String(event.type || "event") + " " + safeJson(event.data);
}

function plainStateLabel(status) {
  if (status === "queued") return "○ QUE";
  if (ACTIVE_STATUSES.has(status)) return "● RUN";
  if (status === "completed") return "✓ DONE";
  if (status === "cancelled" || status === "interrupted") return "■ STOP";
  return "✕ FAIL";
}

function longStateLabel(status) {
  if (status === "queued") return "QUEUED";
  if (status === "starting") return "STARTING";
  if (status === "running") return "RUNNING";
  if (status === "cancelling") return "CANCELLING";
  if (status === "completed") return "COMPLETED";
  if (status === "cancelled") return "CANCELLED";
  if (status === "interrupted") return "INTERRUPTED";
  if (status === "timed_out") return "TIMED OUT";
  return "FAILED";
}

function colorState(text, status) {
  if (status === "queued") return amber(text);
  if (ACTIVE_STATUSES.has(status)) return cyan(text);
  if (status === "completed") return green(text);
  if (status === "cancelled" || status === "interrupted") return dim(text);
  return red(text);
}

function elapsed(job, now) {
  const started = Number(job?.startedAt);
  if (!Number.isFinite(started)) return "—";
  const finished = Number.isFinite(job.finishedAt) ? job.finishedAt : now;
  const seconds = Math.floor(Math.max(0, finished - started) / 1000);
  return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" +
    String(seconds % 60).padStart(2, "0");
}

function age(job, now) {
  const active = ACTIVE_STATUSES.has(job?.status) || job?.status === "queued";
  const reference = active
    ? Number(job?.startedAt)
    : Number(job?.finishedAt ?? job?.updatedAt);
  if (!Number.isFinite(reference)) return "—";
  const seconds = Math.floor(Math.max(0, now - reference) / 1000);
  if (seconds < 60) return String(seconds) + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return String(minutes) + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return String(hours) + "h";
  return String(Math.floor(hours / 24)) + "d";
}

function displayPath(value, homeDir) {
  const path = String(value || "?");
  if (homeDir && (path === homeDir || path.startsWith(homeDir + "/"))) {
    return "~" + path.slice(homeDir.length);
  }
  return path;
}

function formatClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return String(date.getHours()).padStart(2, "0") + ":" +
    String(date.getMinutes()).padStart(2, "0") + ":" +
    String(date.getSeconds()).padStart(2, "0");
}

function detectTarget(command) {
  const match = String(command).match(/(?:https?:\/\/|git@)([A-Za-z0-9.-]+)/i);
  if (match) return match[1];
  return /git\s+push/i.test(command) ? "git remote" : "";
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function short(value) {
  return value ? String(value).slice(0, 8) : "—";
}

function dimension(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function color(code, text) {
  return "\x1b[" + code + "m" + text + "\x1b[0m";
}

function bold(text) {
  return color("1", text);
}

function dim(text) {
  return color("2", text);
}

function red(text) {
  return color("31", text);
}

function green(text) {
  return color("32", text);
}

function amber(text) {
  return color("33", text);
}

function cyan(text) {
  return color("36", text);
}

function magenta(text) {
  return color("35", text);
}

function underline(text) {
  return color("4", text);
}

function selectedRow(text) {
  return color("44;97;1", text);
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const RECORD_ID = /^[0-9a-f-]{36}$/;

export async function createWorktreeManager(options) {
  const manager = new WorktreeManager(options);
  await manager.load();
  return manager;
}

class WorktreeManager {
  constructor({ rootDir, stateDir, retention = 15, gitBin = "git", gitTimeoutMs = 30000 }) {
    if (!isAbsolute(rootDir) || !isAbsolute(stateDir)) throw new Error("Worktree paths must be absolute");
    if (!Number.isSafeInteger(retention) || retention < 1 || retention > 1000) {
      throw new Error("Worktree retention must be an integer between 1 and 1000");
    }
    if (!Number.isSafeInteger(gitTimeoutMs) || gitTimeoutMs < 1 || gitTimeoutMs > 2147483647) {
      throw new Error("Worktree Git timeout must be a positive timer-safe integer");
    }
    this.rootDir = resolve(rootDir);
    this.stateDir = resolve(stateDir);
    this.stateFile = join(this.stateDir, "worktrees.json");
    this.snapshotsDir = join(this.stateDir, "worktree-snapshots");
    this.retention = retention;
    this.gitBin = gitBin;
    this.gitTimeoutMs = gitTimeoutMs;
    this.records = new Map();
    this.repositoryCache = new Map();
    this.operation = Promise.resolve();
    this.pendingAdmissions = 0;
    this.admissionWaiters = new Set();
  }

  async load() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
    await mkdir(this.snapshotsDir, { recursive: true, mode: 0o700 });
    await chmod(this.snapshotsDir, 0o700);
    let state;
    try { state = JSON.parse(await readFile(this.stateFile, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (state?.schemaVersion !== 1 || !Array.isArray(state.records)) throw new Error("Invalid worktree state");
    for (const value of state.records) {
      const record = validateRecord(value, this.rootDir, this.snapshotsDir);
      this.records.set(record.id, record);
    }
  }

  async plan({ id, sourceCwd, enabled = true }) {
    if (!RECORD_ID.test(id)) throw new Error("Invalid worktree id");
    if (!enabled) {
      sourceCwd = await realpath(sourceCwd);
      return directWorkspace(sourceCwd, "disabled");
    }
    this.pendingAdmissions += 1;
    try {
      sourceCwd = await realpath(sourceCwd);
      const existing = this.records.get(id);
      if (existing) return clone(existing);
      // Repository inspection is read-only and does not need the state serializer.
      const repository = await this.inspectRepositoryCached(sourceCwd);
      if (!repository.git) return directWorkspace(sourceCwd, repository.reason);
      return await this.serial(async () => {
        if (this.records.has(id)) return clone(this.records.get(id));
        const bucket = `${safeName(basename(repository.repoRoot))}-${digest(repository.commonGitDir).slice(0, 10)}`;
        const worktreeRoot = join(this.rootDir, bucket, id);
        const executionCwd = repository.relativeCwd ? join(worktreeRoot, repository.relativeCwd) : worktreeRoot;
        const now = Date.now();
        const record = {
          id,
          threadId: null,
          sourceCwd,
          repoRoot: repository.repoRoot,
          commonGitDir: repository.commonGitDir,
          relativeCwd: repository.relativeCwd,
          worktreeRoot,
          executionCwd,
          baseSha: repository.baseSha,
          state: "planned",
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
          snapshotRef: null,
          snapshotCommit: null,
          snapshotBundle: null,
          snapshotBundleSha256: null,
        };
        this.records.set(id, record);
        await this.save();
        return clone(record);
      });
    } finally {
      this.pendingAdmissions -= 1;
      if (!this.pendingAdmissions) {
        const waiters = [...this.admissionWaiters];
        this.admissionWaiters.clear();
        for (const resolvePromise of waiters) resolvePromise();
      }
    }
  }

  get(id) {
    const record = this.records.get(id);
    return record ? clone(record) : null;
  }

  findByThread(threadId) {
    for (const record of this.records.values()) {
      if (record.threadId === threadId) return clone(record);
    }
    return null;
  }

  async prepare(id, { signal } = {}) {
    return this.serial(async () => {
      throwIfAborted(signal);
      const record = this.require(id);
      if (record.state === "ready" && await isDirectory(record.executionCwd)) {
        record.lastUsedAt = record.updatedAt = Date.now();
        await this.save();
        return clone(record);
      }
      if (record.state === "snapshotted") return this.restoreRecord(record, { signal });
      if (!await isDirectory(record.repoRoot)) throw coded("worktree_source_missing", "Source repository is unavailable");
      await mkdir(dirname(record.worktreeRoot), { recursive: true, mode: 0o700 });
      throwIfAborted(signal);
      if (await pathExists(record.worktreeRoot)) {
        if (!this.ownsPath(record.worktreeRoot)) throw coded("worktree_path_invalid", "Refusing unmanaged worktree path");
        await rm(record.worktreeRoot, { recursive: true, force: true });
      }
      record.state = "creating";
      record.updatedAt = Date.now();
      await this.save();
      const git = (args, options = {}) => this.git(args, { ...options, signal });
      try {
        await git(["-C", record.repoRoot, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", record.worktreeRoot, record.baseSha]);
        throwIfAborted(signal);
        await chmod(record.worktreeRoot, 0o700);
        await copyWorktreeIncludes(record.repoRoot, record.worktreeRoot, git, false);
        throwIfAborted(signal);
        if (!await isDirectory(record.executionCwd)) throw coded("worktree_subdirectory_missing", "Selected repository subdirectory is absent from committed HEAD");
        record.state = "ready";
        delete record.errorCode;
        record.updatedAt = record.lastUsedAt = Date.now();
        await this.save();
        return clone(record);
      } catch (error) {
        record.state = "failed";
        record.updatedAt = Date.now();
        const cancelled = signal?.aborted && error.code !== "worktree_git_cleanup_failed";
        record.errorCode = cancelled ? "worktree_cancelled" : (error.code || "worktree_create_failed");
        await this.save();
        throw coded(record.errorCode, cancelled ? "Worktree preparation cancelled" : (error.message || "Unable to create worktree"));
      }
    }, { signal });
  }

  async bindThread(id, threadId) {
    return this.serial(async () => {
      const record = this.require(id);
      record.threadId = threadId;
      record.updatedAt = record.lastUsedAt = Date.now();
      await this.save();
      return clone(record);
    });
  }

  async touch(id) {
    return this.serial(async () => {
      const record = this.require(id);
      record.updatedAt = record.lastUsedAt = Date.now();
      await this.save();
      return clone(record);
    });
  }

  async abandon(id) {
    return this.serial(async () => {
      const record = this.records.get(id);
      if (!record || record.threadId || record.state === "ready" || record.state === "snapshotted") return;
      this.records.delete(id);
      await this.save();
    });
  }

  async reconcile() {
    return this.serial(async () => {
      let changed = false;
      for (const record of this.records.values()) {
        const exists = await isDirectory(record.executionCwd);
        if (["planned", "creating", "failed"].includes(record.state) && exists) {
          record.state = "ready";
          record.updatedAt = Date.now();
          changed = true;
        } else if (record.state === "ready" && !exists && record.snapshotBundle) {
          record.state = "snapshotted";
          record.updatedAt = Date.now();
          changed = true;
        }
      }
      if (changed) await this.save();
    });
  }

  async waitForAdmissionIdle(signal) {
    while (this.pendingAdmissions > 0) {
      await abortable(new Promise(resolvePromise => {
        this.admissionWaiters.add(resolvePromise);
      }), signal);
    }
  }

  async prune(protectedIds = new Set(), { limit = 4, signal, isProtected, excludeIds = new Set() } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid prune batch limit");
    throwIfAborted(signal);
    const candidates = [...this.records.values()]
      .filter(record => record.state === "ready" && !protectedIds.has(record.id) && !excludeIds.has(record.id))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
      .map(record => record.id);
    const pruned = [];
    const attemptedIds = [];
    for (const id of candidates) {
      throwIfAborted(signal);
      if (attemptedIds.length >= limit) break;
      await this.waitForAdmissionIdle(signal);
      if (protectedIds.has(id) || isProtected?.(id)) continue;
      if ([...this.records.values()].filter(record => record.state === "ready").length <= this.retention) break;
      attemptedIds.push(id);
      try {
        const result = await this.serial(async () => {
          throwIfAborted(signal);
          const record = this.records.get(id);
          if (!record || record.state !== "ready" || protectedIds.has(id) || isProtected?.(id)) return null;
          const readyCount = [...this.records.values()].filter(value => value.state === "ready").length;
          if (readyCount <= this.retention) return null;
          await this.snapshotAndRemove(record, { signal });
          return clone(record);
        }, { signal });
        if (result) pruned.push(result);
      } catch (error) {
        if (error?.code === "worktree_git_cleanup_failed") throw error;
        if (signal?.aborted || error?.code === "worktree_cancelled") {
          throw coded("worktree_cancelled", "Worktree pruning cancelled");
        }
        // Snapshot failure is deliberately non-destructive. Keep the worktree.
      }
    }
    const attempted = new Set([...excludeIds, ...attemptedIds]);
    const readyCount = [...this.records.values()].filter(record => record.state === "ready").length;
    const hasMoreEligible = readyCount > this.retention && [...this.records.values()].some(record =>
      record.state === "ready" && !protectedIds.has(record.id) && !attempted.has(record.id) && !isProtected?.(record.id));
    Object.defineProperties(pruned, {
      attemptedIds: { value: attemptedIds, enumerable: false },
      hasMoreEligible: { value: hasMoreEligible, enumerable: false },
    });
    return pruned;
  }

  async inspectRepository(sourceCwd) {
    const inside = await this.git(["-C", sourceCwd, "rev-parse", "--is-inside-work-tree"], { allowFailure: true });
    if (inside.code !== 0 || inside.stdout.trim() !== "true") return { git: false, reason: "non_git" };
    const top = await this.git(["-C", sourceCwd, "rev-parse", "--show-toplevel"], { allowFailure: true });
    const head = await this.git(["-C", sourceCwd, "rev-parse", "HEAD"], { allowFailure: true });
    if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(head.stdout.trim())) return { git: false, reason: "unborn_head" };
    if (top.code !== 0) return { git: false, reason: "non_git" };
    const repoRoot = await realpath(top.stdout.trim());
    const common = await this.git(["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const commonGitDir = await realpath(common.stdout.trim());
    const relativeCwd = relative(repoRoot, sourceCwd);
    if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`) || isAbsolute(relativeCwd)) {
      throw coded("worktree_source_invalid", "Selected folder escapes its repository");
    }
    return { git: true, repoRoot, commonGitDir, relativeCwd, baseSha: head.stdout.trim() };
  }

  async inspectRepositoryCached(sourceCwd) {
    const cached = this.repositoryCache.get(sourceCwd);
    if (cached?.promise) return clone(await cached.promise);
    if (cached && Date.now() - cached.time < 1000) return clone(cached.value);
    const promise = this.inspectRepository(sourceCwd);
    this.repositoryCache.set(sourceCwd, { promise });
    try {
      const value = await promise;
      this.repositoryCache.set(sourceCwd, { time: Date.now(), value });
      return clone(value);
    } catch (error) {
      if (this.repositoryCache.get(sourceCwd)?.promise === promise) this.repositoryCache.delete(sourceCwd);
      throw error;
    }
  }

  async snapshotAndRemove(record, { signal } = {}) {
    throwIfAborted(signal);
    const git = (args, options = {}) => this.git(args, { ...options, signal });
    if (!this.ownsPath(record.worktreeRoot) || !await isDirectory(record.worktreeRoot)) {
      throw coded("worktree_path_invalid", "Refusing unmanaged worktree deletion");
    }
    const temporary = await mkdtemp(join(this.snapshotsDir, `${record.id}.tmp.`));
    const finalDirectory = join(this.snapshotsDir, record.id);
    try {
      throwIfAborted(signal);
      const currentHead = (await git(["-C", record.worktreeRoot, "rev-parse", "HEAD"])).stdout.trim();
      const statusResult = await git(["-C", record.worktreeRoot, "status", "--porcelain=v1", "--untracked-files=all"]);
      let snapshotCommit = currentHead;
      if (statusResult.stdout.length) {
        const indexFile = join(temporary, "snapshot.index");
        const env = { GIT_INDEX_FILE: indexFile };
        await git(["-C", record.worktreeRoot, "read-tree", currentHead], { env });
        await git(["-C", record.worktreeRoot, "add", "-A", "--", "."], { env });
        const tree = (await git(["-C", record.worktreeRoot, "write-tree"], { env })).stdout.trim();
        snapshotCommit = (await git(["-C", record.worktreeRoot, "commit-tree", tree, "-p", currentHead, "-m", `Local Codex snapshot ${record.id}`], {
          env: {
            ...env,
            GIT_AUTHOR_NAME: "Local Codex Snapshot",
            GIT_AUTHOR_EMAIL: "local-codex@localhost",
            GIT_COMMITTER_NAME: "Local Codex Snapshot",
            GIT_COMMITTER_EMAIL: "local-codex@localhost",
          },
        })).stdout.trim();
      }
      const snapshotRef = `refs/local-codex/snapshots/${record.id}`;
      await git(["-C", record.worktreeRoot, "update-ref", snapshotRef, snapshotCommit]);
      const bundle = join(temporary, "snapshot.bundle");
      await git(["-C", record.worktreeRoot, "bundle", "create", bundle, snapshotRef]);
      await git(["bundle", "verify", bundle]);
      await chmod(bundle, 0o600);
      const overlay = join(temporary, "overlay");
      await mkdir(overlay, { recursive: true, mode: 0o700 });
      await copyWorktreeIncludes(record.worktreeRoot, overlay, git, true);
      throwIfAborted(signal);
      const bundleSha256 = await hashFile(bundle);
      await writePrivateJson(join(temporary, "manifest.json"), {
        schemaVersion: 1,
        id: record.id,
        threadId: record.threadId,
        sourceCwd: record.sourceCwd,
        relativeCwd: record.relativeCwd,
        baseSha: record.baseSha,
        snapshotRef,
        snapshotCommit,
        bundleSha256,
        createdAt: Date.now(),
      });
      throwIfAborted(signal);
      await rm(finalDirectory, { recursive: true, force: true });
      await rename(temporary, finalDirectory);
      const gitFile = await lstat(join(record.worktreeRoot, ".git"));
      if (gitFile.isFile() && await isDirectory(record.repoRoot)) {
        await git(["-C", record.repoRoot, "-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", record.worktreeRoot]);
      } else {
        await rm(record.worktreeRoot, { recursive: true, force: true });
      }
      record.state = "snapshotted";
      record.snapshotRef = snapshotRef;
      record.snapshotCommit = snapshotCommit;
      record.snapshotBundle = join(finalDirectory, "snapshot.bundle");
      record.snapshotBundleSha256 = bundleSha256;
      record.updatedAt = Date.now();
      await this.save();
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async restoreRecord(record, { signal } = {}) {
    throwIfAborted(signal);
    const git = (args, options = {}) => this.git(args, { ...options, signal });
    if (!record.snapshotBundle || !record.snapshotCommit || !record.snapshotBundleSha256) {
      throw coded("worktree_snapshot_missing", "Worktree snapshot is unavailable");
    }
    if (await hashFile(record.snapshotBundle) !== record.snapshotBundleSha256) {
      throw coded("worktree_snapshot_invalid", "Worktree snapshot checksum mismatch");
    }
    throwIfAborted(signal);
    await git(["bundle", "verify", record.snapshotBundle]);
    await mkdir(dirname(record.worktreeRoot), { recursive: true, mode: 0o700 });
    if (await pathExists(record.worktreeRoot)) {
      if (!this.ownsPath(record.worktreeRoot)) throw coded("worktree_path_invalid", "Refusing unmanaged restore path");
      await rm(record.worktreeRoot, { recursive: true, force: true });
    }
    let linked = false;
    if (await isDirectory(record.repoRoot)) {
      const ref = await git(["-C", record.repoRoot, "rev-parse", "--verify", record.snapshotCommit], { allowFailure: true });
      if (ref.code === 0) {
        await git(["-C", record.repoRoot, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", record.worktreeRoot, record.snapshotCommit]);
        linked = true;
      }
    }
    if (!linked) {
      await mkdir(record.worktreeRoot, { recursive: true, mode: 0o700 });
      await git(["-C", record.worktreeRoot, "-c", "core.hooksPath=/dev/null", "init"]);
      await git(["-C", record.worktreeRoot, "fetch", record.snapshotBundle, record.snapshotRef]);
      await git(["-C", record.worktreeRoot, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", record.snapshotCommit]);
      record.repoRoot = record.worktreeRoot;
      record.commonGitDir = join(record.worktreeRoot, ".git");
    }
    throwIfAborted(signal);
    await chmod(record.worktreeRoot, 0o700);
    await restoreGitModes(record.worktreeRoot, git);
    const overlay = join(dirname(record.snapshotBundle), "overlay");
    await restoreOverlay(overlay, record.worktreeRoot);
    record.executionCwd = record.relativeCwd ? join(record.worktreeRoot, record.relativeCwd) : record.worktreeRoot;
    if (!await isDirectory(record.executionCwd)) throw coded("worktree_subdirectory_missing", "Restored worktree is missing the selected subdirectory");
    record.state = "ready";
    delete record.errorCode;
    record.updatedAt = record.lastUsedAt = Date.now();
    await this.save();
    return clone(record);
  }

  require(id) {
    const record = this.records.get(id);
    if (!record) throw coded("worktree_unknown", "Unknown managed worktree");
    return record;
  }

  ownsPath(path) {
    const candidate = resolve(path);
    return candidate !== this.rootDir && candidate.startsWith(`${this.rootDir}${sep}`);
  }

  async save() {
    await writePrivateJson(this.stateFile, {
      schemaVersion: 1,
      records: [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt),
    });
  }

  serial(task, { signal } = {}) {
    const run = async () => {
      throwIfAborted(signal);
      return task();
    };
    const result = this.operation.then(run, run);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async waitForIdle() {
    for (;;) {
      const operation = this.operation;
      await operation;
      if (operation === this.operation) return;
    }
  }

  async git(args, options = {}) {
    const result = await runProcess(this.gitBin, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? this.gitTimeoutMs,
      signal: options.signal,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_LFS_SKIP_SMUDGE: "1",
        ...(options.env || {}),
      },
    });
    if (result.code !== 0 && !options.allowFailure) {
      throw coded("worktree_git_failed", result.stderr.trim() || "Git worktree operation failed");
    }
    return result;
  }
}

function directWorkspace(sourceCwd, reason) {
  return {
    id: null,
    threadId: null,
    sourceCwd,
    repoRoot: null,
    commonGitDir: null,
    relativeCwd: "",
    worktreeRoot: null,
    executionCwd: sourceCwd,
    baseSha: null,
    state: "direct",
    reason,
  };
}

async function copyWorktreeIncludes(sourceRoot, destinationRoot, git, overwrite) {
  const includeFile = join(sourceRoot, ".worktreeinclude");
  const paths = new Set();
  if (await pathExists(includeFile)) {
    const listed = await git(["-C", sourceRoot, "ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z"], { allowFailure: true });
    if (listed.code === 0) for (const path of listed.stdout.split("\0")) if (path) paths.add(path);
  }
  if (await pathExists(join(sourceRoot, "AGENTS.override.md"))) paths.add("AGENTS.override.md");
  for (const path of paths) {
    if (!safeRelative(path)) continue;
    const source = join(sourceRoot, path);
    const destination = join(destinationRoot, path);
    let metadata;
    try { metadata = await lstat(source); } catch { continue; }
    if (!metadata.isFile()) continue;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await copyFile(source, destination, overwrite ? 0 : fsConstants.COPYFILE_EXCL);
      await chmod(destination, metadata.mode & 0o777);
    } catch (error) {
      if (!overwrite && error.code === "EEXIST") continue;
      throw error;
    }
  }
}

async function restoreOverlay(sourceRoot, destinationRoot) {
  if (!await isDirectory(sourceRoot)) return;
  const entries = await walkFiles(sourceRoot);
  for (const relativePath of entries) {
    const source = join(sourceRoot, relativePath);
    const destination = join(destinationRoot, relativePath);
    const metadata = await lstat(source);
    if (!metadata.isFile()) continue;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    await chmod(destination, metadata.mode & 0o777);
  }
}

async function restoreGitModes(root, git) {
  const result = await git(["-C", root, "ls-files", "-s", "-z"]);
  for (const entry of result.stdout.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const mode = entry.slice(0, 6);
    if (mode !== "100644" && mode !== "100755") continue;
    const path = entry.slice(tab + 1);
    if (!safeRelative(path)) continue;
    try { await chmod(join(root, path), mode === "100755" ? 0o755 : 0o644); } catch {}
  }
}

async function walkFiles(root, prefix = "") {
  const { readdir } = await import("node:fs/promises");
  const output = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) output.push(...await walkFiles(root, path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function validateRecord(value, rootDir, snapshotsDir) {
  if (!value || typeof value !== "object" || !RECORD_ID.test(value.id) ||
      typeof value.sourceCwd !== "string" || typeof value.worktreeRoot !== "string" ||
      typeof value.executionCwd !== "string" || !["planned", "creating", "ready", "snapshotted", "failed"].includes(value.state)) {
    throw new Error("Invalid worktree record");
  }
  const worktreeRoot = resolve(value.worktreeRoot);
  if (worktreeRoot === rootDir || !worktreeRoot.startsWith(`${rootDir}${sep}`)) throw new Error("Invalid managed worktree path");
  if (value.snapshotBundle) {
    const bundle = resolve(value.snapshotBundle);
    if (!bundle.startsWith(`${snapshotsDir}${sep}`)) throw new Error("Invalid worktree snapshot path");
  }
  return { ...value, worktreeRoot, executionCwd: resolve(value.executionCwd) };
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await import("node:fs/promises").then(fs => fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }));
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function runProcess(command, args, { cwd, env, timeoutMs = 30000, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) return rejectPromise(coded("worktree_cancelled", "Worktree operation cancelled"));
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError = null;
    let killTimer;
    let killVerifyTimer;
    let cleanupCheckPending = false;
    const cleanupDeadline = () => Date.now() + 2000;
    let cleanupExpiresAt;
    const timeout = setTimeout(
      () => terminate(coded("worktree_git_timeout", `Git worktree operation exceeded ${timeoutMs} milliseconds`)),
      timeoutMs,
    );
    timeout.unref();
    const onAbort = () => terminate(coded("worktree_cancelled", "Worktree operation cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > 8 * 1024 * 1024) {
        throw coded("worktree_output_too_large", "Git output exceeded the safety limit");
      }
      return next;
    };
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(killVerifyTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const signalChild = childSignal => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(childSignal);
        else process.kill(-child.pid, childSignal);
      } catch (error) {
        if (error.code === "ESRCH") return;
        if (error.code === "EPERM") {
          try { child.kill(childSignal); } catch {}
        }
      }
    };
    const groupExists = () => {
      if (!child.pid || process.platform === "win32") return child.exitCode === null;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    };
    const verifyCleanup = () => {
      if (settled) return;
      if (!groupExists()) {
        return finish(terminationError);
      }
      if (Date.now() >= cleanupExpiresAt) {
        return finish(coded("worktree_git_cleanup_failed", "Git worktree process cleanup could not be verified"));
      }
      if (cleanupCheckPending) return;
      cleanupCheckPending = true;
      killVerifyTimer = setTimeout(() => {
        cleanupCheckPending = false;
        verifyCleanup();
      }, 25);
    };
    function terminate(error) {
      if (settled || terminationError) return;
      terminationError = error;
      cleanupExpiresAt = cleanupDeadline();
      signalChild("SIGTERM");
      killTimer = setTimeout(() => {
        signalChild("SIGKILL");
        cleanupCheckPending = false;
        verifyCleanup();
      }, 250);
    }
    child.stdout.on("data", chunk => {
      try { stdout = append(stdout, chunk); }
      catch (error) { terminate(error); }
    });
    child.stderr.on("data", chunk => {
      try { stderr = append(stderr, chunk); }
      catch (error) { terminate(error); }
    });
    child.once("error", error => terminationError ? verifyCleanup() : finish(error));
    child.once("exit", code => {
      if (terminationError) verifyCleanup();
      else finish(null, { code: code ?? 1, stdout, stderr });
    });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw coded("worktree_cancelled", "Worktree operation cancelled");
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(coded("worktree_cancelled", "Worktree operation cancelled"));
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onAbort = () => finish(coded("worktree_cancelled", "Worktree operation cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => finish(null, value), error => finish(error));
  });
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safeRelative(path) {
  return path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`) && !path.includes("\0");
}

function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "repository";
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
async function pathExists(path) { try { await lstat(path); return true; } catch { return false; } }
async function isDirectory(path) { try { return (await stat(path)).isDirectory(); } catch { return false; } }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }

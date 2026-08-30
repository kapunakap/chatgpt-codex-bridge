import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorktreeManager } from "./worktree-manager.mjs";

const firstId = "11111111-1111-1111-1111-111111111111";
const secondId = "22222222-2222-2222-2222-222222222222";

test("rejects unsafe roots and retention values", async () => {
  await assert.rejects(createWorktreeManager({ rootDir: "relative", stateDir: "/private/tmp/state", retention: 15 }));
  await assert.rejects(createWorktreeManager({ rootDir: "/private/tmp/root", stateDir: "/private/tmp/state", retention: 0 }));
});

async function git(cwd, ...args) {
  const result = await command("git", ["-C", cwd, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t) {
  const temp = await mkdtemp(join(tmpdir(), "local-codex-worktree-manager-"));
  const repo = join(temp, "repo");
  await mkdir(join(repo, "packages", "app"), { recursive: true });
  await git(temp, "init", repo);
  await git(repo, "config", "user.name", "Test User");
  await git(repo, "config", "user.email", "test@example.com");
  await writeFile(join(repo, "tracked.txt"), "committed\n");
  await writeFile(join(repo, "packages", "app", "app.txt"), "app committed\n");
  await writeFile(join(repo, ".gitignore"), "setup.local\nAGENTS.override.md\n");
  await writeFile(join(repo, ".worktreeinclude"), "setup.local\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await writeFile(join(repo, "setup.local"), "setup value\n");
  await writeFile(join(repo, "AGENTS.override.md"), "override value\n");
  t.after(() => rm(temp, { recursive: true, force: true }));
  return {
    temp,
    repo: await realpath(repo),
    rootDir: join(temp, "managed-worktrees"),
    stateDir: join(temp, "control"),
  };
}

test("creates a detached clean-HEAD worktree, maps subdirectories, copies declared setup, and disables hooks", async t => {
  const f = await repository(t);
  const marker = join(f.temp, "hook-ran");
  await mkdir(join(f.repo, ".githooks"));
  await writeFile(join(f.repo, ".githooks", "post-checkout"), `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`);
  await chmod(join(f.repo, ".githooks", "post-checkout"), 0o755);
  await git(f.repo, "config", "core.hooksPath", ".githooks");
  await writeFile(join(f.repo, "tracked.txt"), "dirty source\n");
  await writeFile(join(f.repo, "source-only.txt"), "untracked source\n");

  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 15 });
  const planned = await manager.plan({ id: firstId, sourceCwd: join(f.repo, "packages", "app") });
  assert.equal(planned.state, "planned");
  assert.equal(planned.sourceCwd, join(f.repo, "packages", "app"));
  assert.equal(planned.relativeCwd, "packages/app");
  const ready = await manager.prepare(firstId);
  assert.equal(ready.state, "ready");
  assert.equal(await readFile(join(ready.worktreeRoot, "tracked.txt"), "utf8"), "committed\n");
  await assert.rejects(readFile(join(ready.worktreeRoot, "source-only.txt"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(join(ready.worktreeRoot, "setup.local"), "utf8"), "setup value\n");
  assert.equal(await readFile(join(ready.worktreeRoot, "AGENTS.override.md"), "utf8"), "override value\n");
  assert.equal(await readFile(join(ready.executionCwd, "app.txt"), "utf8"), "app committed\n");
  assert.equal(await git(ready.worktreeRoot, "symbolic-ref", "-q", "HEAD").catch(() => ""), "");
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
  assert.equal((await stat(f.rootDir)).mode & 0o777, 0o700);
});

test("falls back to direct mode for disabled, non-Git, and unborn repositories", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 15 });
  const disabled = await manager.plan({ id: firstId, sourceCwd: f.repo, enabled: false });
  assert.equal(disabled.state, "direct");
  assert.equal(disabled.reason, "disabled");

  const plain = join(f.temp, "plain");
  await mkdir(plain);
  const nonGit = await manager.plan({ id: secondId, sourceCwd: plain });
  assert.equal(nonGit.state, "direct");
  assert.equal(nonGit.reason, "non_git");

  const unborn = join(f.temp, "unborn");
  await git(f.temp, "init", unborn);
  const unbornResult = await manager.plan({ id: "33333333-3333-3333-3333-333333333333", sourceCwd: unborn });
  assert.equal(unbornResult.state, "direct");
  assert.equal(unbornResult.reason, "unborn_head");
});

test("retention snapshots Git-visible work and declared setup, then restores after source deletion", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 1 });
  await manager.plan({ id: firstId, sourceCwd: f.repo });
  const first = await manager.prepare(firstId);
  await manager.bindThread(firstId, "thread-1");
  await writeFile(join(first.worktreeRoot, "tracked.txt"), "worktree change\n");
  await writeFile(join(first.worktreeRoot, "new.txt"), "new work\n");
  await writeFile(join(first.worktreeRoot, "run.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(first.worktreeRoot, "run.sh"), 0o755);
  await symlink("new.txt", join(first.worktreeRoot, "new-link"));
  await writeFile(join(first.worktreeRoot, "setup.local"), "changed setup\n");

  await manager.plan({ id: secondId, sourceCwd: f.repo });
  await manager.prepare(secondId);
  await manager.bindThread(secondId, "thread-2");
  const pruned = await manager.prune(new Set());
  assert.deepEqual(pruned.map(record => record.id), [firstId]);
  const snapshot = manager.get(firstId);
  assert.equal(snapshot.state, "snapshotted");
  assert.equal((await stat(snapshot.snapshotBundle)).mode & 0o777, 0o600);
  await assert.rejects(stat(first.worktreeRoot), { code: "ENOENT" });

  await rm(f.repo, { recursive: true, force: true });
  const restored = await manager.prepare(firstId);
  assert.equal(restored.state, "ready");
  assert.equal(await readFile(join(restored.worktreeRoot, "tracked.txt"), "utf8"), "worktree change\n");
  assert.equal(await readFile(join(restored.worktreeRoot, "new.txt"), "utf8"), "new work\n");
  assert.equal((await stat(join(restored.worktreeRoot, "run.sh"))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(restored.worktreeRoot, "new-link")), "new.txt");
  assert.equal(await readFile(join(restored.worktreeRoot, "setup.local"), "utf8"), "changed setup\n");
  assert.equal(await git(restored.worktreeRoot, "rev-parse", "HEAD"), snapshot.snapshotCommit);
});

test("active worktrees are protected and snapshot failure never deletes the worktree", async t => {
  const f = await repository(t);
  const manager = await createWorktreeManager({ rootDir: f.rootDir, stateDir: f.stateDir, retention: 1 });
  await manager.plan({ id: firstId, sourceCwd: f.repo });
  const first = await manager.prepare(firstId);
  await manager.bindThread(firstId, "thread-1");
  await manager.plan({ id: secondId, sourceCwd: f.repo });
  const second = await manager.prepare(secondId);
  await manager.bindThread(secondId, "thread-2");
  const protectedPrune = await manager.prune(new Set([firstId]));
  assert.deepEqual(protectedPrune.map(record => record.id), [secondId]);
  assert.equal((await lstat(first.worktreeRoot)).isDirectory(), true);

  const thirdId = "33333333-3333-3333-3333-333333333333";
  await manager.plan({ id: thirdId, sourceCwd: f.repo });
  const third = await manager.prepare(thirdId);
  await manager.bindThread(thirdId, "thread-3");
  manager.gitBin = join(f.temp, "missing-git");
  const failed = await manager.prune(new Set([firstId]));
  assert.deepEqual(failed, []);
  assert.equal((await lstat(third.worktreeRoot)).isDirectory(), true);
});

function command(commandName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

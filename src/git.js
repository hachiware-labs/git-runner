import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { CliError, EXIT_CODES } from "./errors.js";

const execFileAsync = promisify(execFile);

export async function inspectRepository(repoPath) {
  const repoRoot = await gitStdout(["rev-parse", "--show-toplevel"], { cwd: repoPath });
  return path.resolve(repoRoot);
}

export async function resolveExecutionCommit({ repoRoot, commit, branch }) {
  if (commit) {
    return gitStdout(["rev-parse", "--verify", `${commit}^{commit}`], { cwd: repoRoot });
  }
  if (branch) {
    return gitStdout(["rev-parse", "--verify", `${branch}^{commit}`], { cwd: repoRoot });
  }
  return gitStdout(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repoRoot });
}

export async function currentBranch(repoRoot) {
  const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repoRoot, reject: false });
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function isWorkingTreeDirty(repoRoot) {
  const result = await git(["status", "--porcelain"], { cwd: repoRoot });
  return result.stdout.trim().length > 0;
}

export async function cloneRepository({ repo, destination }) {
  await git(["clone", repo, destination], { cwd: process.cwd() });
}

export async function fetchRepository(repoRoot) {
  await git(["fetch", "origin"], { cwd: repoRoot });
}

export async function checkoutDetached({ repoRoot, commit }) {
  await git(["checkout", "--detach", commit], { cwd: repoRoot });
}

export async function commitAndPush({ repoRoot, branch, message }) {
  let targetBranch = branch;

  if (targetBranch) {
    const branchExists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${targetBranch}`], {
      cwd: repoRoot,
      reject: false
    });
    if (branchExists.code === 0) {
      await git(["checkout", targetBranch], { cwd: repoRoot });
    } else {
      await git(["checkout", "-b", targetBranch], { cwd: repoRoot });
    }
  } else {
    targetBranch = await currentBranch(repoRoot);
    if (!targetBranch) {
      throw new CliError("detached HEAD requires --branch when using --commit-and-push", EXIT_CODES.gitFailure);
    }
  }

  await git(["add", "-A"], { cwd: repoRoot });
  const stagedDiff = await git(["diff", "--cached", "--quiet"], { cwd: repoRoot, reject: false });
  if (stagedDiff.code === 1) {
    await git(["commit", "-m", message], { cwd: repoRoot });
  } else if (stagedDiff.code !== 0) {
    throw new CliError(`git diff --cached failed: ${stagedDiff.stderr.trim()}`, EXIT_CODES.gitFailure);
  }

  await git(["push", "-u", "origin", targetBranch], { cwd: repoRoot });
  return targetBranch;
}

async function gitStdout(args, options) {
  const result = await git(args, options);
  return result.stdout.trim();
}

async function git(args, { cwd, reject = true }) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    const result = {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message
    };
    if (!reject) {
      return result;
    }
    throw new CliError(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`, EXIT_CODES.gitFailure);
  }
}

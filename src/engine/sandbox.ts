import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 隔离工作副本（sandbox）。
 *
 * 前面所有的安全机制——四级审批、硬拒绝、真实路径归属、命令路径判定——都属于
 * **"不让它做坏事"**。但它们都建立在"判断得对"之上：`classifyCommandZone` 自己就写着
 * 「这是启发式，不是沙箱」，而审批则依赖人真的看清了每一次确认。
 *
 * 这个模块补的是另一半：**"做了坏事也不影响你的工作树"**。
 * 做法是用 `git worktree` 开一份同源的工作副本，让 agent 在副本里随便改，
 * 跑完只把 diff 给人看，合不合由人决定。
 *
 * 为什么用 worktree 而不是 clone：worktree 和主仓库共用同一个对象库，
 * 开一份几乎不占空间也几乎不花时间，而 clone 一个大仓库两者都要付。
 *
 * 副本放在系统临时目录，**不放在工作区里面**——放里面的话 agent 自己就能看到、
 * 改到那份副本，隔离就没意义了。
 *
 * 它不是容器：agent 在副本里仍然能执行命令、能读工作区外的文件（要审批）、
 * 能联网。它挡住的是"改坏你的代码"，不是"越权访问系统"。真要那一层还得靠容器。
 */

export interface Sandbox {
  /** 副本目录（agent 的工作区就是这里） */
  dir: string;
  /** 副本所在的分支名 */
  branch: string;
  /** 原始仓库根目录 */
  repo: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 这个目录是不是一个（有过至少一次提交的）git 仓库 */
export function gitRepoRoot(dir: string): string | null {
  try {
    const root = git(dir, ['rev-parse', '--show-toplevel']).trim();
    // 没有任何提交时开不了 worktree，这里一并判掉，把错误提前
    git(dir, ['rev-parse', 'HEAD']);
    return root === '' ? null : root;
  } catch {
    return null;
  }
}

/**
 * 开一份工作副本。分支名带时间戳，便于事后在 `git branch` 里认出是哪一次跑的。
 * 副本从当前 `HEAD` 出发——**未提交的改动不会带进去**，这一点必须让调用方告诉用户，
 * 否则 agent 会基于一份"少了你本地改动"的代码干活。
 */
export function createSandbox(workspace: string): Sandbox {
  const repo = gitRepoRoot(workspace);
  if (repo === null) {
    throw new Error(
      `${workspace} 不是一个有提交历史的 git 仓库，开不了隔离副本。` +
        `先 git init && git commit，或者去掉 --sandbox 直接在工作区里跑。`,
    );
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const branch = `glassbox/sandbox-${stamp}-${process.pid}`;
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-sandbox-')), path.basename(repo));

  git(repo, ['worktree', 'add', '--quiet', '-b', branch, dir, 'HEAD']);
  return { dir, branch, repo };
}

/** 副本里没提交的改动有几个文件（0 表示 agent 什么都没改） */
export function changedFiles(box: Sandbox): string[] {
  // add -A 先把新文件纳入索引，否则 diff 看不见它们
  git(box.dir, ['add', '-A']);
  return git(box.dir, ['diff', '--cached', '--name-only', 'HEAD'])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** 副本相对出发点的完整补丁（含新文件）。没有改动时返回空串 */
export function sandboxPatch(box: Sandbox): string {
  git(box.dir, ['add', '-A']);
  return git(box.dir, ['diff', '--cached', '--binary', 'HEAD']);
}

/** 每个文件加了几行删了几行，用来给人一眼的概览 */
export function patchStat(box: Sandbox): string {
  git(box.dir, ['add', '-A']);
  return git(box.dir, ['diff', '--cached', '--stat', 'HEAD']).trimEnd();
}

/**
 * 把补丁打到原始仓库的工作树上。
 *
 * 用 `git apply`（而不是 merge/cherry-pick）是刻意的：它只动工作树，不碰分支、
 * 不产生提交、不改 HEAD。合进来之后你手上就是一份普通的未提交改动，
 * 想留就 commit，不想留 `git checkout -- .` 就没了——回退成本最低。
 *
 * 打不上就如实报错并且什么都不改（`git apply` 本身是原子的）。
 */
export function applyPatch(box: Sandbox, patch: string): { ok: true } | { ok: false; error: string } {
  if (patch.trim() === '') return { ok: false, error: '补丁是空的，没有改动可合入' };
  const file = path.join(os.tmpdir(), `gb-patch-${process.pid}-${Date.now()}.diff`);
  fs.writeFileSync(file, patch, 'utf8');
  try {
    execFileSync('git', ['apply', '--index', file], { cwd: box.repo, encoding: 'utf8' });
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, error: (err.stderr ?? err.message).trim() };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * 拆掉副本（目录 + worktree 登记 + 分支）。
 *
 * 默认**不**自动调用：副本里有这次跑的会话日志和黑匣子，跑完人往往还要回看。
 * 只在"agent 一个字都没改"的时候由调用方顺手清掉。
 */
export function removeSandbox(box: Sandbox): void {
  try {
    git(box.repo, ['worktree', 'remove', '--force', box.dir]);
  } catch {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
  try {
    git(box.repo, ['branch', '-D', box.branch]);
  } catch {
    // 分支删不掉不影响正确性，留着比报错好
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPatch,
  changedFiles,
  createSandbox,
  gitRepoRoot,
  patchStat,
  removeSandbox,
  sandboxPatch,
} from '../src/engine/sandbox.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** 一个有一次提交的最小仓库 */
function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-repo-')));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'T']);
  git(dir, ['config', 'user.email', 't@example.com']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.glassbox\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

test('gitRepoRoot：非仓库、以及有仓库但没提交，都返回 null', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-plain-'));
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-fresh-'));
  try {
    assert.equal(gitRepoRoot(plain), null, '不是 git 仓库');
    git(fresh, ['init', '-q']);
    assert.equal(gitRepoRoot(fresh), null, '有 .git 但没有提交，开不了 worktree，要提前判掉');
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test('没提交历史时 createSandbox 明确报错，并指出可以去掉 --sandbox', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-plain-'));
  try {
    assert.throws(() => createSandbox(plain), /git init|--sandbox/);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('副本在工作区之外，内容与 HEAD 一致，初始零改动', () => {
  const r = repo();
  let box;
  try {
    box = createSandbox(r);
    assert.ok(!box.dir.startsWith(r), '副本不能放在工作区里面，否则 agent 自己就能改到它');
    assert.equal(fs.readFileSync(path.join(box.dir, 'a.txt'), 'utf8'), 'one\ntwo\n');
    assert.deepEqual(changedFiles(box), []);
  } finally {
    if (box) removeSandbox(box);
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('副本从 HEAD 出发：主仓库里未提交的改动不会带进去', () => {
  const r = repo();
  let box;
  try {
    fs.writeFileSync(path.join(r, 'a.txt'), '我在主仓库改了但没提交\n');
    box = createSandbox(r);
    assert.equal(fs.readFileSync(path.join(box.dir, 'a.txt'), 'utf8'), 'one\ntwo\n');
  } finally {
    if (box) removeSandbox(box);
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('在副本里乱改不影响主仓库；改动能变成补丁再打回来', () => {
  const r = repo();
  let box;
  try {
    box = createSandbox(r);
    fs.writeFileSync(path.join(box.dir, 'a.txt'), 'one\nCHANGED\n');
    fs.writeFileSync(path.join(box.dir, 'new.txt'), 'brand new\n');

    // 主仓库一个字节都没动
    assert.equal(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), 'one\ntwo\n');
    assert.equal(fs.existsSync(path.join(r, 'new.txt')), false);

    assert.deepEqual(changedFiles(box).sort(), ['a.txt', 'new.txt']);
    assert.match(patchStat(box), /2 files changed/);

    const patch = sandboxPatch(box);
    assert.match(patch, /new file mode/, '新文件也要在补丁里，不能只有改动过的');

    assert.deepEqual(applyPatch(box, patch), { ok: true });
    assert.equal(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), 'one\nCHANGED\n');
    assert.equal(fs.readFileSync(path.join(r, 'new.txt'), 'utf8'), 'brand new\n');
  } finally {
    if (box) removeSandbox(box);
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('打不上的补丁如实报错，并且主仓库保持原样（git apply 是原子的）', () => {
  const r = repo();
  let box;
  try {
    box = createSandbox(r);
    fs.writeFileSync(path.join(box.dir, 'a.txt'), 'one\nCHANGED\n');
    const patch = sandboxPatch(box);

    // 主仓库这边把同一个文件改成别的样子，补丁的上下文就对不上了
    fs.writeFileSync(path.join(r, 'a.txt'), '完全不一样的内容\n');
    const res = applyPatch(box, patch);
    assert.equal(res.ok, false);
    assert.ok(res.ok === false && res.error.length > 0, '要把 git 的原话带回来');
    assert.equal(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), '完全不一样的内容\n');
  } finally {
    if (box) removeSandbox(box);
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('空补丁不当成成功', () => {
  const r = repo();
  let box;
  try {
    box = createSandbox(r);
    const res = applyPatch(box, '');
    assert.equal(res.ok, false);
    assert.ok(res.ok === false && /空/.test(res.error));
  } finally {
    if (box) removeSandbox(box);
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('removeSandbox 把目录、worktree 登记和分支一起收拾干净', () => {
  const r = repo();
  const box = createSandbox(r);
  try {
    assert.ok(git(r, ['worktree', 'list']).includes(box.dir));
    assert.ok(git(r, ['branch', '--list', box.branch]).trim() !== '');

    removeSandbox(box);
    assert.equal(fs.existsSync(box.dir), false);
    assert.ok(!git(r, ['worktree', 'list']).includes(box.dir));
    assert.equal(git(r, ['branch', '--list', box.branch]).trim(), '', '分支也要删掉，否则越跑越多');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('.gitignore 掉的 .glassbox 不进补丁——会话日志不该被当成改动合回来', () => {
  const r = repo();
  let box;
  try {
    box = createSandbox(r);
    fs.mkdirSync(path.join(box.dir, '.glassbox/sessions'), { recursive: true });
    fs.writeFileSync(path.join(box.dir, '.glassbox/sessions/s.jsonl'), '{}\n');
    fs.writeFileSync(path.join(box.dir, 'real.txt'), 'x\n');

    assert.deepEqual(changedFiles(box), ['real.txt']);
    assert.ok(!sandboxPatch(box).includes('.glassbox'));
  } finally {
    if (box) removeSandbox(box);
    fs.rmSync(r, { recursive: true, force: true });
  }
});

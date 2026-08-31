import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyPathZone, realpathDeep, resolveInWorkspace } from '../src/plugins/paths.ts';

const ws = '/tmp/glassbox-ws';

function tmpWs(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-zone-')));
}

test('工作区内路径 inside=true', () => {
  assert.equal(resolveInWorkspace(ws, 'a.txt').inside, true);
  assert.equal(resolveInWorkspace(ws, 'sub/dir/b.txt').inside, true);
  assert.equal(resolveInWorkspace(ws, './c.txt').inside, true);
});

test('越界路径 inside=false', () => {
  assert.equal(resolveInWorkspace(ws, '../x.txt').inside, false);
  assert.equal(resolveInWorkspace(ws, '/etc/passwd').inside, false);
});

test('realpathDeep：文件还不存在时，解析最深的已存在祖先再拼字面后缀', () => {
  const dir = tmpWs();
  try {
    const real = realpathDeep(path.join(dir, 'not/created/yet.txt'));
    assert.equal(real, path.join(dir, 'not/created/yet.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('软链指向工作区外 → zone=outside（纯字面判断会误判成 inside）', () => {
  const dir = tmpWs();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-out-')));
  try {
    fs.writeFileSync(path.join(outside, 'secret.pem'), 'KEY\n');
    fs.symlinkSync(path.join(outside, 'secret.pem'), path.join(dir, 'link.pem'));
    // 字面上 link.pem 就在工作区里
    assert.equal(path.relative(dir, path.resolve(dir, 'link.pem')).startsWith('..'), false);
    // 真实路径不在
    assert.equal(classifyPathZone(dir, 'link.pem'), 'outside');
    const r = resolveInWorkspace(dir, 'link.pem');
    assert.equal(r.inside, false);
    assert.equal(r.real, path.join(outside, 'secret.pem'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('目录软链出去后，其下的子路径同样算 outside', () => {
  const dir = tmpWs();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-out-')));
  try {
    fs.symlinkSync(outside, path.join(dir, 'esc'));
    assert.equal(classifyPathZone(dir, 'esc/deep/a.txt'), 'outside');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('悬空软链按它指向的目标判断，不因为读不到就当 inside', () => {
  const dir = tmpWs();
  try {
    fs.symlinkSync('/tmp/gb-does-not-exist-xyz/a.txt', path.join(dir, 'dangling'));
    assert.equal(classifyPathZone(dir, 'dangling'), 'outside');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.git 下的路径是独立的 protected 区，不与 inside 混同', () => {
  const dir = tmpWs();
  try {
    fs.mkdirSync(path.join(dir, '.git/hooks'), { recursive: true });
    assert.equal(classifyPathZone(dir, '.git/config'), 'protected');
    assert.equal(classifyPathZone(dir, '.git/hooks/pre-commit'), 'protected');
    assert.equal(classifyPathZone(dir, 'src/.git/x'), 'protected');
    assert.equal(classifyPathZone(dir, 'src/git/x'), 'inside');
    // .gitignore 只是前缀相同，不该被误伤
    assert.equal(classifyPathZone(dir, '.gitignore'), 'inside');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('工作区本身是软链时，其下的普通文件仍是 inside', () => {
  const real = tmpWs();
  const linkDir = path.join(os.tmpdir(), `gb-link-${process.pid}-${Date.now()}`);
  try {
    fs.symlinkSync(real, linkDir);
    assert.equal(classifyPathZone(linkDir, 'a/b.txt'), 'inside');
  } finally {
    fs.rmSync(linkDir, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

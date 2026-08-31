import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flagValue, hasFlag, resolveWorkspace, stripFlags } from '../src/cli.ts';

test('flagValue 取 --flag 后面那个值，支持别名', () => {
  assert.equal(flagValue(['--workspace', '/tmp/x'], '--workspace', '-C'), '/tmp/x');
  assert.equal(flagValue(['-C', '/tmp/y'], '--workspace', '-C'), '/tmp/y');
  assert.equal(flagValue(['--workspace'], '--workspace'), undefined, '后面没值不算');
  // 后面紧跟另一个 flag 时也不算值，否则 `--workspace --json` 会把 --json 当成目录
  assert.equal(flagValue(['--workspace', '--json'], '--workspace'), undefined);
  assert.equal(flagValue(['echo', 'hi'], '--workspace'), undefined);
});

test('hasFlag 认多个别名', () => {
  assert.equal(hasFlag(['a', '--json'], '--json'), true);
  assert.equal(hasFlag(['a'], '--json'), false);
});

test('stripFlags 把带值的 flag 连值一起摘掉，剩下的才是用户的话', () => {
  const argv = ['写个', '--workspace', '/tmp/x', '函数', '--json'];
  assert.deepEqual(stripFlags(argv, ['--workspace', '-C'], ['--json']), ['写个', '函数']);
  // 只声明为布尔的 flag 不吃掉后面的词
  assert.deepEqual(stripFlags(['--json', 'echo', 'hi'], [], ['--json']), ['echo', 'hi']);
});

test('resolveWorkspace：--workspace > GB_WORKSPACE > 当前目录', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-ws-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-ws-b-'));
  const saved = process.env.GB_WORKSPACE;
  try {
    delete process.env.GB_WORKSPACE;
    assert.equal(resolveWorkspace([]), process.cwd(), '什么都没给就是当前目录');

    process.env.GB_WORKSPACE = b;
    assert.equal(resolveWorkspace([]), path.resolve(b), '环境变量生效');
    assert.equal(resolveWorkspace(['--workspace', a]), path.resolve(a), '命令行优先于环境变量');

    delete process.env.GB_WORKSPACE;
    assert.equal(resolveWorkspace(['-C', a]), path.resolve(a), '-C 是别名');
    // 相对路径要展开成绝对路径：工作区是所有安全边界的原点，不能是相对的
    assert.ok(path.isAbsolute(resolveWorkspace(['--workspace', '.'])));
  } finally {
    if (saved === undefined) delete process.env.GB_WORKSPACE;
    else process.env.GB_WORKSPACE = saved;
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

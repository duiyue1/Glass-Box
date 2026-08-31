import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { loadPlugins } from '../src/engine/plugin.ts';
import { searchPlugin, globToRegExp } from '../src/plugins/searchPlugin.ts';
import { parseCommand } from '../src/llm/commandGrammar.ts';

/** 造一个小工作区：src/a.ts、src/b.ts、src/deep/c.ts、notes.md */
function fixture(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-search-'));
  fs.mkdirSync(path.join(ws, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export const TurnState = 1;\n// todo: a\n');
  fs.writeFileSync(path.join(ws, 'src', 'b.ts'), 'const turnstate = 2;\n// TODO: b\n// TODO: bb\n');
  fs.writeFileSync(path.join(ws, 'src', 'deep', 'c.ts'), 'TurnState again\n');
  fs.writeFileSync(path.join(ws, 'notes.md'), 'TurnState 出现在文档里\n');
  return ws;
}

function tools(ws: string): ToolRegistry {
  const reg = new ToolRegistry();
  loadPlugins([searchPlugin()], { tools: reg, wire: new Wire(), workspace: ws });
  return reg;
}

const run = async (reg: ToolRegistry, name: string, args: Record<string, unknown>) =>
  await reg.get(name)!.run(args);

test('globToRegExp: 不含斜杠的模式按“任意目录下”理解', () => {
  const re = globToRegExp('*.ts');
  assert.ok(re.test('a.ts'));
  assert.ok(re.test('src/deep/c.ts'));
  assert.ok(!re.test('a.md'));
});

test('globToRegExp: ** 跨目录，* 不跨目录，{a,b} 多选', () => {
  assert.ok(globToRegExp('src/**/*.ts').test('src/deep/c.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a.ts')); // **/ 允许零层目录
  assert.ok(!globToRegExp('src/*.ts').test('src/deep/c.ts'));
  const both = globToRegExp('*.{ts,md}');
  assert.ok(both.test('notes.md'));
  assert.ok(both.test('src/a.ts'));
  assert.ok(!both.test('x.json'));
});

test('glob 工具按模式列出文件', async () => {
  const ws = fixture();
  const reg = tools(ws);
  const out = await run(reg, 'glob', { pattern: 'src/**/*.ts' });
  const files = out.content.split('\n').sort();
  assert.deepEqual(files, ['src/a.ts', 'src/b.ts', 'src/deep/c.ts']);
  assert.equal(out.meta?.action, 'searched');
  assert.equal(out.meta?.added, 3);

  const none = await run(reg, 'glob', { pattern: '*.py' });
  assert.equal(none.content, '(无匹配文件)');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('grep 支持 glob 限定范围与忽略大小写', async () => {
  const ws = fixture();
  const reg = tools(ws);

  const scoped = await run(reg, 'grep', { pattern: 'TurnState', glob: '*.ts' });
  assert.ok(!scoped.content.includes('notes.md'), 'glob 应把 .md 排除在外');
  assert.ok(scoped.content.includes('src/a.ts:1'));

  const ci = await run(reg, 'grep', { pattern: 'turnstate', ignoreCase: true, glob: '*.ts' });
  assert.equal(ci.meta?.added, 3, '忽略大小写后 a/b/c 三处都该命中');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('grep 的 files / count 输出模式', async () => {
  const ws = fixture();
  const reg = tools(ws);

  const files = await run(reg, 'grep', { pattern: 'TODO', mode: 'files' });
  assert.equal(files.content, 'src/b.ts');

  const count = await run(reg, 'grep', { pattern: 'TODO', mode: 'count' });
  assert.ok(count.content.includes('src/b.ts: 2'));
  assert.ok(count.content.includes('共 2 处，1 个文件'));
  fs.rmSync(ws, { recursive: true, force: true });
});

test('指令语法解析 glob 与 grep 的开关/范围', () => {
  assert.deepEqual(parseCommand('glob **/*.test.ts'), {
    name: 'glob',
    args: { pattern: '**/*.test.ts' },
  });
  assert.deepEqual(parseCommand('grep -i streamgate in *.ts'), {
    name: 'grep',
    args: { ignoreCase: true, pattern: 'streamgate', glob: '*.ts' },
  });
  assert.deepEqual(parseCommand('grep -l TurnState'), {
    name: 'grep',
    args: { mode: 'files', pattern: 'TurnState' },
  });
  assert.deepEqual(parseCommand('grep -c TODO in src/**'), {
    name: 'grep',
    args: { mode: 'count', pattern: 'TODO', glob: 'src/**' },
  });
  // 正则里带 " in " 时，按最后一个 in 切分，前半段仍是完整正则
  assert.deepEqual(parseCommand('grep built in cache in *.ts'), {
    name: 'grep',
    args: { pattern: 'built in cache', glob: '*.ts' },
  });
  // 没有范围时保持原样
  assert.deepEqual(parseCommand('grep TurnState'), { name: 'grep', args: { pattern: 'TurnState' } });
});

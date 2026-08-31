import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, toToolCall } from '../src/llm/commandGrammar.ts';

test('parseCommand 识别各类指令', () => {
  assert.equal(parseCommand('read a.ts')?.name, 'read_file');
  assert.deepEqual(parseCommand('read  pkg.json')?.args, { path: 'pkg.json' });

  const w = parseCommand('write x.txt :: hello world');
  assert.equal(w?.name, 'write_file');
  assert.deepEqual(w?.args, { path: 'x.txt', content: 'hello world' });

  assert.equal(parseCommand('run ls -la')?.name, 'run_command');
  assert.equal(parseCommand('grep TurnState')?.name, 'grep');
  assert.equal(parseCommand('delegate 去搜索一下')?.name, 'delegate');
  assert.equal(parseCommand('echo hi')?.name, 'echo');

  const e = parseCommand('edit a.txt ||| 旧内容 ||| 新内容');
  assert.equal(e?.name, 'edit_file');
  assert.deepEqual(e?.args, { path: 'a.txt', old: '旧内容', new: '新内容' });
});

test('parseCommand 对非指令返回 null', () => {
  assert.equal(parseCommand('今天天气怎么样'), null);
  assert.equal(parseCommand(''), null);
});

test('toToolCall 包装出带 id 的 ToolCall', () => {
  const call = toToolCall({ name: 'grep', args: { pattern: 'x' } }, 'c1');
  assert.equal(call.id, 'c1');
  assert.equal(call.name, 'grep');
  assert.deepEqual(call.args, { pattern: 'x' });
});

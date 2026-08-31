import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamGate } from '../src/llm/streamGate.ts';

test('普通文本：攒到换行后放行，之后逐块透传', () => {
  const g = new StreamGate();
  assert.equal(g.push('你好，'), '');
  const out = g.push('我是助手。\n');
  assert.equal(out, '你好，我是助手。\n');
  assert.equal(g.push('后续内容'), '后续内容');
  assert.equal(g.isSuppressed(), false);
});

test('ACTION 指令：整轮都不显示', () => {
  const g = new StreamGate();
  assert.equal(g.push('ACTION: grep '), '');
  assert.equal(g.push('TurnState\n'), '');
  assert.equal(g.push('多余内容'), '');
  assert.equal(g.flush(), '');
  assert.equal(g.isSuppressed(), true);
});

test('被代码块包裹的 ACTION 也不显示', () => {
  const g = new StreamGate();
  g.push('```\nACTION: read a.ts\n');
  assert.equal(g.isSuppressed(), true);
});

test('流结束时 flush 吐出未判定的短文本', () => {
  const g = new StreamGate();
  assert.equal(g.push('短回复'), '');
  assert.equal(g.flush(), '短回复');
  assert.equal(g.isSuppressed(), false);
});

test('不含换行的长文本达到阈值后放行', () => {
  const g = new StreamGate();
  const long = 'a'.repeat(70);
  assert.equal(g.push(long), long);
});

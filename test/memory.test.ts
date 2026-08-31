import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, makeAtom } from '../src/memory/store.ts';

test('retrieve 按关键词命中打分', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', '这个项目用 Gurobi 求解器'), makeAtom('preference', '用 TypeScript')]);
  const r = s.retrieve('Gurobi 怎么配置', { maxItems: 3, maxTokens: 100 });
  assert.equal(r.items.length, 1);
  assert.ok(r.items[0].atom.text.includes('Gurobi'));
});

test('retrieve 条数预算封顶并计丢弃数', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', 'Gurobi 求解器'), makeAtom('fact', 'Gurobi 版本 11'), makeAtom('fact', 'Gurobi 许可证')]);
  const r = s.retrieve('Gurobi', { maxItems: 1, maxTokens: 100 });
  assert.equal(r.items.length, 1);
  assert.ok(r.dropped >= 1);
});

test('retrieve token 预算封顶', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', 'Gurobi ' + 'x'.repeat(400))]);
  const r = s.retrieve('Gurobi', { maxItems: 5, maxTokens: 5 });
  assert.equal(r.items.length, 0);
  assert.ok(r.dropped >= 1);
});

test('upsertAtoms 对相同内容去重', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('preference', '用 TypeScript')]);
  s.upsertAtoms([makeAtom('preference', '用 TypeScript')]);
  assert.equal(s.atomCount(), 1);
});

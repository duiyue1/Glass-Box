import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wire } from '../src/engine/wire.ts';
import { Memory } from '../src/memory/memory.ts';

const budget = { maxItems: 3, maxTokens: 100 };

function tmpFile(): string {
  return path.join(os.tmpdir(), `gb-mem-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('记忆落盘后可被新实例加载', () => {
  const file = tmpFile();
  try {
    // 第一个实例：蒸馏并落盘
    const w1 = new Wire();
    const m1 = new Memory(w1, budget, file);
    m1.init();
    w1.emit({ type: 'turn.start', turnId: 't1', userText: '记住这个项目用 Gurobi 求解器', ts: Date.now() });
    w1.emit({ type: 'turn.end', turnId: 't1', messages: [], ts: Date.now() });
    assert.equal(m1.atomCount(), 1);
    assert.ok(fs.existsSync(file), '应已落盘');

    // 第二个实例：从磁盘恢复
    const w2 = new Wire();
    const m2 = new Memory(w2, budget, file);
    m2.init();
    assert.equal(m2.atomCount(), 1, '新实例应加载到历史记忆');

    // 恢复的记忆能被检索注入
    const contributions = m2.provider().provide('Gurobi 怎么配置');
    assert.ok(Array.isArray(contributions) && contributions.length === 1);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('memory.loaded 事件带回加载条数', () => {
  const file = tmpFile();
  try {
    const w1 = new Wire();
    const m1 = new Memory(w1, budget, file);
    m1.init();
    w1.emit({ type: 'turn.start', turnId: 't1', userText: '我喜欢用 TypeScript', ts: Date.now() });
    w1.emit({ type: 'turn.end', turnId: 't1', messages: [], ts: Date.now() });

    const w2 = new Wire();
    let loadedCount = -1;
    w2.subscribe((e) => {
      if (e.type === 'memory.loaded') loadedCount = e.count;
    });
    const m2 = new Memory(w2, budget, file);
    m2.init();
    assert.equal(loadedCount, 1);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

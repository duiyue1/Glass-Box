import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wire } from '../src/engine/wire.ts';
import { Compactor } from '../src/engine/compact.ts';
import { pruneText, pruneToolResults, resolvePruneConfig } from '../src/engine/prune.ts';
import type { Msg, ToolSpec } from '../src/engine/types.ts';

test('摘要交给模型写，而且带上同样的工具声明好命中前缀缓存', async () => {
  const wire = new Wire();
  const seen: { msgs: number; tools?: ToolSpec[]; last?: string } = { msgs: 0 };
  const compactor = new Compactor(wire, {
    retainRatio: 0.2,
    pruneChars: null,
    summarizer: async (msgs, tools) => {
      seen.msgs = msgs.length;
      seen.tools = tools;
      return '## 1. 最初的请求与意图\n用户要读那个文件\n## 4. 出过的错与怎么修的\n（无）';
    },
  });
  let byModel: boolean | undefined;
  wire.subscribe((e) => {
    if (e.type === 'context.compacted') byModel = e.byModel;
  });

  const specs: ToolSpec[] = [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } }];
  const msgs: Msg[] = [
    { role: 'user', content: '第一句问题问得比较长，好让它够被压掉' },
    { role: 'assistant', content: '第一次回答也写长一些，凑够被压缩的量' },
    { role: 'user', content: '第二句问题' },
    { role: 'assistant', content: '第二次回答' },
  ];
  await compactor.compact(msgs, 20, specs);

  assert.ok(seen.msgs > 0, '待压缩的消息要递给摘要器');
  assert.deepEqual(seen.tools, specs, '工具声明要原样传下去');
  assert.equal(byModel, true, '事件里要标明这份摘要是模型写的');
  assert.match(msgs[0].content, /最初的请求与意图/, '模型写的结构化摘要应该落进历史');
});

test('摘要生成失败就退回机械拼接，不让整个回合垮掉', async () => {
  const wire = new Wire();
  const compactor = new Compactor(wire, {
    retainRatio: 0.2,
    pruneChars: null,
    summarizer: async () => undefined,
  });
  let byModel: boolean | undefined = true;
  wire.subscribe((e) => {
    if (e.type === 'context.compacted') byModel = e.byModel;
  });

  const msgs: Msg[] = [
    { role: 'user', content: '第一句问题问得比较长，好让它够被压掉' },
    { role: 'assistant', content: '第一次回答也写长一些，凑够被压缩的量' },
    { role: 'user', content: '第二句问题' },
    { role: 'assistant', content: '第二次回答' },
  ];
  await compactor.compact(msgs, 20);

  assert.equal(byModel, false, '退回机械摘要时要如实标出来');
  assert.match(msgs[0].content, /第一句问题/, '机械摘要保留用户说过的话');
});

test('没超阈值就一个字不动', () => {
  const cfg = resolvePruneConfig(2000);
  assert.equal(pruneText('短输出', cfg), null);
  assert.equal(pruneText('x'.repeat(2000), cfg), null, '正好等于阈值也不削');
});

test('超阈值就掐中间：留头 + 记号 + 留尾，而且一定更短', () => {
  const cfg = resolvePruneConfig(300);
  const text = 'H'.repeat(cfg.headChars) + 'M'.repeat(500) + 'T'.repeat(cfg.tailChars);
  const out = pruneText(text, cfg);
  assert.ok(out, '应该被削');
  assert.ok(out.startsWith('H'.repeat(cfg.headChars)), '头部原样保留');
  assert.ok(out.endsWith('T'.repeat(cfg.tailChars)), '尾部原样保留');
  assert.match(out, /中间省略 \d+ 字/, '要留下记号说明省了多少');
  assert.ok(Array.from(out).length <= cfg.thresholdChars, '削完必须落回阈值以内');
});

test('按码点切，不会把 emoji 切成两半', () => {
  const cfg = resolvePruneConfig(300);
  // 让 emoji 正好压在留头的边界上：按 UTF-16 下标切会切出半个代理对
  const head = 'a'.repeat(cfg.headChars - 1) + '😀';
  const out = pruneText(head + 'b'.repeat(500), cfg);
  assert.ok(out);
  assert.ok(out.startsWith(head), '边界上的 emoji 要完整');
  assert.ok(!out.includes('\ufffd'), '不该出现替换字符');
});

test('幂等：削过的再削一次不变，不会套两层记号', () => {
  const cfg = resolvePruneConfig(300);
  const msgs: Msg[] = [{ role: 'tool', content: 'x'.repeat(5000) }];
  pruneToolResults(msgs, cfg);
  const once = msgs[0].content;
  const again = pruneToolResults(msgs, cfg);

  assert.equal(again.pruned, 0, '第二次不该再削');
  assert.equal(msgs[0].content, once);
  assert.equal(once.match(/中间省略/g)?.length, 1, '只能有一个记号');
});

test('只削 tool 消息，用户说过的话和模型的结论一个字不动', () => {
  const cfg = resolvePruneConfig(300);
  const big = 'x'.repeat(5000);
  const msgs: Msg[] = [
    { role: 'user', content: big },
    { role: 'assistant', content: big },
    { role: 'system', content: big },
    { role: 'tool', content: big },
  ];
  const r = pruneToolResults(msgs, cfg);

  assert.equal(r.pruned, 1, '只有那条 tool 被削');
  assert.ok(r.charsRemoved > 4000);
  assert.equal(msgs[0].content, big, 'user 不动');
  assert.equal(msgs[1].content, big, 'assistant 不动');
  assert.equal(msgs[2].content, big, 'system 不动');
  assert.ok(msgs[3].content.length < big.length, 'tool 被削短');
});

test('第一级削完够用就不走摘要，消息一条不丢', async () => {
  const wire = new Wire();
  const compactor = new Compactor(wire, { retainRatio: 0.2, pruneChars: 300 });
  const events: string[] = [];
  wire.subscribe((e) => {
    if (e.type === 'context.pruned' || e.type === 'context.compacted') events.push(e.type);
  });

  const msgs: Msg[] = [
    { role: 'user', content: '读一下那个文件' },
    { role: 'assistant', content: '[调用工具 read_file]' },
    { role: 'tool', content: 'x'.repeat(4000) },
  ];
  const changed = await compactor.compact(msgs, 200);

  assert.equal(changed, true);
  assert.deepEqual(events, ['context.pruned'], '只削，不该摘要');
  assert.equal(msgs.length, 3, '一条消息都没丢');
  assert.equal(msgs[0].content, '读一下那个文件', '用户的问题还在');
});

test('关掉第一级之后，大工具输出就没救了——摘要救不了保留区里的东西', async () => {
  const wire = new Wire();
  const compactor = new Compactor(wire, { retainRatio: 0.2, pruneChars: null });
  const events: string[] = [];
  wire.subscribe((e) => {
    if (e.type === 'context.pruned' || e.type === 'context.compacted') events.push(e.type);
  });

  const msgs: Msg[] = [
    { role: 'user', content: '读一下那个文件' },
    { role: 'assistant', content: '[调用工具 read_file]' },
    { role: 'tool', content: 'x'.repeat(4000) },
    { role: 'assistant', content: '读完了' },
  ];
  const changed = await compactor.compact(msgs, 200);

  // 那条 4000 字的工具结果落在保留区里，摘要只能动它前面那条短 user 消息，
  // 而摘要比那条消息还贵，于是什么也做不了。这正是第一级存在的理由。
  assert.deepEqual(events, [], '压不动，一个事件都不该发');
  assert.equal(changed, false);
  assert.equal(msgs[2].content.length, 4000, '工具输出一个字没少');
});

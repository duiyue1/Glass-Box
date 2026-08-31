import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { Loop, type Llm } from '../src/engine/loop.ts';
import { Session } from '../src/engine/session.ts';
import { Compactor } from '../src/engine/compact.ts';
import { estimateText } from '../src/engine/tokens.ts';
import { resolveBudget, resolveInjectBudget } from '../src/app.ts';
import type { Msg, LlmResponse, ContextProvider } from '../src/engine/types.ts';

class TextLlm implements Llm {
  async complete(_messages: Msg[]): Promise<LlmResponse> {
    return { text: '这是一段足够长的回复内容用于累积上下文长度' };
  }
}

test('历史超预算时触发上下文压缩', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  const loop = new Loop(wire, tools, new TextLlm(), { decide: async () => true }, { budget: 10 });
  const session = new Session(loop, wire, 10);

  let compacted = false;
  wire.subscribe((e) => {
    if (e.type === 'context.compacted') compacted = true;
  });

  await session.ask('第一句比较长的话用来增加历史长度');
  await session.ask('第二句同样比较长的话继续增加历史');
  await session.ask('第三句');

  assert.ok(compacted, '应触发至少一次压缩');
});

test('压缩摘要里带上任务计划快照（否则"干到哪儿了"会被压掉）', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  const loop = new Loop(wire, tools, new TextLlm(), { decide: async () => true }, { budget: 10 });
  const session = new Session(loop, wire, 10, 2, {
    planSnapshot: () => '【任务计划】1/2 完成\n1 ✔ 建 store.js\n2 ○ 补测试',
  });

  // 提问故意写得短、回复长：摘要只收录用户说过的话，只有被丢掉的内容明显更大时才值得换成摘要
  for (const q of ['一', '二', '三', '四']) await session.ask(q);

  const history = (session as unknown as { history: Msg[] }).history;
  const summary = history.find((m) => m.role === 'system' && m.content.includes('早前对话摘要'));
  assert.ok(summary, '应该有摘要');
  assert.match(summary.content, /2 ○ 补测试/, '摘要里要能看到还没干完的步骤');
});

test('压缩不会切出没有 assistant 配对的 tool 消息（否则网关 400）', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  tools.register({ name: 'noop', description: '假工具', run: () => ({ ok: true, content: '好了' }) });

  // 一回合里先调一次工具再收尾 → 历史尾部是 assistant(tool_calls) + tool + assistant
  class ToolThenText implements Llm {
    private i = 0;
    async complete(): Promise<LlmResponse> {
      return this.i++ % 2 === 0
        ? { toolCalls: [{ id: `c${this.i}`, name: 'noop', args: {} }] }
        : { text: '这一轮干完了，回复也写得足够长以便撑爆预算' };
    }
  }

  const loop = new Loop(wire, tools, new ToolThenText(), { decide: async () => true }, { budget: 10 });
  const session = new Session(loop, wire, 10, 2);
  await session.ask('第一轮：请调用一次工具再回话');
  await session.ask('第二轮：继续');

  const history = (session as unknown as { history: Msg[] }).history;
  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== 'tool') continue;
    const prev = history.slice(0, i).reverse().find((m) => m.role === 'assistant' && m.toolCalls?.length);
    assert.ok(prev, `第 ${i} 条 tool 消息前面必须有带 tool_calls 的 assistant`);
  }
});

/* ── 预算与保留区（opt-32）── */

test('estimateText：中文按字计，不再当成四分之一个 token', () => {
  const cn = '锁的超时时间是三十秒'; // 10 个汉字
  const en = 'the lock ttl is thirty'; // 22 个字符
  assert.ok(estimateText(cn) >= 10, `10 个汉字至少 10 tok，实际 ${estimateText(cn)}`);
  assert.ok(
    estimateText(cn) > estimateText(en),
    `同样篇幅的中文该比英文贵：中文 ${estimateText(cn)} vs 英文 ${estimateText(en)}`,
  );
});

test('resolveBudget：默认按模型窗口的比例算，GB_BUDGET 走绝对值模式', () => {
  const llm: Llm = { complete: async () => ({ text: '' }), contextWindow: 1000 };
  const keys = ['GB_BUDGET', 'GB_COMPACT_RATIO', 'GB_RETAIN_RATIO'] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of keys) delete process.env[k];
    const ratio = resolveBudget(llm);
    assert.equal(ratio.budget, 800, '1000 × 0.8');
    assert.equal(ratio.retainTokens, 160, '1000 × 0.16');

    process.env.GB_BUDGET = '160';
    const abs = resolveBudget(llm);
    assert.equal(abs.budget, 160);
    assert.equal(abs.retainTokens, undefined, '绝对值模式退回按条数保留');

    // 调用方写死的预算优先级最高（评测脚本靠它固定变量）
    assert.equal(resolveBudget(llm, 42).budget, 42);

    delete process.env.GB_BUDGET;
    process.env.GB_RETAIN_RATIO = '0.9';
    assert.throws(() => resolveBudget(llm), /永远压不动/, '保留区比阈值还大就该在启动时拒绝');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('网关报上下文溢出时，压掉一段历史再原样重试一次', async () => {
  // 只溢出一次，第二次就正常应答
  class OverflowOnce implements Llm {
    mode: 'ok' | 'overflow' = 'ok';
    calls = 0;
    async complete(): Promise<LlmResponse> {
      this.calls++;
      if (this.mode === 'overflow') {
        this.mode = 'ok';
        return { text: '（HTTP 400: context_length_exceeded）', overflow: true };
      }
      return { text: '这是一段足够长的回复内容用于累积上下文长度' };
    }
  }

  const wire = new Wire();
  const llm = new OverflowOnce();
  // 预算给得很大：这样唯一可能触发压缩的原因就是溢出兜底
  const loop = new Loop(wire, new ToolRegistry(), llm, { decide: async () => true }, { budget: 100_000 });
  const session = new Session(loop, wire, 100_000, 2);
  let compacted = 0;
  wire.subscribe((e) => {
    if (e.type === 'context.compacted') compacted++;
  });

  await session.ask('第一轮，先攒一点历史出来');
  await session.ask('第二轮，继续攒');
  assert.equal(compacted, 0, '预算没超，不该有压缩');

  llm.mode = 'overflow';
  const history = await session.ask('第三轮，这次网关会说超窗口');

  assert.equal(compacted, 1, '溢出应该触发一次压缩');
  assert.equal(history.at(-1)?.content, '这是一段足够长的回复内容用于累积上下文长度');
  assert.ok(
    !history.some((m) => m.content.includes('context_length_exceeded')),
    '那句网关错误不该被当成模型的回答写进历史',
  );
});

test('压不动的时候不重试，把溢出如实抛出去', async () => {
  class AlwaysOverflow implements Llm {
    async complete(): Promise<LlmResponse> {
      return { text: '（HTTP 400: context_length_exceeded）', overflow: true };
    }
  }
  const wire = new Wire();
  const loop = new Loop(wire, new ToolRegistry(), new AlwaysOverflow(), { decide: async () => true }, {});
  const session = new Session(loop, wire, 100_000, 2);
  // 第一轮历史是空的，压无可压：应该直接抛，而不是静静地重试到死
  await assert.rejects(() => session.ask('上下文一上来就爆了'), /上下文超过模型窗口/);
});

test('给了 retainRatio 就按 token 选保留区，留下的比按条数保留更多', async () => {
  // 回复很短：按条数保留 2 条只剩十几个 token，按 token 保留会一直往前多留几条
  class ShortLlm implements Llm {
    async complete(): Promise<LlmResponse> {
      return { text: '好了' };
    }
  }
  const run = async (retainRatio?: number): Promise<number> => {
    const wire = new Wire();
    const loop = new Loop(wire, new ToolRegistry(), new ShortLlm(), { decide: async () => true }, { budget: 20 });
    const session = new Session(loop, wire, 20, 2, { retainRatio });
    for (const q of ['第一句', '第二句', '第三句', '第四句', '第五句']) await session.ask(q);
    return (session as unknown as { history: Msg[] }).history.length;
  };

  const byCount = await run();
  // 0.6 × 上限 20 = 12 tok 的保留区
  const byTokens = await run(0.6);
  assert.ok(
    byTokens > byCount,
    `按 token 保留应留下更多消息：token 模式 ${byTokens} 条 vs 条数模式 ${byCount} 条`,
  );
});

/* ── 注入配额分配（opt-36）── */

test('注入配额只往下收紧，不往上放宽', () => {
  const keys = ['GB_INJECT_RATIO', 'GB_MEM_TOKENS', 'GB_WIKI_TOKENS', 'GB_KB_TOKENS'] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of keys) delete process.env[k];

    // 窗口大：分下来远超上限，于是取上限——跟没有这套分配时一字不差
    const big = resolveInjectBudget(102400);
    assert.deepEqual({ memory: big.memory, wiki: big.wiki, kb: big.kb }, { memory: 40, wiki: 240, kb: 800 });

    // 窗口小：总额只有 800，按份额和剩余收紧
    const small = resolveInjectBudget(3200);
    assert.equal(small.memory, 40, '记忆份额 80 但上限 40，取 40');
    assert.equal(small.wiki, 200, '目录份额 200 小于上限 240，取 200');
    assert.equal(small.kb, 560, '资料库排最后，把前面省下的都拿走');
    assert.ok(small.memory + small.wiki + small.kb <= 800, '合起来不超总额');

    // 窗口极小：注入几乎归零，这是对的——真装不下
    const tiny = resolveInjectBudget(200);
    assert.ok(tiny.memory + tiny.wiki + tiny.kb <= 50);

    // 绝对值模式（演示）不按比例：否则预算被故意调小，注入会被压到装不下一块
    const demo = resolveInjectBudget(160, false);
    assert.deepEqual({ memory: demo.memory, wiki: demo.wiki, kb: demo.kb }, { memory: 40, wiki: 240, kb: 800 });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

/* ── token 计量对账（opt-35）── */
test('网关给了真实用量就跟自己的估算对账', async () => {
  class UsageLlm implements Llm {
    async complete(): Promise<LlmResponse> {
      return { text: '好了', usage: { prompt: 100, completion: 5, total: 105, cached: 60 } };
    }
  }
  const wire = new Wire();
  const loop = new Loop(wire, new ToolRegistry(), new UsageLlm(), { decide: async () => true }, { budget: 10_000 });
  const seen: { estimated: number; actual: number; drift: number; cached?: number }[] = [];
  wire.subscribe((e) => {
    if (e.type === 'token.estimate') seen.push({ estimated: e.estimated, actual: e.actual, drift: e.drift, cached: e.cached });
  });

  await loop.runTurn('这句话有几个 token');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].actual, 100);
  assert.ok(seen[0].estimated > 0, '估算值要跟着发出来，否则没法复算偏差');
  assert.equal(seen[0].drift, (seen[0].estimated - 100) / 100);
  assert.equal(seen[0].cached, 60, '缓存命中量要带上：长会话里它决定实际花多少钱');
});

test('网关不给用量就不发对账事件，不编数字', async () => {
  const wire = new Wire();
  const loop = new Loop(wire, new ToolRegistry(), new TextLlm(), { decide: async () => true }, { budget: 10_000 });
  let seen = 0;
  wire.subscribe((e) => {
    if (e.type === 'token.estimate') seen++;
  });

  await loop.runTurn('随便问一句');
  assert.equal(seen, 0);
});


test('预算算的是整个请求：系统开销 + 注入 + 对话，不再只算历史', async () => {  // 一个"很贵"的模型：系统提示加工具声明折算 100 tok
  class HeavyLlm implements Llm {
    overhead(): number {
      return 100;
    }
    async complete(): Promise<LlmResponse> {
      return { text: '好了' };
    }
  }
  // 每回合注入一大段（资料库/知识目录在真实跑里就是这个角色）
  const provider: ContextProvider = {
    name: 'bulky',
    provide: () => [{ source: 'bulky', content: '注'.repeat(50), tokensEst: 50 }],
  };

  const wire = new Wire();
  const compactor = new Compactor(wire, { keepRecent: 1 });
  const loop = new Loop(wire, new ToolRegistry(), new HeavyLlm(), { decide: async () => true }, {
    budget: 200,
    providers: [provider],
    compactor,
  });
  const session = new Session(loop, wire, 200, 1, { compactor });

  const usages: number[] = [];
  let compacted = 0;
  wire.subscribe((e) => {
    if (e.type === 'context.usage') usages.push(e.tokens);
    if (e.type === 'context.compacted') compacted++;
  });

  await session.ask('第一句');
  // 对话本身只有几个 token，但账上必须已经有 100 系统开销 + 50 多注入
  assert.ok(usages[0] > 150, `第一次过秤应含固定开销，实际只有 ${usages[0]} tok`);

  for (const q of ['第二句', '第三句', '第四句', '第五句', '第六句']) await session.ask(q);
  assert.ok(compacted > 0, '固定开销吃掉大半预算后，回合内应该压缩对话');
});

test('回合内压缩：工具结果撑爆预算时，发请求前就压掉', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  // 一次调用就吐一大段（read_file 读大文件就是这样）
  tools.register({
    name: 'dump',
    description: '吐一大段',
    cacheable: false,
    run: () => ({ ok: true, content: 'x'.repeat(2000) }),
  });

  // 连着调三次工具再收尾：光靠回合开始时压一次是不够的
  class ToolSpam implements Llm {
    private i = 0;
    async complete(): Promise<LlmResponse> {
      this.i++;
      return this.i <= 3
        ? { toolCalls: [{ id: `c${this.i}`, name: 'dump', args: { n: this.i } }] }
        : { text: '看完了' };
    }
  }

  const compactor = new Compactor(wire, { retainRatio: 0.3 });
  const loop = new Loop(wire, tools, new ToolSpam(), { decide: async () => true }, {
    budget: 200,
    compactor,
  });
  let compacted = 0;
  wire.subscribe((e) => {
    if (e.type === 'context.compacted') compacted++;
  });

  const convo = await loop.runTurn('把那一大段读三遍');
  assert.ok(compacted > 0, '回合内涨出来的工具结果应该在发请求前被压掉');
  // 压完仍然不能切出没有 assistant 配对的 tool 消息
  for (let i = 0; i < convo.length; i++) {
    if (convo[i].role !== 'tool') continue;
    const prev = convo.slice(0, i).reverse().find((m) => m.role === 'assistant' && m.toolCalls?.length);
    assert.ok(prev, `第 ${i} 条 tool 消息前面必须有带 tool_calls 的 assistant`);
  }
});

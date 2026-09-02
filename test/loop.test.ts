import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { Loop, type Llm } from '../src/engine/loop.ts';
import { FakeLlm } from '../src/llm/fakeLlm.ts';
import { echoTool } from '../src/tools/echo.ts';
import type { Tool, WireEvent, Approver, Msg, LlmResponse } from '../src/engine/types.ts';
import { partialOf } from '../src/engine/types.ts';

// 第一次回合请求返回工具调用，第二次返回文本，形成一个完整回合
class ToolThenText implements Llm {
  private i = 0;
  async complete(_messages: Msg[]): Promise<LlmResponse> {
    if (this.i++ === 0) return { toolCalls: [{ id: '1', name: 'w', args: {} }] };
    return { text: 'final' };
  }
}

const confirmTool: Tool = {
  name: 'w',
  description: '需要确认的工具',
  assess: () => ({ level: 'confirm', summary: '写点东西' }),
  run: () => ({ ok: true, content: 'done' }),
};

function setup(approver: Approver, tool: Tool = confirmTool) {
  const wire = new Wire();
  const tools = new ToolRegistry();
  tools.register(tool);
  const loop = new Loop(wire, tools, new ToolThenText(), approver);
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  return { wire, loop, events };
}

test('审批放行时工具执行', async () => {
  const { loop, events } = setup({ decide: async () => true });
  const msgs = await loop.runTurn('go');
  const result = events.find((e) => e.type === 'tool.result');
  assert.ok(result && result.type === 'tool.result' && result.result.content === 'done');
  assert.equal(msgs.at(-1)?.content, 'final');
  assert.ok(events.some((e) => e.type === 'approval.request'));
  assert.ok(events.some((e) => e.type === 'approval.decision' && e.approved === true));
});

test('本回合注入的上下文排在对话之后——前缀缓存的命门', async () => {
  // 记下模型实际收到的消息序列
  const seen: Msg[][] = [];
  const llm: Llm = {
    async complete(messages: Msg[]): Promise<LlmResponse> {
      seen.push(messages.map((m) => ({ ...m })));
      return { text: 'final' };
    },
  };
  const wire = new Wire();
  const tools = new ToolRegistry();
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, {
    providers: [
      {
        name: 'p',
        provide: () => [{ source: 'p', content: '【资料】这回合的注入', tokensEst: 5 }],
      },
    ],
  });
  // 两个回合：第二回合像 Session 那样把第一回合的对话传回来
  const history1 = await loop.runTurn('第一句');
  await loop.runTurn('第二句', history1);

  // 对话必须整个在前、注入在后：注入内容每回合都在变（技能命中、记忆检索都不同），
  // 放前面的话第二回合起整个对话前缀就和上一回合不同，缓存全失效
  for (const req of seen) {
    const lastConvo = [...req.keys()].reverse().find((i) => req[i]!.role !== 'system');
    const firstInject = req.findIndex((m) => m.role === 'system' && m.content.includes('【资料】'));
    assert.ok(firstInject >= 0, '注入内容要在请求里');
    assert.ok(lastConvo !== undefined && lastConvo < firstInject, '对话在前、注入在后');
  }
  // 第二回合的请求必须以完整的第一回合对话开头——这是缓存能命中的前提
  const second = seen[1]!;
  assert.equal(second[0]!.content, '第一句', '第二回合要以第一回合的对话开头');
  assert.equal(second.find((m) => m.content === '第二句') !== undefined, true);
});

test('审批拒绝时工具不执行，返回被拒结果', async () => {
  const { loop, events } = setup({ decide: async () => false });
  await loop.runTurn('go');
  const result = events.find((e) => e.type === 'tool.result');
  assert.ok(result && result.type === 'tool.result');
  assert.ok(result.type === 'tool.result' && result.result.ok === false);
  assert.ok(result.type === 'tool.result' && result.result.content.includes('拒绝'));
});

test('状态机经历 thinking/tool_call/tool_result/done', async () => {
  const { loop, events } = setup({ decide: async () => true });
  await loop.runTurn('go');
  const states = events.filter((e) => e.type === 'state.change').map((e) => (e.type === 'state.change' ? e.to : ''));
  for (const s of ['thinking', 'tool_call', 'tool_result', 'done']) {
    assert.ok(states.includes(s as never), `应出现状态 ${s}`);
  }
});

test('工具没声明 assess 时按 confirm 走审批，而不是静默放行', async () => {
  const silent: Tool = { name: 'w', description: '没声明风险', run: () => ({ ok: true, content: 'done' }) };
  const { loop, events } = setup({ decide: async () => false }, silent);
  await loop.runTurn('go');
  const ask = events.find((e) => e.type === 'approval.request');
  assert.ok(ask && ask.type === 'approval.request');
  assert.equal(ask.request.level, 'confirm');
  // 被拒 → 工具没跑
  const result = events.find((e) => e.type === 'tool.result');
  assert.ok(result?.type === 'tool.result' && result.result.ok === false);
});

test('deny 级别不问人：Approver 说 yes 也照样拦下', async () => {
  const denied: Tool = {
    name: 'w',
    description: '硬拒绝',
    assess: () => ({ level: 'deny', summary: '写 .git', reason: '不可写' }),
    run: () => ({ ok: true, content: 'done' }),
  };
  let asked = 0;
  const { loop, events } = setup(
    {
      decide: async () => {
        asked += 1;
        return true;
      },
    },
    denied,
  );
  await loop.runTurn('go');
  assert.equal(asked, 0);
  const d = events.find((e) => e.type === 'approval.decision');
  assert.ok(d?.type === 'approval.decision' && d.approved === false && d.decision === 'deny');
  const result = events.find((e) => e.type === 'tool.result');
  assert.ok(result?.type === 'tool.result' && result.result.ok === false);
  assert.match(result.type === 'tool.result' ? result.result.content : '', /不可写/);
});

test('审批请求带上参数，供记忆键与审计使用', async () => {
  const { loop, events } = setup({ decide: async () => true }, {
    name: 'w',
    description: 'x',
    assess: () => ({ level: 'confirm', summary: 's' }),
    run: () => ({ ok: true, content: 'done' }),
  });
  await loop.runTurn('go');
  const ask = events.find((e) => e.type === 'approval.request');
  assert.ok(ask?.type === 'approval.request' && ask.request.args !== undefined);
  assert.equal(ask.type === 'approval.request' ? ask.request.toolName : '', 'w');
});

// ── 中断：屏幕上出现过的半句必须留在历史里 ──────────────────────

test('partialOf 只认字符串 partial，别的一律当没有', () => {
  assert.equal(partialOf(Object.assign(new Error('用户中断'), { partial: '半句' })), '半句');
  assert.equal(partialOf(new Error('用户中断')), '');
  assert.equal(partialOf(Object.assign(new Error('x'), { partial: 42 })), '');
  assert.equal(partialOf(null), '');
  assert.equal(partialOf(undefined), '');
  assert.equal(partialOf('用户中断'), '');
});

test('中断时把已经吐出的半句写进历史，而不是只留一句「已中断」', async () => {
  // 屏幕上、llm.delta 里都有这半句；历史里要是没有，模型下一轮看不见自己说过什么，
  // 从日志重建的历史也和当时的屏幕对不上
  const ctrl = new AbortController();
  const llm: Llm = {
    async complete(_m, onToken) {
      onToken?.('我先读一下这个文件，');
      ctrl.abort();
      throw Object.assign(new Error('用户中断'), { partial: '我先读一下这个文件，' });
    },
  };
  const wire = new Wire();
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, new ToolRegistry(), llm, { decide: async () => true });

  const msgs = await loop.runTurn('看看 a.ts', [], ctrl.signal);
  const last = msgs.at(-1);
  assert.equal(last?.role, 'assistant');
  assert.match(String(last?.content), /^我先读一下这个文件，/);
  assert.match(String(last?.content), /中断/);
  assert.ok(events.some((e) => e.type === 'turn.aborted'));
});

test('中断时没吐出任何东西，历史里就只有那句「已中断」，不留空行', async () => {
  const ctrl = new AbortController();
  const llm: Llm = {
    async complete() {
      ctrl.abort();
      throw new Error('用户中断');
    },
  };
  const wire = new Wire();
  const loop = new Loop(wire, new ToolRegistry(), llm, { decide: async () => true });
  const msgs = await loop.runTurn('go', [], ctrl.signal);
  const content = String(msgs.at(-1)?.content);
  assert.ok(!content.startsWith('\n'));
  assert.match(content, /中断/);
});

// ── 回合级累计花费：步数拦"绕圈"，花费拦"每步很贵" ─────────────────────────

/** 每次请求都报固定用量，并且永远还要调工具——用来撞上限 */
class CostlyLlm implements Llm {
  calls = 0;
  // 不用构造器参数属性：类型擦除模式不支持（这个项目没有构建步骤）
  private readonly perCall: { prompt: number; completion: number };
  constructor(perCall: { prompt: number; completion: number }) {
    this.perCall = perCall;
  }
  async complete(): Promise<LlmResponse> {
    this.calls += 1;
    return {
      toolCalls: [{ id: `c${this.calls}`, name: 'echo', args: { text: 'x' } }],
      usage: { ...this.perCall, total: this.perCall.prompt + this.perCall.completion },
    };
  }
}

function costSetup(llm: Llm, turnTokenBudget?: number, tool = echoTool) {
  const wire = new Wire();
  const tools = new ToolRegistry();
  tools.register(tool);
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { turnTokenBudget });
  return { loop, events };
}

test('回合结束报累计花费，没设上限也报（先可见，再可控）', async () => {
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      return { text: 'done', usage: { prompt: 100, completion: 20, total: 120, cached: 60 } };
    },
  };
  const { loop, events } = costSetup(llm);

  await loop.runTurn('go');

  const cost = events.find((e) => e.type === 'turn.cost');
  assert.ok(cost && cost.type === 'turn.cost', '没设上限也该报花费');
  assert.equal(cost.prompt, 100);
  assert.equal(cost.completion, 20);
  assert.equal(cost.cached, 60);
  assert.equal(cost.requests, 1);
  assert.equal(cost.budget, 0, '0 表示不限');
});

test('累计花费按回合清零，不会把上一回合的算进来', async () => {
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      return { text: 'done', usage: { prompt: 100, completion: 20, total: 120 } };
    },
  };
  const { loop, events } = costSetup(llm);

  await loop.runTurn('一');
  await loop.runTurn('二');

  const costs = events.filter((e) => e.type === 'turn.cost');
  assert.equal(costs.length, 2);
  for (const c of costs) {
    assert.ok(c.type === 'turn.cost' && c.prompt === 100, '第二回合不该累加成 200');
  }
});

test('网关不报 usage 时不发花费事件（不编数字）', async () => {
  const { loop, events } = costSetup(new FakeLlm());
  await loop.runTurn('echo 你好');
  assert.equal(events.some((e) => e.type === 'turn.cost'), false);
});

test('累计花费撞上限就停手，并说清花了多少', async () => {
  // 每次 600，上限 1000：第 2 次累计 1200 撞线 -> 喂回"超预算"再给它一次收尾机会
  // -> 第 3 次它还要调工具，硬停。所以会超出上限一个请求的量，这是刻意的：
  // 一个没有任何回答的回合比多花一次请求更糟。超出量有硬上界（恰好一次）。
  const llm = new CostlyLlm({ prompt: 500, completion: 100 });
  const { loop, events } = costSetup(llm, 1000);

  const msgs = await loop.runTurn('go');

  const hit = events.find((e) => e.type === 'turn.budget');
  assert.ok(hit && hit.type === 'turn.budget', '要发 turn.budget，而不是混进 turn.limit');
  assert.equal(hit.budget, 1000);
  assert.equal(hit.spent, 1200, '撞线的那一刻');
  assert.equal(llm.calls, 3, '2 次撞线 + 1 次收尾机会，不多不少');
  // 兜底答复要带上实际花了多少——只说"被停了"用户没法判断该不该调大上限
  const last = String(msgs.at(-1)?.content);
  assert.match(last, /1800 tok/, '要报实际花费（含收尾那次），不是报上限');
  assert.match(last, /GB_TURN_TOKENS/);
  // 远远早于 20 步的默认上限就停了
  assert.equal(events.some((e) => e.type === 'turn.limit'), false, '这次不是步数用尽');
  // 花费事件要在收尾时报出最终总额
  const cost = events.find((e) => e.type === 'turn.cost');
  assert.ok(cost && cost.type === 'turn.cost' && cost.prompt + cost.completion === 1800);
});

test('花费上限不给 free 工具开后门——记账也要问模型，照样花钱', async () => {
  // free 工具不占步数（maxSteps 放它过），但每转一圈都要问一次模型，所以照样烧钱。
  // 如果花费上限也放它过，一个只会反复改计划的模型就能无限跑下去。
  const freeTool: Tool = { ...echoTool, name: 'note', free: true, assess: () => ({ level: 'safe', summary: '记账' }) };
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      return {
        toolCalls: [{ id: 'n', name: 'note', args: { text: 'x' } }],
        usage: { prompt: 500, completion: 100, total: 600 },
      };
    },
  };
  const { loop, events } = costSetup(llm, 1000, freeTool);

  const msgs = await loop.runTurn('go');

  assert.ok(events.some((e) => e.type === 'turn.budget'), 'free 工具也要被花费上限拦住');
  assert.match(String(msgs.at(-1)?.content), /超过上限 1000/);
});


test('有注入时 FakeLlm 一步收尾，不会反复重发同一个工具调用', async () => {
  // 这是前缀缓存那次改动（`[...convo, ...injected]`）踩出来的回归：
  // FakeLlm 原先用 messages.at(-1) 判断"上一步是工具结果"，而注入是 system 且排在最后，
  // 于是末条永远不是 tool，假模型每一步都重发 echo，直到撞上 maxSteps。
  // 这条测试专门盯住"注入存在"这个前提，否则不注入的用例永远发现不了。
  const wire = new Wire();
  const tools = new ToolRegistry();
  tools.register(echoTool);
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, tools, new FakeLlm(), { decide: async () => true }, {
    providers: [
      {
        name: 'mem',
        provide: () => [{ source: 'mem', content: '【记忆】上次也 echo 过', tokensEst: 5 }],
      },
    ],
  });

  const msgs = await loop.runTurn('echo 你好世界');

  const calls = events.filter((e) => e.type === 'tool.call');
  assert.equal(calls.length, 1, `echo 只该被调一次，实际 ${calls.length} 次`);
  assert.equal(msgs.at(-1)?.role, 'assistant');
  assert.match(String(msgs.at(-1)?.content), /你好世界/);
  // 撞上限时引擎会给这句兜底回复；出现它就说明又在打转了
  assert.doesNotMatch(String(msgs.at(-1)?.content), /步数上限/);
});

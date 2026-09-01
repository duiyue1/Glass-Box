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

// ── 零凭证那条路：注入排在对话之后，假模型仍要看得见自己刚调过工具 ──────────

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

import type { ActivityEntry, WireEvent, TurnState } from '../engine/types.ts';
import { formatEntry, formatSummary, type ActivitySummary } from '../activity/activity.ts';

/** 终端显示宽度：CJK / 全角 / emoji 算 2 格，其余算 1 格 */
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

function truncW(s: string, width: number): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > width - 1 && dispWidth(s) > width) {
      return out + '…';
    }
    w += cw;
    out += ch;
  }
  return out;
}

function padEndW(s: string, width: number): string {
  const w = dispWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

type ToolView = { name: string; args: string; status: 'running' | 'done' | 'denied'; result?: string };
type ApprovalView = { summary: string; level: string; decided: boolean; approved: boolean };
type ConvoView = { who: string; text: string };
type SubagentView = { task: string; toolsUsed: string[]; done: boolean };

const ALL_STATES: TurnState[] = ['idle', 'thinking', 'tool_call', 'tool_result', 'done'];

/**
 * Renderer：把 wire 事件流「翻译」成视图状态并渲染成分屏画面。
 * 左半屏 = 对话流；右半屏 = 玻璃盒（状态机 / 上下文 / Skills / 工具 / 子agent / 审批 / 事件流）。
 * 只消费事件，不碰引擎。
 */
export class Renderer {
  private readonly color: boolean;
  private readonly cols: number;

  private state: TurnState = 'idle';
  private plugins: string[] = [];
  private convo: ConvoView[] = [];
  private tools: ToolView[] = [];
  private approvals: ApprovalView[] = [];
  private timeline: string[] = [];

  private ctxTokens = 0;
  private ctxBudget = 0;
  private ctxMessages = 0;
  private compactions: string[] = [];
  /** 每次请求的 token 估算偏差，用来在面板上标出"这个数字有多不准" */
  private drifts: number[] = [];

  private skillsAvailable: string[] = [];
  private activatedSkills: string[] = [];
  private subagents: SubagentView[] = [];

  private memTotal = 0;
  private memInjected: { kind: string; text: string; score: number }[] = [];
  private memUsed = 0;
  private memBudget = 0;
  private memDropped = 0;

  private activity: ActivityEntry[] = [];
  private activitySummary: ActivitySummary = { created: 0, edited: 0, ran: 0, other: 0 };

  constructor(opts: { color: boolean; cols: number }) {
    this.color = opts.color;
    this.cols = opts.cols;
  }

  private dim(s: string): string {
    return this.color ? `\x1b[2m${s}\x1b[0m` : s;
  }
  private bold(s: string): string {
    return this.color ? `\x1b[1m${s}\x1b[0m` : s;
  }
  private inverse(s: string): string {
    return this.color ? `\x1b[7m${s}\x1b[0m` : `[${s}]`;
  }

  apply(ev: WireEvent): void {
    switch (ev.type) {
      case 'plugin.loaded':
        this.plugins.push(ev.name);
        break;
      case 'skill.available':
        this.skillsAvailable = ev.skills;
        break;
      case 'skill.loaded':
        // 目录模式下技能正文是靠工具取回来的，不再经过 context.injected，
        // 面板要认这条事件才看得见"哪个技能真的生效了"
        if (!this.activatedSkills.includes(ev.name)) this.activatedSkills.push(ev.name);
        this.timeline.push(`加载技能 ${ev.name}`);
        break;
      case 'turn.start':
        this.convo.push({ who: '你', text: ev.userText });
        this.timeline.push('回合开始');
        break;
      case 'context.injected':
        for (const c of ev.contributions) {
          if (c.source.startsWith('skill:')) {
            const name = c.source.slice('skill:'.length);
            if (!this.activatedSkills.includes(name)) this.activatedSkills.push(name);
          }
        }
        if (ev.contributions.length) this.timeline.push(`注入上下文 x${ev.contributions.length}`);
        break;
      case 'context.usage':
        this.ctxTokens = ev.tokens;
        this.ctxBudget = ev.budget;
        this.ctxMessages = ev.messages;
        break;
      case 'context.compacted':
        this.compactions.push(`丢弃 ${ev.droppedMessages} 条: ${ev.tokensBefore}→${ev.tokensAfter} tok`);
        this.timeline.push('上下文压缩');
        break;
      case 'context.pruned':
        this.compactions.push(`削工具输出 ${ev.prunedMessages} 条: 省 ${ev.charsRemoved} 字`);
        this.timeline.push('工具输出削减');
        break;
      case 'token.estimate':
        this.drifts.push(ev.drift);
        break;
      case 'state.change':
        this.state = ev.to;
        break;
      case 'llm.request':
        this.timeline.push(`→ 请求模型 (${ev.messages.length} 条)`);
        break;
      case 'llm.response':
        if (ev.response.toolCalls?.length) {
          this.timeline.push(`← 要调用: ${ev.response.toolCalls.map((c) => c.name).join(', ')}`);
        } else {
          this.timeline.push('← 文本回复');
          if (ev.response.text) this.convo.push({ who: 'AI', text: ev.response.text });
        }
        break;
      case 'tool.call':
        this.tools.push({ name: ev.call.name, args: JSON.stringify(ev.call.args), status: 'running' });
        this.convo.push({ who: 'AI', text: `[调用工具 ${ev.call.name}]` });
        break;
      case 'approval.request':
        this.approvals.push({ summary: ev.request.summary, level: ev.request.level, decided: false, approved: false });
        break;
      case 'approval.decision': {
        const a = [...this.approvals].reverse().find((x) => !x.decided);
        if (a) {
          a.decided = true;
          a.approved = ev.approved;
        }
        break;
      }
      case 'subagent.start':
        this.subagents.push({ task: ev.task, toolsUsed: [], done: false });
        this.timeline.push(`子agent 开始: ${ev.task}`);
        break;
      case 'subagent.end': {
        const s = [...this.subagents].reverse().find((x) => !x.done);
        if (s) {
          s.done = true;
          s.toolsUsed = ev.toolsUsed;
        }
        this.timeline.push('子agent 完成');
        break;
      }
      case 'memory.distilled':
        this.memTotal = ev.total;
        this.timeline.push(`记忆蒸馏 +${ev.atoms.length}`);
        break;
      case 'memory.loaded':
        this.memTotal = ev.count;
        if (ev.count > 0) this.timeline.push(`记忆载入 ${ev.count} 条历史`);
        break;
      case 'memory.injected':
        this.memInjected = ev.items;
        this.memUsed = ev.usedTokens;
        this.memBudget = ev.budget;
        this.memDropped = ev.dropped;
        if (ev.items.length) this.timeline.push(`记忆注入 x${ev.items.length}`);
        break;
      case 'tool.result': {
        const t = [...this.tools].reverse().find((x) => x.status === 'running');
        if (t) {
          t.status = ev.result.ok ? 'done' : 'denied';
          t.result = ev.result.content;
        }
        this.convo.push({ who: '工具', text: ev.result.content });
        break;
      }
      case 'activity.updated':
        this.activity = ev.entries;
        this.activitySummary = ev.summary;
        break;
      case 'web.request':
        this.timeline.push(
          `${ev.ok ? '🌐' : '✗'} ${ev.url.replace(/^https?:\/\//, '').slice(0, 40)} ${ev.ms}ms${ev.note ? ` (${ev.note})` : ''}`,
        );
        break;
      case 'turn.limit':
        this.timeline.push(`⚑ 步数用尽（${ev.maxSteps}）`);
        this.compactions.push(`步数上限 ${ev.maxSteps}，已要求收尾`);
        break;
      case 'turn.aborted':
        this.timeline.push(`✂ 回合被中断（已执行 ${ev.steps} 步）`);
        break;
      case 'turn.end':
        this.timeline.push('回合结束');
        break;
    }
  }

  frame(): string {
    const gap = ' │ ';
    const leftW = Math.floor((this.cols - dispWidth(gap)) / 2);
    const rightW = this.cols - dispWidth(gap) - leftW;

    const left = this.leftLines(leftW);
    const right = this.rightLines(rightW);
    const rows = Math.max(left.length, right.length);

    const out: string[] = [];
    out.push(this.bold(padEndW(' Glass-Box · 对话', leftW)) + gap + this.bold(padEndW('玻璃盒 · 内部状态', rightW)));
    out.push('─'.repeat(leftW) + gap + '─'.repeat(rightW));
    for (let i = 0; i < rows; i++) {
      out.push(padEndW(left[i] ?? '', leftW) + gap + padEndW(right[i] ?? '', rightW));
    }
    return out.join('\n');
  }

  private leftLines(w: number): string[] {
    return this.convo.map((m) => {
      const tag = m.who === '你' ? '你> ' : m.who === 'AI' ? 'AI> ' : '  ⟵ ';
      return truncW(tag + m.text.replace(/\n/g, ' '), w);
    });
  }

  private contextBar(w: number): string {
    const width = 12;
    const ratio = this.ctxBudget > 0 ? Math.min(1, this.ctxTokens / this.ctxBudget) : 0;
    const filled = Math.round(ratio * width);
    const bar = '█'.repeat(filled) + '·'.repeat(width - filled);
    // 这个 tok 数是估的，把最近的实测偏差标出来，免得被当成精确值
    const drift = this.drifts.length
      ? ` · 估算偏差 ${this.drifts.at(-1)! >= 0 ? '+' : ''}${(this.drifts.at(-1)! * 100).toFixed(0)}%`
      : '';
    return truncW(`  [${bar}] ${this.ctxTokens}/${this.ctxBudget} tok · ${this.ctxMessages} 条${drift}`, w - 2);
  }

  private rightLines(w: number): string[] {
    const lines: string[] = [];

    lines.push(this.bold('状态机'));
    lines.push('  ' + ALL_STATES.map((s) => (s === this.state ? this.inverse(s) : this.dim(s))).join(' '));
    lines.push('');

    lines.push(this.bold('活动轨迹'));
    lines.push(this.dim(truncW('  ' + formatSummary(this.activitySummary), w - 2)));
    for (const e of this.activity.slice(-6)) {
      lines.push(truncW(`  ${e.ok ? '·' : '✗'} ${formatEntry(e).replace(/^✗ /, '')}`, w - 2));
    }
    lines.push('');

    lines.push(this.bold('上下文预算'));
    lines.push(this.contextBar(w));
    for (const c of this.compactions.slice(-2)) lines.push(this.dim(truncW(`  ⚑ 压缩: ${c}`, w - 2)));
    lines.push('');

    lines.push(this.bold('Skills（★=本会话已激活）'));
    if (this.skillsAvailable.length === 0) lines.push('  (无)');
    for (const s of this.skillsAvailable) {
      const mark = this.activatedSkills.includes(s) ? '★' : '·';
      lines.push(truncW(`  ${mark} ${s}`, w - 2));
    }
    lines.push('');

    lines.push(this.bold(`记忆（L1 原子 ${this.memTotal} 条）`));
    if (this.memInjected.length === 0) {
      lines.push('  本回合未注入');
    } else {
      lines.push(this.dim(`  注入 ${this.memInjected.length} 条 · ${this.memUsed}/${this.memBudget} tok · 丢 ${this.memDropped}`));
      for (const i of this.memInjected) {
        lines.push(truncW(`  ◆ (${i.kind}·${i.score}) ${i.text}`, w - 2));
      }
    }
    lines.push('');

    lines.push(this.bold('工具调用'));
    if (this.tools.length === 0) lines.push('  (暂无)');
    for (const t of this.tools) {
      const mark = t.status === 'done' ? '✓' : t.status === 'denied' ? '✗' : '…';
      lines.push(truncW(`  ${mark} ${t.name}${t.args}`, w - 2));
      if (t.result) lines.push(this.dim(truncW(`      → ${t.result.replace(/\n/g, ' ')}`, w - 2)));
    }
    lines.push('');

    if (this.subagents.length > 0) {
      lines.push(this.bold('子 agent'));
      for (const s of this.subagents) {
        const mark = s.done ? '✓' : '…';
        lines.push(truncW(`  ${mark} "${s.task}"`, w - 2));
        if (s.done) lines.push(this.dim(truncW(`      用了: ${s.toolsUsed.join(', ') || '无'}`, w - 2)));
      }
      lines.push('');
    }

    lines.push(this.bold('审批队列'));
    if (this.approvals.length === 0) lines.push('  (无需审批)');
    for (const a of this.approvals) {
      const res = !a.decided ? '待决' : a.approved ? '放行' : '拒绝';
      lines.push(truncW(`  [${a.level}] ${a.summary} → ${res}`, w - 2));
    }
    lines.push('');

    lines.push(this.bold('事件流（最近）'));
    for (const e of this.timeline.slice(-8)) lines.push(this.dim(truncW('  · ' + e, w - 2)));

    return lines;
  }
}

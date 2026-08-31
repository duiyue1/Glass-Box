import fs from 'node:fs';
import path from 'node:path';

/**
 * 任务计划：一份"这件事分几步、现在做到哪一步"的清单，每回合注入上下文。
 *
 * 为什么需要：Loop 只有 `maxSteps` 一个刹车，那是**防失控**，不是**防跑偏**。
 * 长任务里模型常见的失败不是死循环，而是干到第 5 步忘了第 2 步答应过的事。
 * Claude Code 的 TodoWrite / Codex 的 plan tool 解决的都是这件事：
 * 把意图外化成一份可见、可核对的清单，每回合重新看见它。
 *
 * 三条刻意的设计：
 *
 * 1. **不强制。** 不要求模型必须先建计划才能干活——短任务建计划是纯浪费。
 *    没建计划就什么都不注入，零成本；建了就每回合看见。
 * 2. **机械约束由这里保证，不靠提示词求模型守规矩。** id 必须存在、
 *    同时只能有一个 doing、done 不能回退。违反就返回失败，让模型看到具体原因去改。
 * 3. **状态只增不减地记在磁盘上。** 每次成功变更追加一行 JSON，
 *    最后一行就是当前状态。事件流里也有 `plan.updated`，两边可以对账。
 *
 * 参数形状上有个硬约束：`ToolSchema` 只支持 string/number/boolean，**没有数组**。
 * 所以计划是"多行文本，一行一步"传进来的，而不是 items 数组。
 * 这反过来是好事——顺带把"一步一行、别写长篇"这个约束变成了参数格式本身。
 */

export type PlanStatus = 'pending' | 'doing' | 'done';

export interface PlanItem {
  /** 从 1 开始的序号。模型用它指认某一步，比让它复述文本可靠 */
  id: number;
  text: string;
  status: PlanStatus;
}

export interface PlanResult {
  ok: boolean;
  /** 给模型看的一句话：成功了变成什么样，失败了为什么 */
  message: string;
  items: PlanItem[];
  /** 有没有真的改动状态（同状态重复标记就是 false） */
  changed: boolean;
}

/** 步数上限：超过十几步的清单，模型自己都读不完，也说明任务该拆了 */
export const MAX_ITEMS = 12;
/** 单步文本上限：这是清单不是设计文档 */
export const MAX_TEXT = 80;

const MARK: Record<PlanStatus, string> = { pending: '○', doing: '▶', done: '✔' };

/** 去掉模型爱加的行首记号（"1." / "- " / "* " / "1、"），只留正文 */
function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*·]|\d+[.、)]|\(\d+\))\s*/, '').trim();
}

/** 多行文本 → 步骤文本数组。空行丢掉、重复文本丢掉、超长截断、超量截断 */
export function parseSteps(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of String(raw ?? '').split('\n')) {
    const text = stripBullet(line).slice(0, MAX_TEXT);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** 注入用的紧凑形式。没有计划就返回空串——不注入比注入一句"暂无计划"有用 */
export function formatPlan(items: readonly PlanItem[]): string {
  if (!items.length) return '';
  const done = items.filter((i) => i.status === 'done').length;
  const doing = items.find((i) => i.status === 'doing');
  const head = `【任务计划】${done}/${items.length} 完成${doing ? `，当前第 ${doing.id} 步` : ''}`;
  const lines = items.map((i) => `${i.id} ${MARK[i.status]} ${i.text}`);
  return [head, ...lines].join('\n');
}

export class PlanStore {
  private items: PlanItem[] = [];
  /** 追加日志的位置。不给就是纯内存（测试、评测用） */
  private logPath?: string;

  constructor(logPath?: string) {
    this.logPath = logPath;
  }

  list(): PlanItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  /** 从追加日志恢复：只认最后一行完整的记录，坏行跳过 */
  load(): void {
    if (this.logPath) this.loadFrom(this.logPath);
  }

  /**
   * 从**别的**计划日志恢复状态，可选只认某个时刻之前的记录。
   * 分叉用得上：从第 N 步岔出去，计划就该是那一刻的样子，
   * 而不是原会话后来又推进过的样子。
   */
  loadFrom(logPath: string, maxTs?: number): void {
    if (!fs.existsSync(logPath)) return;
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]) as { items?: PlanItem[]; ts?: number };
        if (!Array.isArray(rec.items)) continue;
        if (maxTs !== undefined && Number(rec.ts) > maxTs) continue;
        this.items = rec.items;
        return;
      } catch {
        // 坏行往前找一行：日志是追加的，写坏的只可能是最后那行
      }
    }
  }

  /** 换一个追加日志（分叉出新会话时用），并把当前状态落成新日志的第一行 */
  switchLog(logPath: string, op = 'fork'): void {
    this.logPath = logPath;
    if (this.items.length) this.persist(op);
  }

  /**
   * 建立或替换计划。
   * **文本完全相同的步骤会保留原状态**——重新规划不该把已经干完的活变回没干。
   */
  setSteps(raw: string): PlanResult {
    const texts = parseSteps(raw);
    if (!texts.length) {
      return { ok: false, message: '计划是空的：一行一步，至少给一步', items: this.list(), changed: false };
    }
    const oldStatus = new Map(this.items.map((i) => [i.text, i.status]));
    this.items = texts.map((text, idx) => ({ id: idx + 1, text, status: oldStatus.get(text) ?? 'pending' }));
    // 保留下来的状态里可能出现两个 doing（原来第 2 步在做，改完计划它和别的合并了）——
    // 机械保证只留第一个
    let seenDoing = false;
    for (const item of this.items) {
      if (item.status !== 'doing') continue;
      if (seenDoing) item.status = 'pending';
      seenDoing = true;
    }
    this.persist('steps');
    return { ok: true, message: `计划已更新，共 ${this.items.length} 步`, items: this.list(), changed: true };
  }

  /** 标记某一步的状态。约束在这里强制，不在提示词里求 */
  mark(id: number, status: 'doing' | 'done'): PlanResult {
    const item = this.items.find((i) => i.id === id);
    if (!item) {
      const ids = this.items.map((i) => i.id).join('/') || '（还没有计划）';
      return { ok: false, message: `没有第 ${id} 步。现有步骤：${ids}`, items: this.list(), changed: false };
    }
    if (item.status === status) {
      return { ok: true, message: `第 ${id} 步已经是这个状态了`, items: this.list(), changed: false };
    }
    if (item.status === 'done') {
      return { ok: false, message: `第 ${id} 步已完成，不能回退。要重做就用 steps 重新给一份计划`, items: this.list(), changed: false };
    }
    if (status === 'doing') {
      const busy = this.items.find((i) => i.status === 'doing');
      if (busy) {
        return {
          ok: false,
          message: `第 ${busy.id} 步还在进行中。一次只做一步：先把第 ${busy.id} 步标成 done`,
          items: this.list(),
          changed: false,
        };
      }
    }
    item.status = status;
    this.persist(status === 'done' ? 'done' : 'doing');
    return { ok: true, message: `第 ${id} 步 → ${status}`, items: this.list(), changed: true };
  }

  private persist(op: string): void {
    if (!this.logPath) return;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, `${JSON.stringify({ ts: Date.now(), op, items: this.items })}\n`);
    } catch {
      // 写不进去不该让工具调用失败：计划本身在内存里是好的
    }
  }
}

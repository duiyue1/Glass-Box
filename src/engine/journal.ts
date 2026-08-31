import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WireEvent } from './types.ts';
import type { Wire } from './wire.ts';

/**
 * Journal：会话日志。把 wire 上的每个事件按行追加进一个 .jsonl 文件。
 *
 * 只追加、不修改——这份文件就是「发生过什么」的唯一真相源。
 * 对话状态可以从它重建（见 rebuild.ts），所以「回放 / 恢复 / 分叉」都是免费得到的：
 * 和 git 能 checkout 任意 commit 是同一个道理——存不可变的历史，而不是当前状态。
 *
 * 每行形如 {"seq":12,"type":"tool.call",...}。seq 单调递增，
 * 回放到某一步、从某一步分叉，靠的都是它。
 */

export interface JournalRecord {
  seq: number;
  ev: WireEvent;
}

/** 会话 id：可读的时间戳 + 短随机后缀（同一分钟内多开也不会撞） */
export function newSessionId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `_${p(now.getHours())}${p(now.getMinutes())}`;
  return `s_${stamp}_${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * 会话 id 只允许字母数字和 - _。
 * 这条校验是安全边界：Web UI 会把用户点选的 id 发回来拼成文件路径，
 * 不挡住 `../../etc/passwd` 这类输入就等于开了任意文件读取。
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSafeSessionId(id: string): boolean {
  return SAFE_ID.test(id);
}

export function sessionFile(dir: string, sessionId: string): string {
  if (!isSafeSessionId(sessionId)) throw new Error(`非法的会话 id: ${sessionId}`);
  return path.join(dir, `${sessionId}.jsonl`);
}

/**
 * 「值得为它建一个会话文件」的事件。
 *
 * 进程一启动就会发一串初始化事件（session.started / plugin.loaded / skill.available /
 * memory.loaded / kb.loaded）。如果立刻落盘，每次起一下服务或 CLI 就多一个
 * 「一句话没说」的空会话，会话列表很快被垃圾淹掉。
 *
 * 所以默认懒创建：这些事件先攒在内存里，直到出现一个真实动作——
 * 你说了第一句话（turn.start）、导入了资料（kb.imported）、或者给会话起了名字
 * （session.renamed，说明你想留着它）——才把攒下的事件按原顺序一次写出去。
 */
export const MATERIALIZE_ON = new Set<string>(['turn.start', 'kb.imported', 'session.renamed']);

export class Journal {
  readonly sessionId: string;
  readonly path: string;
  private seq: number;
  /** 是否已经开始真正写盘 */
  private live: boolean;
  /** 还没落盘时攒着的记录（seq 已经分配好，落盘后顺序和编号都不变） */
  private buf: { seq: number; ev: WireEvent }[] = [];

  constructor(dir: string, sessionId = newSessionId(), startSeq = 0, opts: { lazy?: boolean } = {}) {
    this.sessionId = sessionId;
    this.path = sessionFile(dir, sessionId);
    this.seq = startSeq;
    this.live = !opts.lazy;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // 建不出目录就退化成「不落盘」，不影响本次运行
    }
  }

  /** 挂到事件总线上。返回取消订阅函数。 */
  attach(wire: Wire): () => void {
    return wire.subscribe((ev) => this.append(ev));
  }

  append(ev: WireEvent): void {
    this.seq++;
    const rec = { seq: this.seq, ev };
    if (!this.live) {
      this.buf.push(rec);
      if (!MATERIALIZE_ON.has(ev.type)) return;
      // 真实动作来了：把攒下的（含这一条）按原顺序补写出去
      this.live = true;
      const pending = this.buf;
      this.buf = [];
      for (const r of pending) this.write(r);
      return;
    }
    this.write(rec);
  }

  /** 这个会话还只在内存里（一句话没说，没建文件） */
  isPending(): boolean {
    return !this.live;
  }

  private write(rec: { seq: number; ev: WireEvent }): void {
    try {
      fs.appendFileSync(this.path, JSON.stringify({ seq: rec.seq, ...rec.ev }) + '\n');
    } catch {
      // 写失败不能把回合带崩：日志是观测手段，不是业务主链路
    }
  }

  currentSeq(): number {
    return this.seq;
  }
}

/**
 * 读回一个会话的事件。
 * - until 给定时只读到该 seq（含）为止，用于「回放到某一步 / 从某一步分叉」
 * - 坏行直接跳过：进程被 kill 时最后一行可能只写了一半，不该让整个会话打不开
 */
export function readEvents(dir: string, sessionId: string, until?: number): JournalRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile(dir, sessionId), 'utf8');
  } catch {
    return [];
  }
  const out: JournalRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: { seq?: number } & Record<string, unknown>;
    try {
      obj = JSON.parse(line) as { seq?: number } & Record<string, unknown>;
    } catch {
      continue; // 半行 / 损坏行
    }
    if (typeof obj.seq !== 'number' || typeof obj.type !== 'string') continue;
    if (until !== undefined && obj.seq > until) break;
    const { seq, ...rest } = obj;
    out.push({ seq, ev: rest as unknown as WireEvent });
  }
  return out;
}

/** 文件里最后一条记录的 seq（没有则 0）。resume 时用它接着往下编号。 */
export function lastSeq(dir: string, sessionId: string): number {
  const recs = readEvents(dir, sessionId);
  return recs.at(-1)?.seq ?? 0;
}

export interface SessionInfo {
  sessionId: string;
  path: string;
  events: number;
  bytes: number;
  startedAt?: number;
  /** 第一条 user 输入，用来在列表里认出这是哪次对话 */
  firstAsk?: string;
  /** 手动起的名字（最后一次改名生效）；没起过就没有 */
  title?: string;
  forkedFrom?: { sessionId: string; seq: number };
}

/** 会话名字长度上限：列表里显示得下，也免得往日志里塞整篇文章 */
export const MAX_TITLE = 80;

/**
 * 改名：往该会话的日志尾部追加一条 session.renamed。
 *
 * 不去改已有的行——日志的规则是只追加。「当前名字」= 最后一条改名事件，
 * 和 event sourcing 里其它状态一样从历史算出来。
 *
 * 注意：正在活动的那个会话不要走这里，要走 wire.emit，
 * 否则 Journal 内存里的 seq 计数和文件里的会各写各的、撞号。
 */
export function renameSession(dir: string, sessionId: string, title: string): boolean {
  const t = title.trim().slice(0, MAX_TITLE);
  if (!t) return false;
  if (!isSafeSessionId(sessionId)) return false;
  if (!fs.existsSync(sessionFile(dir, sessionId))) return false;
  new Journal(dir, sessionId, lastSeq(dir, sessionId)).append({
    type: 'session.renamed',
    sessionId,
    title: t,
    ts: Date.now(),
  });
  return true;
}

/**
 * 删除一个会话的日志文件。
 *
 * 这是唯一一个会真正丢历史的操作，所以：调用方必须先拦住「当前活动会话」，
 * 否则正在写的文件被删掉，后续事件会凭空重建出一个残缺的文件。
 * 图片 blob 不动——它们按内容寻址、可能被别的会话共用。
 */
export function deleteSession(dir: string, sessionId: string): boolean {
  if (!isSafeSessionId(sessionId)) return false;
  try {
    fs.unlinkSync(sessionFile(dir, sessionId));
    return true;
  } catch {
    return false;
  }
}

/** 列出目录下的所有会话，最近的排前面 */
export function listSessions(dir: string): SessionInfo[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const f of files) {
    const sessionId = f.replace(/\.jsonl$/, '');
    // 目录里可能混进别的 .jsonl（历史上就出过：计划日志曾经写成 <id>.plan.jsonl）。
    // 那种名字过不了 SAFE_ID，以前会让 sessionFile 抛错，整个 /sessions 接口连带 Web 服务一起挂。
    // 列目录是只读操作，遇到不认识的文件应该跳过，而不是把服务搞死。
    if (!isSafeSessionId(sessionId)) continue;
    const p = sessionFile(dir, sessionId);
    const recs = readEvents(dir, sessionId);
    const started = recs.find((r) => r.ev.type === 'session.started');
    const firstTurn = recs.find((r) => r.ev.type === 'turn.start');
    // 改名可以改多次，最后一条才是现在的名字
    const renamed = recs.filter((r) => r.ev.type === 'session.renamed').at(-1);
    out.push({
      sessionId,
      path: p,
      events: recs.length,
      bytes: (() => {
        try {
          return fs.statSync(p).size;
        } catch {
          return 0;
        }
      })(),
      startedAt: started?.ev.ts,
      firstAsk: firstTurn?.ev.type === 'turn.start' ? firstTurn.ev.userText : undefined,
      title: renamed?.ev.type === 'session.renamed' ? renamed.ev.title : undefined,
      forkedFrom: started?.ev.type === 'session.started' ? started.ev.forkedFrom : undefined,
    });
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

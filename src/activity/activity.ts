import type { ActivityEntry, ToolCall, ToolMeta, WireEvent } from '../engine/types.ts';
import { Wire } from '../engine/wire.ts';

export interface ActivitySummary {
  created: number;
  edited: number;
  ran: number;
  other: number;
}

const LABELS: Record<ActivityEntry['kind'], string> = {
  created: '创建',
  edited: '修改',
  ran: '执行',
  read: '读取',
  searched: '搜索',
  delegated: '委派',
  fetched: '抓取',
};

/** 没有 meta 的工具，按名字猜一个动作类型，保证轨迹不留白 */
const FALLBACK_KIND: Record<string, ActivityEntry['kind']> = {
  read_file: 'read',
  write_file: 'created',
  edit_file: 'edited',
  run_command: 'ran',
  grep: 'searched',
  glob: 'searched',
  web_search: 'searched',
  web_fetch: 'fetched',
  delegate: 'delegated',
};

/** 只保留文件名，路径太长会把面板挤爆 */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

function clip(s: string, max = 48): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/**
 * Activity：活动轨迹子系统。
 *
 * 它把散落在事件流里的工具调用，聚合成一份「这次干了什么」的清单：
 *   创建 activity.ts +120 / 修改 loop.ts +4 −1 / 执行 npm test
 * 外加一行汇总：创建 3 · 修改 6 · 执行 7。
 *
 * 实现上仍然是纯订阅者——只听 wire，不改引擎，不参与决策。
 * 判定动作类型靠工具自己上报的 meta（而不是解析 content 字符串）。
 */
export class Activity {
  private readonly wire: Wire;
  private readonly calls = new Map<string, ToolCall>();
  private readonly entries: ActivityEntry[] = [];

  constructor(wire: Wire) {
    this.wire = wire;
    this.wire.subscribe((ev: WireEvent) => this.onEvent(ev));
  }

  list(): readonly ActivityEntry[] {
    return this.entries;
  }

  summary(): ActivitySummary {
    // 文件类动作按「唯一文件数」统计（同一个文件改 3 次仍算改了 1 个文件），
    // 命令类按次数统计——这样汇总行读起来才符合直觉。
    const createdFiles = new Set<string>();
    const editedFiles = new Set<string>();
    let ran = 0;
    let other = 0;
    for (const e of this.entries) {
      if (e.kind === 'created') createdFiles.add(e.detail);
      else if (e.kind === 'edited') editedFiles.add(e.detail);
      else if (e.kind === 'ran') ran++;
      else other++;
    }
    // 同一个文件先创建后修改，只算创建
    for (const f of createdFiles) editedFiles.delete(f);
    return { created: createdFiles.size, edited: editedFiles.size, ran, other };
  }

  private onEvent(ev: WireEvent): void {
    if (ev.type === 'tool.call') {
      this.calls.set(ev.call.id, ev.call);
      return;
    }
    if (ev.type !== 'tool.result') return;

    const call = this.calls.get(ev.result.toolCallId);
    const entry = this.toEntry(call, ev.result.meta, ev.result.ok, ev.ts);
    if (!entry) return;
    this.entries.push(entry);
    this.wire.emit({
      type: 'activity.updated',
      entries: [...this.entries],
      summary: this.summary(),
      ts: Date.now(),
    });
  }

  private toEntry(
    call: ToolCall | undefined,
    meta: ToolMeta | undefined,
    ok: boolean,
    ts: number,
  ): ActivityEntry | null {
    const kind = meta?.action ?? (call ? FALLBACK_KIND[call.name] : undefined);
    if (!kind) return null; // echo 这类无实体动作不进轨迹

    const rawDetail =
      meta?.path ??
      meta?.url ??
      meta?.command ??
      String(call?.args.path ?? call?.args.command ?? call?.args.pattern ?? call?.args.query ?? call?.args.url ?? call?.args.task ?? call?.name ?? '');

    return {
      kind,
      label: LABELS[kind],
      detail: meta?.path || call?.args.path ? shortPath(rawDetail) : clip(rawDetail),
      added: meta?.added,
      removed: meta?.removed,
      ok,
      ts,
    };
  }
}

/** 把一条轨迹渲染成一行文本：`修改 loop.ts +4 −1` */
export function formatEntry(e: ActivityEntry): string {
  const head = `${e.ok ? '' : '✗ '}${e.label} ${e.detail}`;
  // 只有文件类动作用 +/− 表示行数；搜索/委派/读取用更贴切的量词，免得被误读成改了几行
  if (e.kind === 'created' || e.kind === 'edited') {
    const nums: string[] = [];
    if (e.added) nums.push(`+${e.added}`);
    if (e.removed) nums.push(`−${e.removed}`);
    return nums.length ? `${head} ${nums.join(' ')}` : head;
  }
  if (e.kind === 'read') return e.added ? `${head} ${e.added} 行` : head;
  if (e.kind === 'fetched') return e.added ? `${head} ${e.added}KB` : head;
  if (e.kind === 'searched') return `${head} 命中 ${e.added ?? 0}`;
  if (e.kind === 'delegated') return e.added ? `${head} ${e.added} 步` : head;
  return head;
}

/** 汇总行：`创建 3 · 修改 6 · 执行 7` */
export function formatSummary(s: ActivitySummary): string {
  const parts: string[] = [];
  if (s.created) parts.push(`创建 ${s.created}`);
  if (s.edited) parts.push(`修改 ${s.edited}`);
  if (s.ran) parts.push(`执行 ${s.ran}`);
  if (s.other) parts.push(`其它 ${s.other}`);
  return parts.length ? parts.join(' · ') : '暂无活动';
}

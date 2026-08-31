import { estimateText } from '../engine/tokens.ts';

/**
 * 资料库的分块器。
 *
 * 为什么不是「按字数硬切」：硬切会把表格切成半截、把代码块切断，检索命中后
 * 注入给模型的是残片，反而更糟。这里按 Markdown 的结构切：
 *   1. 按标题（H1-H6）划分区块，块不跨标题
 *   2. 代码块（``` / ~~~）和表格整体保留，绝不切断
 *   3. 每块记住标题路径（如「AI-Ku > 权限模型」），检索时能告诉人这段在讲什么
 *   4. 过短的块合并到相邻的上一块（碎片单独存不值当）
 *   5. 相邻正文块保留少量重叠，避免一句话正好被切在边界上
 */

/**
 * 块类型。
 * digest 不是从原文切出来的，而是导入后额外蒸馏出的「摘要 + 别名」块（见 kb/distill.ts）：
 * 它只参与检索打分、不直接注入正文。
 */
export type ChunkType = 'section' | 'table' | 'code_block' | 'digest';

export interface Chunk {
  index: number;
  /** 标题层级路径，如「AI-Ku 技术方案文档 > 9. 权限模型」 */
  headingPath: string;
  type: ChunkType;
  text: string;
  tokens: number;
}

export interface ChunkOptions {
  /** 单块最大 token（超了就换新块） */
  maxTokens?: number;
  /** 低于此值的块合并到上一块 */
  minTokens?: number;
  /** 相邻正文块之间的重叠 token */
  overlapTokens?: number;
}

type BlockKind = 'text' | 'table' | 'code';
type Block = { kind: 'heading'; level: number; title: string } | { kind: BlockKind; text: string };

/** 把 Markdown 拆成最小不可分割单元：标题 / 代码块 / 表格 / 段落 */
function splitBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let buf: string[] = [];
  let bufKind: 'text' | 'table' = 'text';

  const flush = (): void => {
    const text = buf.join('\n').trim();
    if (text) blocks.push({ kind: bufKind, text });
    buf = [];
    bufKind = 'text';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 代码围栏：从这里一路吃到闭合围栏，中间的 # 不当标题、| 不当表格
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flush();
      const marker = fence[1];
      const code = [line];
      i++;
      for (; i < lines.length; i++) {
        code.push(lines[i]);
        if (lines[i].trim().startsWith(marker)) break;
      }
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ kind: 'heading', level: h[1].length, title: h[2].trim() });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    const isTable = /^\s*\|.*\|\s*$/.test(line);
    if (isTable && bufKind !== 'table') {
      flush();
      bufKind = 'table';
    } else if (!isTable && bufKind === 'table') {
      flush();
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

interface Draft {
  headingPath: string;
  parts: { kind: BlockKind; text: string }[];
}

function draftText(d: Draft): string {
  return d.parts.map((p) => p.text).join('\n\n');
}

function draftTokens(d: Draft): number {
  return estimateText(draftText(d));
}

function draftType(d: Draft): ChunkType {
  if (d.parts.every((p) => p.kind === 'code')) return 'code_block';
  if (d.parts.every((p) => p.kind === 'table')) return 'table';
  return 'section';
}

/** 两个标题路径是否同源（相同，或一个是另一个的祖先） */
function related(a: string, b: string): boolean {
  return a === b || a.startsWith(b + ' > ') || b.startsWith(a + ' > ');
}

/** 取文本尾部约 n 个 token 的内容，尽量从空白处断开 */
function tail(text: string, tokens: number): string {
  const chars = tokens * 4;
  if (text.length <= chars) return text;
  const cutAt = text.length - chars;
  const sliced = text.slice(cutAt);
  const ws = sliced.search(/\s/);
  return (ws > 0 && ws < 40 ? sliced.slice(ws + 1) : sliced).trim();
}

export function chunkMarkdown(md: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? 512;
  const minTokens = opts.minTokens ?? 50;
  const overlapTokens = opts.overlapTokens ?? 30;

  const blocks = splitBlocks(md);
  const stack: string[] = [];
  const drafts: Draft[] = [];
  let cur: Draft | null = null;

  const flushCur = (): void => {
    if (cur && cur.parts.length) drafts.push(cur);
    cur = null;
  };

  for (const b of blocks) {
    if (b.kind === 'heading') {
      flushCur();
      // 进入新标题：砍掉更深的层级，再把自己放到对应层级上
      stack.length = Math.max(0, b.level - 1);
      stack[b.level - 1] = b.title;
      continue;
    }
    const headingPath = stack.filter(Boolean).join(' > ');
    if (!cur) cur = { headingPath, parts: [] };
    // 超预算就换块；但单个块自己就超了也不切，宁可留一个大块也不切断代码/表格
    if (cur.parts.length && draftTokens(cur) + estimateText(b.text) > maxTokens) {
      flushCur();
      cur = { headingPath, parts: [] };
    }
    cur.parts.push({ kind: b.kind, text: b.text });
  }
  flushCur();

  // 合并过短块：只并入同源标题路径的上一块，避免把不相干的两段粘在一起
  const merged: Draft[] = [];
  for (const d of drafts) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      draftTokens(d) < minTokens &&
      related(prev.headingPath, d.headingPath) &&
      draftTokens(prev) + draftTokens(d) <= maxTokens
    ) {
      prev.parts.push(...d.parts);
      continue;
    }
    merged.push(d);
  }

  // 加重叠：只给正文块加，代码块/表格保持原样（给它们加前缀反而破坏结构）
  const bases = merged.map((d) => ({ headingPath: d.headingPath, type: draftType(d), text: draftText(d) }));
  return bases.map((b, i) => {
    let text = b.text;
    const prev = bases[i - 1];
    if (overlapTokens > 0 && i > 0 && b.type === 'section' && prev.type === 'section') {
      const overlap = tail(prev.text, overlapTokens);
      if (overlap) text = overlap + '\n' + text;
    }
    return { index: i, headingPath: b.headingPath, type: b.type, text, tokens: estimateText(text) };
  });
}

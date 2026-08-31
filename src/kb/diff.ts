/**
 * 纯文本行级 diff（零依赖）。
 *
 * 用途：资料库已经有版本归档和回滚，但「回滚前先看清这一版改了什么」缺一块——
 * 之前只能把两个版本的全文各读一遍，自己肉眼比。
 *
 * 算法是标准的 LCS（最长公共子序列）动态规划，然后回溯出编辑脚本。
 * 资料是人写的文档，行数在几百量级，O(n·m) 的表格完全够用；
 * 超过上限就退化成「整体替换」，宁可显示得粗糙，也不要让面板卡死。
 */

export type DiffOp = 'same' | 'add' | 'del';

export interface DiffLine {
  op: DiffOp;
  /** 在旧版本里的行号（1 起，新增行没有） */
  oldNo?: number;
  /** 在新版本里的行号（1 起，删除行没有） */
  newNo?: number;
  text: string;
}

export interface DiffStat {
  added: number;
  removed: number;
  /** 超过规模上限、退化成整体替换 */
  truncated: boolean;
}

/** LCS 表格的规模上限（行数乘积）。1e6 ≈ 1000×1000 行，人写的文档到不了 */
const MAX_CELLS = 1_000_000;

function splitLines(text: string): string[] {
  // 末尾换行不算一行，否则每次 diff 都会多出一个空行差异
  const t = text.replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 逐行比较，返回可直接渲染的编辑脚本。
 * 同一处修改会表现为「先 del 再 add」——不合并成 change，因为合并之后
 * 行号对不上，面板上反而难看。
 */
export function lineDiff(oldText: string, newText: string): { lines: DiffLine[]; stat: DiffStat } {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length * b.length > MAX_CELLS) {
    const lines: DiffLine[] = [
      ...a.map((text, i) => ({ op: 'del' as const, oldNo: i + 1, text })),
      ...b.map((text, i) => ({ op: 'add' as const, newNo: i + 1, text })),
    ];
    return { lines, stat: { added: b.length, removed: a.length, truncated: true } };
  }

  // dp[i][j] = a[i..] 和 b[j..] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: 'same', oldNo: i + 1, newNo: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ op: 'del', oldNo: i + 1, text: a[i] });
      removed++;
      i++;
    } else {
      lines.push({ op: 'add', newNo: j + 1, text: b[j] });
      added++;
      j++;
    }
  }
  for (; i < a.length; i++) {
    lines.push({ op: 'del', oldNo: i + 1, text: a[i] });
    removed++;
  }
  for (; j < b.length; j++) {
    lines.push({ op: 'add', newNo: j + 1, text: b[j] });
    added++;
  }

  return { lines, stat: { added, removed, truncated: false } };
}

/**
 * 只保留有改动的地方 + 上下各 context 行，中间用一个 gap 标记代替。
 * 长文档全文展示没人看，看的是「改了哪几处」。
 */
export interface DiffHunkLine extends DiffLine {
  /** 这一项代表「中间省略了 n 行没变的内容」 */
  gap?: number;
}

export function collapseSame(lines: readonly DiffLine[], context = 2): DiffHunkLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op === 'same') continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  }
  const out: DiffHunkLine[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (skipped) {
        out.push({ op: 'same', text: '', gap: skipped });
        skipped = 0;
      }
      out.push(lines[i]);
    } else skipped++;
  }
  if (skipped) out.push({ op: 'same', text: '', gap: skipped });
  return out;
}

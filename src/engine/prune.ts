import type { Msg } from './types.ts';

/**
 * 削工具输出的字符预算。
 *
 * 用字符数而不是 token 作判据：这一级不调模型，要的就是确定性和便宜。
 * token 是估出来的，字符数是数出来的。
 */
export interface PruneConfig {
  /** 超过这么多字符才削 */
  thresholdChars: number;
  /** 留头多少字符 */
  headChars: number;
  /** 留尾多少字符 */
  tailChars: number;
}

/** 中间被削掉的地方留下的记号，`%d` 换成省掉的字符数 */
const MARKER = '\n\n[… 中间省略 %d 字，需要完整内容请重新调用该工具 …]\n\n';

/** 记号本身最长能有多长（省略字数最多 7 位数） */
const MARKER_MAX = MARKER.length + 7;

/**
 * 默认阈值：工具输出超过 2000 字才削。
 *
 * 比 dsh 的 8192 小得多，因为这个项目的工具输出通常几百到两千字
 * （`read_file` 一个源文件、`grep` 一批命中）。阈值定在真实分布的上沿，
 * 让"读回来一个大文件"这种情况被削，而正常大小的输出一个字不动。
 */
const DEFAULT_THRESHOLD = 2000;
/** 留头占「头尾可用空间」的比例：头部通常是文件开头、命令回显，信息密度最高 */
const HEAD_SHARE = 0.75;

/**
 * 解析削减配置。只暴露一个旋钮（阈值），头尾从「阈值减去记号占位」里按比例分——
 * 这样 `头 + 记号 + 尾 <= 阈值` 恒成立，削减才是幂等的：
 * 削过一次的文本长度已在阈值内，再跑不会二次削减、不会套两层记号。
 *
 * @param thresholdChars 超过多少字符才削，不给用默认值
 */
export function resolvePruneConfig(thresholdChars?: number): PruneConfig {
  // 阈值至少要装得下记号本身再加同样多的正文，否则削减没有意义
  const threshold = Math.max(MARKER_MAX * 2, Math.floor(thresholdChars ?? DEFAULT_THRESHOLD));
  const room = threshold - MARKER_MAX;
  const headChars = Math.floor(room * HEAD_SHARE);
  return {
    thresholdChars: threshold,
    headChars,
    tailChars: room - headChars,
  };
}

/**
 * 削一段文本的中间部分：留头 + 记号 + 留尾。
 *
 * 按 **Unicode 码点**切而不是按 UTF-16 长度，否则会把 emoji 之类的代理对切成两半，
 * 拼回去就是乱码。字形簇（比如带修饰符的表情）仍可能被切开，那个代价可以接受。
 *
 * @param text 原始文本
 * @param cfg 字符预算
 * @returns 削过的文本；本来就没超阈值时返回 `null`
 */
export function pruneText(text: string, cfg: PruneConfig): string | null {
  const points = Array.from(text);
  if (points.length <= cfg.thresholdChars) return null;

  const removed = points.length - cfg.headChars - cfg.tailChars;
  const marker = MARKER.replace('%d', String(removed));
  const out = points.slice(0, cfg.headChars).join('') + marker + points.slice(points.length - cfg.tailChars).join('');
  // 削完必须更短。头尾比例是固定的，所以这里只会在阈值被调到极小时才不成立
  return Array.from(out).length < points.length ? out : null;
}

export interface PruneResult {
  /** 削了几条消息 */
  pruned: number;
  /** 一共省掉多少字符 */
  charsRemoved: number;
}

/**
 * 把消息里过大的**工具输出**削掉中间部分（原地修改数组）。
 *
 * 只动 `tool` 消息：上下文里最肥的就是它（读回来的文件内容、命令输出），
 * 而且它最容易过期——模型需要完整内容时可以重新调一次工具，
 * 而用户说过的话和模型的结论丢了就找不回来。
 *
 * 这一级不丢任何消息、不调模型，所以它总该在摘要之前跑。
 *
 * 幂等：削过的文本长度已经在阈值以内，再跑一次不会二次削减、也不会嵌套记号。
 *
 * @param msgs 要处理的消息
 * @param cfg 字符预算
 */
export function pruneToolResults(msgs: Msg[], cfg: PruneConfig): PruneResult {
  let pruned = 0;
  let charsRemoved = 0;
  for (const msg of msgs) {
    if (msg.role !== 'tool') continue;
    const out = pruneText(msg.content, cfg);
    if (out === null) continue;
    charsRemoved += Array.from(msg.content).length - Array.from(out).length;
    msg.content = out;
    pruned++;
  }
  return { pruned, charsRemoved };
}

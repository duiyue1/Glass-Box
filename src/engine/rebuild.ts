import type { Msg } from './types.ts';
import type { BlobStore } from './blobs.ts';
import { restoreMsgs } from './redact.ts';
import type { JournalRecord } from './journal.ts';

/**
 * 从会话日志重建对话状态。
 *
 * 为什么能重建：`turn.end` 事件本来就带着该回合结束时的完整对话（`messages`）。
 * 所以取「目标 seq 之前最后一个 turn.end」就是那一刻的 Session.history。
 *
 * 注意两点：
 * - 事件里的图片是占位串（带 blob 引用），要用 BlobStore 还原成原始 data URL，
 *   否则恢复出来的会话喂给模型时图就没了。
 * - 如果最后一个回合没跑完（进程被 kill 在中途），重建结果是上一个**完整**回合的状态。
 *   这是对的：半个回合的对话喂回模型只会让它困惑。
 */
export function rebuildHistory(records: JournalRecord[], blobs?: BlobStore): Msg[] {
  let last: Msg[] | undefined;
  for (const r of records) {
    if (r.ev.type === 'turn.end') last = r.ev.messages;
  }
  if (!last) return [];
  return restoreMsgs(last, blobs);
}

/** 重建时顺带告诉调用方：恢复到了第几步、包含几个回合、那一刻是什么时间 */
export function rebuildInfo(records: JournalRecord[]): { turns: number; atSeq: number; atTs: number } {
  let turns = 0;
  let atSeq = 0;
  let atTs = 0;
  for (const r of records) {
    if (r.ev.type === 'turn.end') {
      turns++;
      atSeq = r.seq;
      atTs = r.ev.ts;
    }
  }
  return { turns, atSeq, atTs };
}

import type { Llm } from '../engine/loop.ts';
import { firstJson, verifyBody, type WikiPage } from './wiki.ts';

/**
 * 给条目补**摘要 + 别名**。
 *
 * 为什么要单独一步而不是在编译时一起写：编译阶段确实要求模型写 summary/aliases，
 * 但它时不时就是不写——opt-24 最后一轮 8 页里有 3 页两样全空（解析器的坑修完之后，
 * 剩下的是模型真没写）。而这两样正好是目录注入和检索命中的入口：
 * 摘要空着，这页在目录里就只剩一个 ref；别名空着，用户换个说法就召不回来。
 * 重新编译整页要重新生成正文（更贵、还可能把已经通过校验的正文换成没通过的），
 * 只补这两个字段是最小代价的修法。
 *
 * 一道机械闸：**摘要里的数字/标识符必须能在依据原文里找到**（复用 verifyBody）。
 * 别名**不校验**——别名的全部价值就在于它是原文里没有的说法
 * （"抢锁失败" vs 原文的"获取锁超时"），拿溯源去卡它等于把这个功能废掉。
 */

export interface SummaryDraft {
  summary: string;
  aliases: string[];
}

const SUMMARY_SYSTEM = [
  '给一个中文知识条目写检索用的元信息。你会看到条目正文。',
  '',
  '1. summary：一句话说清「这页回答的是什么问题」，不超过 50 字。',
  '   不要抄具体数字（数字在正文里，摘要是给人/模型判断要不要点开这页用的）。',
  '2. aliases：3~6 个**别人可能怎么问这件事**的说法——口语说法、同义词、常见错叫法。',
  '   要和标题不一样，短词为宜，不要写成整句问句，不要带标点。',
  '',
  '只输出 JSON：{"summary":"...","aliases":["...","...","..."]}',
].join('\n');

/** 清洗模型给的草稿：去空、去重、去掉与标题重复的别名、限长 */
export function normalizeDraft(raw: unknown, title: string): SummaryDraft | undefined {
  const o = raw as { summary?: unknown; aliases?: unknown } | undefined;
  const summary = typeof o?.summary === 'string' ? o.summary.replace(/\s+/g, ' ').trim() : '';
  if (!summary) return undefined;
  const seen = new Set<string>([title.trim()]);
  const aliases: string[] = [];
  for (const a of Array.isArray(o?.aliases) ? o.aliases : []) {
    const s = String(a).replace(/\s+/g, '').trim();
    if (!s || s.length > 20 || seen.has(s)) continue;
    seen.add(s);
    aliases.push(s);
    if (aliases.length >= 8) break;
  }
  return { summary: summary.slice(0, 80), aliases };
}

/**
 * 让模型给一页写摘要 + 别名。
 * @param sourceTexts 这页的依据原文块（用来卡摘要里的数字，不是给模型写作用的）
 */
export async function summarizePage(
  llm: Llm,
  page: Pick<WikiPage, 'ref' | 'title' | 'body'>,
  sourceTexts: readonly string[],
): Promise<SummaryDraft> {
  const out = await llm.complete([
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: [`【条目】${page.ref}`, `【标题】${page.title}`, '【正文】', page.body].join('\n') },
  ]);
  const draft = normalizeDraft(firstJson(out.text ?? ''), page.title);
  if (!draft) throw new Error(`模型没给出可用的摘要：${(out.text ?? '').replace(/\s+/g, ' ').slice(0, 80) || '（空输出）'}`);
  // 摘要按规则不该含数字；万一含了，就必须能在原文里找到。找不到 = 编的，这一页宁可空着
  const check = verifyBody(draft.summary, [page.title, ...sourceTexts]);
  if (!check.ok) throw new Error(`摘要里有原文找不到的字面：${check.missing.join('、')}`);
  return draft;
}

/** 哪些页需要补：没摘要，或别名不到 3 个（和质检里「可检索」维度同一口径） */
export function needsSummary(p: WikiPage): boolean {
  return !p.summary.trim() || p.aliases.length < 3;
}

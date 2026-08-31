import fs from 'node:fs';
import path from 'node:path';
import { KbStore, type KbBudget } from '../kb/store.ts';
import { buildQuery } from '../kb/query.ts';
import { countHits, turnsOf, pct, type CaseSet, type EvalCase } from './core.ts';

/**
 * 检索层评测（第 1 批的尺子）。
 *
 * 为什么要单独一把尺子：`npm run eval` 测的是端到端「答得对不对」，一次跑 12 分钟、
 * 要花模型调用、还带评分噪声。可检索质量的改动（digest 桥、阈值、perDoc、上文补全）
 * 只影响**注入了哪几段**这一件事——那就直接量这一件事：
 *
 *   召回：答案必须出现的关键词，有没有出现在这次注入的正文里？
 *
 * 关键词没被注入，模型再强也只能靠猜；关键词被注入了模型还答错，那是模型/提示词的问题，
 * 不是检索的问题。两件事分开量，才知道该改哪一边。
 *
 * 完全不调模型：确定性、秒级、可以反复跑着调参。
 *
 * 用法：
 *   npm run eval:kb                        # 当前参数
 *   npm run eval:kb -- --digest 0          # 关掉蒸馏桥做对照
 *   npm run eval:kb -- --ctx 0             # 关掉块级上下文做对照（不进语料、不注入）
 *   npm run eval:kb -- --ctxindex 1        # 让那句上下文也进 BM25 语料（默认不进）
 *   npm run eval:kb -- --items 4 --tokens 600   # 试别的预算
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const kbDir = arg('kb') ?? path.join('.glassbox', 'kb');
const setPath = arg('cases') ?? path.join('eval', 'kb-cases.json');
const set = JSON.parse(fs.readFileSync(setPath, 'utf8')) as CaseSet;
const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const cases = (only?.length ? set.cases.filter((c) => only.includes(c.id)) : set.cases).filter((c) => !c.negative);

const budget: KbBudget = {
  maxItems: Number(arg('items') ?? 6),
  maxTokens: Number(arg('tokens') ?? 800),
  perDoc: Number(arg('perdoc') ?? 3),
  minScoreRatio: Number(arg('ratio') ?? 0.3),
  withNeighbor: arg('neighbor') !== '0',
  digestBoost: Number(arg('digest') ?? 0.6),
};

const store = new KbStore(kbDir, {
  useContext: arg('ctx') !== '0',
  indexContext: arg('ctxindex') === '1',
});
store.load();
if (!store.docCount()) {
  console.error(`${kbDir} 里没有资料，先导入再测`);
  process.exit(1);
}

/**
 * 复刻 kbProvider 的查询构造：多轮用例要顺着前几轮的关键词往下传，
 * 否则「那它的续租周期呢」这种指代句在检索层根本无从下手。
 */
function searchLikeProvider(c: EvalCase) {
  let prev: string[] = [];
  let last = store.search('', budget);
  let query = '';
  for (const t of turnsOf(c)) {
    const q = buildQuery(t, prev);
    prev = q.keywords;
    query = q.query;
    last = store.search(q.query, budget);
  }
  return { res: last, query };
}

console.log(
  `检索层评测 · ${cases.length} 条正例 · ${store.docCount()} 篇 / ${store.chunkCount()} 块 / 已蒸馏 ${store.digestCount()} 篇 / 有上下文 ${store.contextCount()} 块`,
);
console.log(
  `预算: ${budget.maxItems} 条 · ${budget.maxTokens} tok · perDoc ${budget.perDoc} · ` +
    `阈值 ${budget.minScoreRatio} · 上文 ${budget.withNeighbor ? '开' : '关'} · 蒸馏桥 ${budget.digestBoost} · ` +
    `块上下文 ${arg('ctx') === '0' ? '关' : '开'}${arg('ctxindex') === '1' ? '（进语料）' : ''}\n`,
);
console.log('| 用例 | 维度 | 召回 | 缺的关键词 | 注入块 | 注入tok | 桥接 | 查询串 |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');

let fullRecall = 0;
let hitSum = 0;
let kwSum = 0;
const misses: string[] = [];

for (const c of cases) {
  const { res, query } = searchLikeProvider(c);
  const injected = res.items.map((i) => i.chunk.text).join('\n');
  const kw = c.expectKeywords ?? [];
  const hits = countHits(injected, kw);
  const missing = kw.filter((k) => countHits(injected, [k]) === 0);
  hitSum += hits;
  kwSum += kw.length;
  if (hits === kw.length) fullRecall++;
  else misses.push(c.id);
  console.log(
    `| ${c.id} | ${c.dimension} | ${hits}/${kw.length} | ${missing.join('、') || '—'} | ` +
      `${res.items.length} | ${res.usedTokens} | ${res.digestBridged ?? 0} | ${query.slice(0, 24)} |`,
  );
}

console.log('\n## 汇总\n');
console.log(`关键词召回率: ${pct(kwSum ? hitSum / kwSum : undefined)}（${hitSum}/${kwSum}）`);
console.log(`全召回用例: ${pct(cases.length ? fullRecall / cases.length : undefined)}（${fullRecall}/${cases.length}）`);
if (misses.length) console.log(`没能完全召回: ${misses.join(', ')}`);

/**
 * wiki 质检 CLI：`npm run kb:audit [--sample 3] [--model GLM-5.2]`
 *
 * 五个维度全部机械计算、不调模型，所以同一份 wiki 反复跑分数完全一样——
 * 这是趋势线有意义的前提（opt-22 量到端到端评判的抖动是 0.70/2，
 * 会抖的数字画成曲线只会误导人）。
 *
 * `--sample N` 才会调模型：抽 N 条条目评「写得好不好」，
 * 结果单独打印、**不并入综合分、不进趋势文件**。
 *
 * 每次跑都往 `.glassbox/kb/wiki/quality.jsonl` 追加一行趋势点。
 */
import { buildApp } from './app.ts';

const args = process.argv.slice(2);
const valueOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const model = valueOf('--model');
if (model) process.env.GLASSBOX_MODEL_NAME = model;
const sample = Number(valueOf('--sample') ?? 0) || 0;

const app = buildApp({ workspace: process.cwd() });
app.init();

if (!app.wiki.count()) {
  console.log('还没有 wiki 条目，先执行 npm run kb:wiki 生成。');
  process.exit(0);
}

const r = await app.auditWiki({ sample });
console.log(`\n综合分 ${r.score} / 100（${r.pages} 条条目）\n`);
for (const d of r.dims) {
  const bar = '█'.repeat(Math.round(d.score / 5)).padEnd(20, '·');
  console.log(`  ${d.label.padEnd(6)} ${String(d.score).padStart(5)}  ${bar}  权重 ${d.weight}`);
  console.log(`         ${d.detail}`);
  for (const issue of d.issues.slice(0, 5)) console.log(`         · ${issue}`);
  if (d.issues.length > 5) console.log(`         · …还有 ${d.issues.length - 5} 条`);
}
if (r.sample) {
  console.log(`\n模型抽检 ${r.sample.n} 条，均分 ${r.sample.avg}/2（会抖，不进综合分与趋势）`);
  for (const i of r.sample.items) console.log(`  ${i.score}/2  ${i.ref} — ${i.note}`);
  for (const f of r.sample.failed) console.log(`  ✗ ${f}`);
}
const history = app.wikiQuality(30);
if (history.length > 1) {
  const prev = history[history.length - 2];
  const diff = Math.round((r.score - prev.score) * 10) / 10;
  console.log(`\n上次 ${prev.score} → 这次 ${r.score}（${diff >= 0 ? '+' : ''}${diff}），30 天内共 ${history.length} 次质检`);
}
process.exit(0);

/**
 * wiki 生成 CLI：`npm run kb:wiki [文档标题或id] [--stale] [--summarize] [--model GLM-5.2]`
 *
 * 干什么：把导入的原文编译成 wiki 条目（`.glassbox/kb/wiki/**.md`）。
 * 每篇资料先由模型规划页面结构（并把原文块互斥分配给页面），再逐页编译，
 * 最后过一道**不调模型的溯源校验**：条目里的数字/标识符必须能在它引用的块里字面找到。
 *
 * `--stale` 只重建**已过期**的条目（原文重导入过、条目还在说旧话）。
 * 这是自愈的执行端：过期以前只有面板红点和质检扣分，得人一页页点重建。
 *
 * `--summarize` 是另一件事：不编译，只给**缺摘要 / 别名不足 3 个**的条目补这两个字段。
 * 编译时模型经常漏写它们，而它们正是目录注入和检索命中的入口。
 * 可以带一个 ref 只补一条：`npm run kb:wiki -- --summarize concept/分布式锁`
 *
 * 为什么是显式命令：要调模型、按页面数量花钱，不该塞进启动或导入路径。
 * 生成规则在 `.glassbox/kb/wiki/AGENTS.md`（首次运行从仓库模板复制），改它就改生成结果。
 */
import { buildApp } from './app.ts';

const args = process.argv.slice(2);
const valueOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const model = valueOf('--model');
// 和评测脚本一致：模型必须在 buildApp 之前定好（pickLlm 在构造时就读环境变量）
if (model) process.env.GLASSBOX_MODEL_NAME = model;

const target = args.find((a) => !a.startsWith('--') && a !== model);

const app = buildApp({ workspace: process.cwd() });
app.init();

if (!app.kb.docCount()) {
  console.log('资料库是空的，先在面板上导入资料再生成 wiki。');
  process.exit(0);
}

// --summarize：只补摘要/别名，不重新编译正文
if (args.includes('--summarize')) {
  if (!app.wiki.count()) {
    console.log('还没有条目，先跑一次 npm run kb:wiki 生成。');
    process.exit(0);
  }
  const ref = target?.includes('/') ? target : undefined;
  console.log(ref ? `补 ${ref} 的摘要与别名…` : '给缺摘要 / 别名不足 3 个的条目补齐…');
  const s = await app.summarizeWiki(ref);
  for (const d of s.done) console.log(`  ✓ ${d.ref}（别名 ${d.aliases} 个）`);
  for (const f of s.failed) console.log(`  ✗ ${f}`);
  console.log(`完成：补齐 ${s.done.length} 条，失败 ${s.failed.length} 条`);
  process.exit(0);
}

// --stale：只重建依据原文已改动的条目
const staleOnly = args.includes('--stale');
if (staleOnly) {
  const n = app.staleWikiCount();
  if (!n) {
    console.log('没有过期条目，不用重建。');
    process.exit(0);
  }
  console.log(`有 ${n} 条条目的依据原文已改动，只重建这些…`);
}

if (!staleOnly) {
  console.log(`开始编译 wiki${target ? `（只处理《${target}》）` : `（${app.kb.docCount()} 篇资料）`}…`);
}
const r = await app.buildWiki(target, { staleOnly });
for (const p of r.pages) console.log(`  ${p.verified ? '✓' : '⚠'} ${p.ref}${p.verified ? '' : '（未通过溯源校验）'}`);
for (const f of r.failed) console.log(`  ✗ ${f}`);
console.log(
  `完成：${r.pages.length} 条条目，其中 ${r.unverified} 条未通过校验；目录写在 .glassbox/kb/wiki/index.md`,
);
process.exit(0);

/**
 * 块级上下文 CLI：`npm run kb:ctx [文档标题或id] [--model GLM-5.2]`
 *
 * 干什么：给每一块补一句「这段在讲什么」+ 一个状态（现行 / 已否决 / 历史 / 混合 / 未知）。
 * 一句话进 BM25 语料（同义问法靠它对上），状态在注入时标出来
 * （不然被否决方案里的数字和现行约定长得一模一样）。
 *
 * 一篇资料一次模型调用——不是每块一次。因为「这段属于被否决的方案」这个信息
 * 只存在于全文里，单看一块判断不出来。
 *
 * 为什么是显式命令：要调模型。重新导入 / reindex 会重建分块，上下文随之失效，
 * 需要再跑一次（`needsContext()` 会把这些文档列出来）。
 */
import { buildApp } from './app.ts';

const args = process.argv.slice(2);
const valueOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const model = valueOf('--model');
// 和其它 CLI 一致：模型必须在 buildApp 之前定好（pickLlm 在构造时就读环境变量）
if (model) process.env.GLASSBOX_MODEL_NAME = model;
// 这个命令就是来写上下文的，别被对照组开关关掉
delete process.env.GB_KB_CTX;

const target = args.find((a) => !a.startsWith('--') && a !== model);

const app = buildApp({ workspace: process.cwd() });
app.init();

if (!app.kb.docCount()) {
  console.log('资料库是空的，先导入资料。');
  process.exit(0);
}

const pending = app.kb.needsContext();
if (!target && !pending.length) {
  console.log(`所有块都有上下文了（共 ${app.kb.contextCount()} 块）。想重做某一篇就带上标题。`);
  process.exit(0);
}

console.log(target ? `处理《${target}》…` : `处理 ${pending.length} 篇还有块没补的资料…`);
const r = await app.contextualize(target);
for (const d of r.done) {
  const notes = [
    d.rejected ? `${d.rejected} 块的上下文因为编了数字被丢掉` : '',
    d.missing ? `${d.missing} 块模型没给` : '',
  ].filter(Boolean);
  console.log(`  ✓ ${d.title}：补上 ${d.chunks} 块${notes.length ? `（${notes.join('；')}）` : ''}`);
}
for (const f of r.failed) console.log(`  ✗ ${f}`);
console.log(`完成：全库 ${app.kb.contextCount()} / ${app.kb.chunkCount()} 块有上下文`);
process.exit(0);

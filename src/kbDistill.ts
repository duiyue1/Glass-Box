/**
 * 资料蒸馏 CLI：`npm run kb:distill [-- 文档标题或id] [--all] [--model GLM-5.2]`
 *
 * 干什么：给资料库里的每篇文档生成一段「摘要 + 别名」，存成一个只参与检索打分、
 * 永不注入的 digest 块（细节见 src/kb/distill.ts）。
 *
 * 为什么要单独一个入口：蒸馏要调模型、要花钱花时间，不该塞进 kb.load() 的启动路径里。
 * 导入资料时也不做——用户可能连着导十篇，等十次模型调用体验很差。
 * 所以做成显式动作：导完资料再蒸一次，或者面板上点一下（POST /kb/distill）。
 *
 * 默认只处理「还没蒸过」的；重新导入过的文档 digest 会被丢掉，所以也会被算成没蒸过。
 * --all 强制重蒸全部（改了蒸馏 prompt 之后用）。
 */
import { buildApp } from './app.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const valueOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const model = valueOf('--model');
// 和评测脚本一致：模型必须在 buildApp 之前定好，因为 pickLlm() 在建 app 时就读了环境变量
if (model) process.env.GLASSBOX_MODEL_NAME = model;

const target = args.find((a) => !a.startsWith('--') && a !== model);
const all = flag('--all');

const app = buildApp({ workspace: process.cwd() });
app.init();

const pending = app.kb.needsDigest();
const list = target ? [target] : all ? app.kb.list().filter((d) => d.status === 'active').map((d) => d.id) : pending.map((d) => d.id);

if (!list.length) {
  console.log(`没有需要蒸馏的资料（共 ${app.kb.docCount()} 篇，已蒸馏 ${app.kb.digestCount()} 篇）。想重蒸全部加 --all`);
  process.exit(0);
}

console.log(`准备蒸馏 ${list.length} 篇资料…`);
let ok = 0;
for (const id of list) {
  const r = await app.distill(id);
  for (const d of r.done) {
    ok++;
    console.log(`  ✓ ${d.title}（${d.aliases} 个别名）`);
  }
  for (const f of r.failed) console.log(`  ✗ ${f}`);
}
console.log(`完成：${ok}/${list.length} 篇。当前已蒸馏 ${app.kb.digestCount()} 篇。`);
process.exit(0);

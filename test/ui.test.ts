import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * Web 面板是一份手写的 ui.html，里面的内联脚本既不过 tsc 也不过 node --test，
 * 于是漏一个花括号就能让整页 JS 变成语法错误——表现是「所有按钮都点不动」，
 * 而单测和 typecheck 全绿。这一组测试就是补这个洞。
 */

const UI = path.join(import.meta.dirname, '..', 'src', 'web', 'ui.html');
const html = fs.readFileSync(UI, 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';

test('ui.html 里的内联脚本必须能通过语法检查', () => {
  assert.ok(script.trim().length > 1000, '没抽到脚本，说明 ui.html 结构变了');
  // 编译但不执行：语法错就在这里抛
  assert.doesNotThrow(() => new vm.Script(script), '内联脚本有语法错误，整页 JS 都不会跑');
});

test('脚本里 $(\'#id\') 引用的元素都必须在 HTML 里存在', () => {
  const ids = new Set<string>();
  for (const m of script.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]);
  assert.ok(ids.size > 10, '没扫到 id 引用，正则该更新了');
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `这些 id 在 HTML 里不存在，运行时会 null.xxx 抛错: ${missing.join(', ')}`);
});

test('HTML 关键标签成对（section/aside/main/footer/div）', () => {
  for (const tag of ['section', 'aside', 'main', 'footer', 'div']) {
    const open = (html.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    assert.equal(open, close, `<${tag}> 开合不配平：${open} vs ${close}`);
  }
});

test('带 hidden 的元素不能被作者样式的 display 盖掉', () => {
  // #chat 自带 display:flex，曾经把 hidden 属性顶掉，导致切页时对话区不消失、
  // 把别的页挤进右边窄列。这条规则是那次事故的看门人。
  assert.match(html, /\[hidden\]\{display:none !important\}/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry, normalizeDesc, renderSkillContent } from '../src/skills/registry.ts';
import { skillProvider } from '../src/skills/provider.ts';
import { skillPlugin } from '../src/plugins/skillPlugin.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { Wire } from '../src/engine/wire.ts';
import { hasSkillTool, systemPrompt } from '../src/llm/realLlm.ts';
import type { Tool, WireEvent, ToolOutput } from '../src/engine/types.ts';

const skillsDir = path.join(import.meta.dirname, '..', 'skills');

/** 造一个只有两个技能的临时目录：断言不跟着 skills/ 下真实内容一起变 */
function tempSkills(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-skills-'));
  fs.writeFileSync(
    path.join(dir, 'alpha.md'),
    ['---', 'name: alpha', 'description: 阿尔法的用途', 'triggers: 阿尔法, alpha', '---', '第一行', '第二行'].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'beta.md'),
    ['---', 'name: beta', `description: ${'很'.repeat(80)}长`, '---', 'B 正文'].join('\n'),
  );
  return dir;
}

function loaded(dir: string): SkillRegistry {
  const reg = new SkillRegistry(dir);
  reg.load();
  return reg;
}

test('加载 skills 目录', () => {
  const reg = loaded(skillsDir);
  assert.ok(reg.list().length >= 2);
});

test('触发词命中中文与英文', () => {
  const reg = loaded(skillsDir);
  assert.ok(reg.match('帮我写 commit').some((s) => s.name === 'git-commit'));
  assert.ok(reg.match('帮我做代码审查').some((s) => s.name === 'code-review'));
  assert.ok(reg.match('cr 一下这段代码').some((s) => s.name === 'code-review'));
});

test('技能文件是 CRLF 换行也照样解析（否则 Windows 上整个 Skills 失效）', () => {
  // `---\r\n` 匹配不上 `^---\n`，frontmatter 会被当成不存在，于是技能全部退化成
  // name='unnamed' / description='' / triggers=[]——不是少认一个技能，是整个能力没了。
  // git 在 Windows 上默认 autocrlf=true，一 checkout 就是 CRLF，所以这是那边的常态。
  // 这条在任何平台都跑：直接写一份 CRLF 文件，不依赖 Windows。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-skills-crlf-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'gamma.md'),
      ['---', 'name: gamma', 'description: 伽马的用途', 'triggers: 伽马, gamma', '---', '正文一', '正文二'].join('\r\n'),
    );
    const reg = loaded(dir);
    const one = reg.list()[0];
    assert.equal(one?.name, 'gamma', 'frontmatter 没解析出来时这里会是 unnamed');
    assert.equal(one?.description, '伽马的用途');
    assert.deepEqual(one?.triggers, ['伽马', 'gamma'], '触发词不能带上残留的 \\r');
    assert.ok(reg.match('帮我跑一下 gamma').some((s) => s.name === 'gamma'));
    assert.equal(reg.get('gamma')?.body, '正文一\n正文二', '正文里也不该残留 \\r');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('短英文触发词按词边界匹配，避免误命中（cr 不命中 script）', () => {
  const reg = loaded(skillsDir);
  assert.equal(reg.match('我喜欢用 TypeScript').length, 0);
});

test('load() 只留元信息，正文由 get() 按需读盘', () => {
  const dir = tempSkills();
  const reg = loaded(dir);
  // 元信息里没有 body 这个字段——渐进式加载的前提就是它不在内存里
  assert.equal(Object.hasOwn(reg.list()[0], 'body'), false);
  assert.equal(reg.get('alpha')?.body, '第一行\n第二行');

  // 正文不缓存：会话中途改了文件，下一次 get 就是新的
  fs.writeFileSync(path.join(dir, 'alpha.md'), ['---', 'name: alpha', 'description: 改过了', '---', '新正文'].join('\n'));
  assert.equal(reg.get('alpha')?.body, '新正文');
  assert.equal(reg.get('不存在的技能'), undefined);
});

test('目录只有名字和截断后的描述', () => {
  const reg = loaded(tempSkills());
  const catalog = reg.catalog(20);
  assert.match(catalog, /- `alpha`: 阿尔法的用途/);
  assert.equal(catalog.includes('第一行'), false, '目录里绝不能出现正文');
  const betaLine = catalog.split('\n').find((l) => l.startsWith('- `beta`'))!;
  assert.ok(betaLine.endsWith('…'), '超长描述要截断');
  assert.equal(normalizeDesc('a\n b  c', 500), 'a b c', '描述压成一行');
  assert.equal(normalizeDesc('abcdef', 3).length, 3, '下限 3：给省略号留位');
});

test('正文超过 token 上限就截断，并告诉模型全文在哪个文件', () => {
  const dir = tempSkills();
  fs.writeFileSync(
    path.join(dir, 'alpha.md'),
    ['---', 'name: alpha', 'description: d', '---', ...Array.from({ length: 200 }, (_, i) => `第 ${i} 行有一些内容`)].join('\n'),
  );
  const reg = loaded(dir);
  const full = reg.get('alpha');
  assert.equal(full?.truncated, false, '不给上限就不截');

  const clipped = reg.get('alpha', 120)!;
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.body.includes('read_file'), '要给出取全文的办法');
  assert.ok(clipped.body.includes(path.join(dir, 'alpha.md')));
  assert.ok(clipped.tokensEst < full!.tokensEst);
});

test('用户 /名字 手势：精确名字才算，触发词不算', () => {
  const reg = loaded(tempSkills());
  assert.deepEqual(reg.gestures('先 /alpha 一下').map((s) => s.name), ['alpha']);
  assert.deepEqual(reg.gestures('用 /Alpha，谢谢').map((s) => s.name), ['alpha'], '大小写和尾随标点都要容忍');
  assert.deepEqual(reg.gestures('alpha 怎么用'), [], '没有斜杠就不是点名');
  assert.deepEqual(reg.gestures('看 src/alpha/x.ts'), [], '路径里的斜杠不算点名');
  assert.deepEqual(reg.gestures('/nope'), []);
});

test('渲染成 <skill_content>：两条加载路径共用同一种形状', () => {
  const dir = tempSkills();
  const text = renderSkillContent(loaded(dir).get('alpha')!);
  assert.match(text, /^<skill_content name="alpha">/);
  assert.ok(text.includes('<skill_instructions>\n第一行\n第二行\n</skill_instructions>'));
  assert.ok(text.includes(dir), '资源指引要给基准目录');
  assert.ok(text.includes('不要预读'), '资源是指引不是附件');
});

test('目录模式：普通提问什么都不注入，点名才内联正文', () => {
  const reg = loaded(tempSkills());
  const wire = new Wire();
  const seen: WireEvent[] = [];
  wire.subscribe((e) => seen.push(e));
  const provider = skillProvider(reg, { mode: 'catalog', wire, maxTokens: 500 });

  // 触发词命中也不注入——该由模型看着目录自己决定要不要加载
  assert.deepEqual(provider.provide('帮我用 alpha 阿尔法 做点事'), []);
  assert.equal(seen.length, 0);

  const got = provider.provide('/alpha 走一遍') as { source: string; content: string }[];
  assert.deepEqual(got.map((c) => c.source), ['skill:alpha']);
  assert.match(got[0].content, /<skill_content/);
  assert.deepEqual(
    seen.filter((e) => e.type === 'skill.loaded').map((e) => (e as { name: string; via: string }).via),
    ['gesture'],
  );
});

test('inject 模式（对照组）：触发词命中就注入整篇正文', () => {
  const reg = loaded(tempSkills());
  const wire = new Wire();
  const seen: WireEvent[] = [];
  wire.subscribe((e) => seen.push(e));
  const got = skillProvider(reg, { mode: 'inject', wire }).provide('阿尔法怎么用') as { content: string }[];
  assert.equal(got.length, 1);
  assert.ok(got[0].content.includes('第一行'), '旧行为是把正文整篇塞进去');
  assert.equal((seen.find((e) => e.type === 'skill.loaded') as { via: string }).via, 'trigger');
});

/** 装一个 skill 工具出来 */
function skillTool(dir: string) {
  const tools = new ToolRegistry();
  const wire = new Wire();
  const seen: WireEvent[] = [];
  wire.subscribe((e) => seen.push(e));
  skillPlugin(loaded(dir), { maxTokens: 500 }).setup({ tools, wire, workspace: dir });
  return { tool: tools.get('skill') as Tool | undefined, seen };
}

test('skill 工具：目录进 description，可选值用 enum 钉死', () => {
  const { tool } = skillTool(tempSkills());
  assert.ok(tool);
  assert.match(tool!.description, /- `alpha`: 阿尔法的用途/);
  assert.deepEqual(tool!.parameters?.properties.name.enum, ['alpha', 'beta']);
  assert.equal(tool!.free, true, '加载指令不该占掉干活的步数');
  assert.equal(tool!.cacheable, true);
  assert.equal(tool!.assess?.({})?.level, 'safe', '只读本地文件，没有审批的必要（但要显式声明）');
});

test('skill 工具：加载成功发事件，名字不对如实报错', async () => {
  const { tool, seen } = skillTool(tempSkills());
  const ok = (await tool!.run({ name: 'alpha' })) as ToolOutput;
  assert.equal(ok.ok, true);
  assert.match(ok.content, /<skill_instructions>/);
  const ev = seen.find((e) => e.type === 'skill.loaded') as { name: string; via: string; truncated: boolean };
  assert.deepEqual({ name: ev.name, via: ev.via, truncated: ev.truncated }, { name: 'alpha', via: 'tool', truncated: false });

  const bad = (await tool!.run({ name: 'gamma' })) as ToolOutput;
  assert.equal(bad.ok, false);
  assert.match(bad.content, /不存在或已不可用/);
  assert.equal(seen.filter((e) => e.type === 'skill.loaded').length, 1, '失败不该记成一次加载');
});

test('一个技能都没有就不注册 skill 工具（白占 schema token）', () => {
  const { tool } = skillTool(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-skills-empty-')));
  assert.equal(tool, undefined);
});

test('只有 skill 工具真注册了，系统提示才提技能', () => {
  const spec = { name: 'skill', description: 'd', parameters: { type: 'object' as const, properties: {} } };
  assert.equal(hasSkillTool([spec]), true);
  assert.equal(hasSkillTool([{ ...spec, name: 'read_file' }]), false);
  assert.ok(systemPrompt(true, [spec]).includes('先调 skill 把正文取回来'));
  assert.equal(systemPrompt(true, [{ ...spec, name: 'read_file' }]).includes('先调 skill'), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { loadPlugins } from '../src/engine/plugin.ts';
import { webPlugin } from '../src/plugins/webPlugin.ts';
import { parseCommand } from '../src/llm/commandGrammar.ts';
import { htmlToText, inlineText } from '../src/net/html.ts';
import { extractUrl, urlIssue, hostBlocked } from '../src/net/http.ts';
import { parseBing, parseDdg } from '../src/net/search.ts';
import type { Fetcher, FetchResult } from '../src/net/http.ts';
import type { WireEvent } from '../src/engine/types.ts';

/** 真实 Bing 结果页的结构（按实际抓取的页面简化，保留关键标签） */
const BING_HTML = `
<ol id="b_results">
<li class="b_algo" data-id iid=SERP.1><h2><a href="https://nodejs.org/" h="ID=x">Node.js — Run JavaScript Everywhere</a></h2>
<div class="b_caption"><p>Node.js&#174; is a free, open-source runtime.</p></div></li>
<li class="b_algo"><h2><a href="https://node.org.cn/">Node.js 中文网</a></h2>
<div class="b_caption"><p>让 JavaScript 无处不在</p></div></li>
<li class="b_algo"><h2><a href="https://example.com/3">第三条</a></h2><div class="b_caption"><p>摘要三</p></div></li>
</ol>`;

const DDG_HTML = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2F&amp;rut=abc">Node.js</a>
  <a class="result__snippet" href="//x">Run JavaScript Everywhere</a>
</div>`;

/** 造一个可控的 fetcher：记录被请求的 URL，按表返回内容 */
function stubFetcher(table: Record<string, string>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string): Promise<FetchResult> => {
    calls.push(url);
    const body = Object.entries(table).find(([k]) => url.includes(k))?.[1];
    if (body === undefined) return { ok: false, error: 'stub 里没有这个 URL', url, ms: 1 };
    return { ok: true, status: 200, url, text: body, bytes: Buffer.byteLength(body), truncated: false, ms: 1 };
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

function setup(fetcher: Fetcher, opts: { fetchOnly?: boolean } = {}) {
  const wire = new Wire();
  const tools = new ToolRegistry();
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  loadPlugins([webPlugin({ fetcher, fetchOnly: opts.fetchOnly })], { tools, wire, workspace: process.cwd() });
  return { tools, events };
}

test('HTML 转文本：丢掉 script/style，块级标签变换行', () => {
  const text = htmlToText('<div>标题</div><script>var a=1</script><p>正文&amp;更多</p><br><span>尾巴</span>');
  // <p> 结束和 <br> 各算一次换行，所以中间留一个空行——段落感保住了
  assert.equal(text, '标题\n正文&更多\n\n尾巴');
  assert.equal(inlineText('<b>粗</b> 体&nbsp;字'), '粗 体 字');
});

test('解析 Bing 结果页', () => {
  const hits = parseBing(BING_HTML, 2);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], {
    title: 'Node.js — Run JavaScript Everywhere',
    url: 'https://nodejs.org/',
    snippet: 'Node.js® is a free, open-source runtime.',
  });
  assert.equal(hits[1].url, 'https://node.org.cn/');
});

test('解析 DuckDuckGo 结果页：还原 uddg 里的真实链接', () => {
  const hits = parseDdg(DDG_HTML, 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, 'https://nodejs.org/');
  assert.equal(hits[0].title, 'Node.js');
});

test('内网 / 本机 / 云元数据地址一律拒绝', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', 'foo.internal', 'x.baidu-int.com']) {
    assert.ok(hostBlocked(h), `${h} 应被拦截`);
  }
  assert.ok(!hostBlocked('example.com'));
  assert.match(urlIssue('http://127.0.0.1:7777/ask')!, /内网/);
  assert.match(urlIssue('file:///etc/passwd')!, /只允许 http/);
  assert.equal(urlIssue('https://example.com/a'), null);
});

test('web_fetch 对内网地址给 dangerous，并且执行时也直接拒绝', async () => {
  const f = stubFetcher({ 'example.com': '<p>hi</p>' });
  const { tools } = setup(f);
  const tool = tools.get('web_fetch')!;
  assert.equal(tool.assess!({ url: 'http://localhost:7777/' })?.level, 'dangerous');
  const out = await tool.run({ url: 'http://localhost:7777/' });
  assert.equal(out.ok, false);
  assert.equal(f.calls.length, 0, '被拒绝的地址不该真的发出请求');
});

test('URL 后面粘了中文说明也能切干净', async () => {
  assert.equal(extractUrl('https://example.com/a?b=1已找到相关页面，接下来读一下'), 'https://example.com/a?b=1');
  // 实测过的脏输出：模型把英文答复直接贴在 .html 后面（纯 ASCII，靠字符集切不掉）
  assert.equal(
    extractUrl('https://nodejs.org/api/typescript.htmlNode.js 的 type stripping'),
    'https://nodejs.org/api/typescript.html',
  );
  // 回归：干净的 .html 不能被砍成 .htm
  assert.equal(extractUrl('https://nodejs.org/api/typescript.html'), 'https://nodejs.org/api/typescript.html');
  assert.equal(extractUrl('fetch https://a.com/b.htmXYZ'), 'https://a.com/b.htm');
  assert.deepEqual(parseCommand('fetch https://example.com/a?b=1然后我总结一下'), {
    name: 'web_fetch',
    args: { url: 'https://example.com/a?b=1' },
  });
  assert.deepEqual(parseCommand('web node 22 type stripping'), {
    name: 'web_search',
    args: { query: 'node 22 type stripping' },
  });
});

test('web_fetch 返回纯文本，并把请求记到事件流；同一 URL 走缓存', async () => {
  const f = stubFetcher({ 'example.com': '<html><body><h1>标题</h1><p>正文</p></body></html>' });
  const { tools, events } = setup(f);
  const tool = tools.get('web_fetch')!;

  const first = await tool.run({ url: 'https://example.com/x' });
  assert.equal(first.ok, true);
  assert.match(first.content, /标题\n正文/);
  assert.equal(first.meta?.action, 'fetched');

  const second = await tool.run({ url: 'https://example.com/x' });
  assert.equal(second.content, first.content);
  assert.equal(f.calls.length, 1, '第二次应命中会话缓存');

  const reqs = events.filter((e) => e.type === 'web.request');
  assert.equal(reqs.length, 2);
  assert.ok(reqs.some((e) => e.type === 'web.request' && e.note === '命中会话缓存'));
});

test('web_search 汇总为 序号/标题/链接/摘要，并计入 meta', async () => {
  const f = stubFetcher({ 'cn.bing.com': BING_HTML });
  const { tools } = setup(f);
  const out = await tools.get('web_search')!.run({ query: 'nodejs', limit: 2 });
  assert.equal(out.ok, true);
  assert.match(out.content, /1\. Node\.js — Run JavaScript Everywhere/);
  assert.match(out.content, /https:\/\/nodejs\.org\//);
  assert.equal(out.meta?.added, 2);
  assert.equal(out.meta?.action, 'searched');
});

test('搜索页解析不出结果时说清原因，而不是假装无匹配', async () => {
  const f = stubFetcher({ 'cn.bing.com': '<html><body>请完成人机验证</body></html>' });
  const { tools } = setup(f);
  const out = await tools.get('web_search')!.run({ query: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.content, /人机验证/);
});

test('查询词清洗：丢掉粘上来的解释文字', async () => {
  const { cleanQuery } = await import('../src/plugins/webPlugin.ts');
  assert.equal(
    cleanQuery('北京 天气 实时 中国天气网 2026年8月15日目前搜索结果仍没有返回可用的北京实时天气数据'),
    '北京 天气 实时 中国天气网',
  );
  assert.equal(cleanQuery('北京天气。抱歉，我这边没查到'), '北京天气');
  assert.equal(cleanQuery('node 22 type stripping 限制'), 'node 22 type stripping 限制');
});

test('同一查询不允许换措辞反复搜，并提示改用 fetch', async () => {
  const f = stubFetcher({ 'cn.bing.com': BING_HTML });
  const { tools } = setup(f);
  const search = tools.get('web_search')!;
  const first = await search.run({ query: 'nodejs 文档' });
  assert.equal(first.ok, true);
  // 只是加了标点和空格，归一化后是同一个查询
  const again = await search.run({ query: 'nodejs，文档 ' });
  assert.equal(again.ok, false);
  assert.match(again.content, /已经搜过/);
  assert.match(again.content, /fetch/);
  assert.equal(f.calls.length, 1, '重复查询不该真的发出请求');
});

test('搜索结果里带上“要事实请 fetch”的提示', async () => {
  const { tools } = setup(stubFetcher({ 'cn.bing.com': BING_HTML }));
  const out = await tools.get('web_search')!.run({ query: 'nodejs' });
  assert.match(out.content, /要给出具体数值\/事实，请用 fetch/);
});

test('每回合搜索次数有上限，用完后要求改用 fetch', async () => {
  const prev = process.env.GB_SEARCH_MAX_PER_TURN;
  process.env.GB_SEARCH_MAX_PER_TURN = '2';
  const f = stubFetcher({ 'cn.bing.com': BING_HTML });
  const { tools } = setup(f);
  const search = tools.get('web_search')!;
  assert.equal((await search.run({ query: 'a 关键词' })).ok, true);
  assert.equal((await search.run({ query: 'b 关键词' })).ok, true);
  const third = await search.run({ query: 'c 关键词' });
  if (prev === undefined) delete process.env.GB_SEARCH_MAX_PER_TURN;
  else process.env.GB_SEARCH_MAX_PER_TURN = prev;

  assert.equal(third.ok, false);
  assert.match(third.content, /搜索次数已用完/);
  assert.match(third.content, /fetch/);
  assert.equal(f.calls.length, 2);
});

test('新回合开始会重置搜索预算与查询去重', async () => {
  const f = stubFetcher({ 'cn.bing.com': BING_HTML });
  const wire = new Wire();
  const tools = new ToolRegistry();
  loadPlugins([webPlugin({ fetcher: f })], { tools, wire, workspace: process.cwd() });
  const search = tools.get('web_search')!;

  assert.equal((await search.run({ query: '北京天气' })).ok, true);
  assert.equal((await search.run({ query: '北京天气' })).ok, false, '同一回合内重复应被挡');

  wire.emit({ type: 'turn.start', turnId: 't2', userText: '再查一次', ts: Date.now() });
  assert.equal((await search.run({ query: '北京天气' })).ok, true, '新回合应允许重新搜');
});

test('fetchOnly 的受限子 agent 拿不到 web_search', () => {
  const { tools } = setup(stubFetcher({}), { fetchOnly: true });
  assert.ok(tools.get('web_fetch'));
  assert.equal(tools.get('web_search'), undefined);
});

test('GB_WEB=0 时联网工具完全不注册', () => {
  const prev = process.env.GB_WEB;
  process.env.GB_WEB = '0';
  const { tools } = setup(stubFetcher({}));
  if (prev === undefined) delete process.env.GB_WEB;
  else process.env.GB_WEB = prev;
  assert.equal(tools.list().length, 0);
});

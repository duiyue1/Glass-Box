import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Approver, ApprovalDecision, ApprovalRequest } from './engine/types.ts';
import { memorable } from './engine/types.ts';
import { buildApp, sessionsDir } from './app.ts';
import { MAX_TITLE, deleteSession, isSafeSessionId, listSessions, readEvents, renameSession } from './engine/journal.ts';
import { rebuildHistory, rebuildInfo } from './engine/rebuild.ts';
import { formatEvent } from './logView.ts';
import { scanSecrets } from './kb/secrets.ts';
import { collapseSame, lineDiff } from './kb/diff.ts';
import { backlinksOf, extractLinks, parseSourceRef, verifyBody } from './kb/wiki.ts';
import { buildTrajectory } from './traceView.ts';

// 安全：只绑定本地回环。这个 agent 能执行命令、读写文件，
// 绝不能监听 0.0.0.0，否则同网段的人可以通过浏览器在你机器上跑命令。
const HOST = '127.0.0.1';
const PORT = Number(process.env.GB_PORT ?? 7777);
const UI_FILE = path.join(import.meta.dirname, 'web', 'ui.html');

// ── SSE 客户端管理 ───────────────────────────────────────────
const clients = new Set<http.ServerResponse>();
function broadcast(obj: unknown): void {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) {
    try {
      c.write(data);
    } catch {
      clients.delete(c);
    }
  }
}

// ── 审批：浏览器里点「允许 / 始终允许 / 拒绝」，通过 /approve 回传 ─────────
let approvalSeq = 0;
const pendingApprovals = new Map<number, (d: ApprovalDecision) => void>();
const approver: Approver = {
  decide(req: ApprovalRequest) {
    const id = ++approvalSeq;
    return new Promise<ApprovalDecision>((resolve) => {
      pendingApprovals.set(id, resolve);
      // memorable 一起送给前端：决定要不要显示「始终允许」按钮
      broadcast({ type: 'approval.ask', id, request: req, memorable: memorable(req), ts: Date.now() });
    });
  },
};

const WORKSPACE = process.cwd();
const app = buildApp({ workspace: WORKSPACE, approver });
// 把 wire 事件原样推给前端——Web UI 只是事件总线的又一个订阅者，引擎零改动
app.wire.subscribe((ev) => broadcast(ev));
app.init();
// 外部工具服务器（.glassbox/mcp.json）。没配就立刻返回
await app.initMcp();

// ── 回合排队：同一时间只跑一个回合 ────────────────────────────
let busy = false;
/**
 * 当前回合的中断器。页面上的「停止」按钮打到 `POST /abort`，掐的就是它。
 * 只停这一个回合：已经做过的步骤留在历史里，接着聊就行。
 */
let turnAbort: AbortController | null = null;
async function runTurn(text: string): Promise<void> {
  if (busy) {
    broadcast({ type: 'web.notice', text: '上一个回合还在进行中', ts: Date.now() });
    return;
  }
  busy = true;
  turnAbort = new AbortController();
  broadcast({ type: 'web.busy', busy: true, ts: Date.now() });
  try {
    await app.session.ask(text, turnAbort.signal);
  } catch (e) {
    broadcast({ type: 'web.notice', text: `回合出错: ${(e as Error).message}`, ts: Date.now() });
  } finally {
    busy = false;
    turnAbort = null;
    broadcast({ type: 'web.busy', busy: false, ts: Date.now() });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      // 资料导入会贴整篇文档，1MB 不够；10MB 是个既够用又不至于把内存打爆的上限
      if (data.length > 10_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  // 页面
  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const html = fs.readFileSync(UI_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500).end('UI 文件缺失');
    }
    return;
  }

  // 事件流（SSE）：新客户端先回放黑匣子历史，再接收实时事件
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`retry: 2000\n\n`);
    for (const ev of app.wire.history()) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'web.ready', busy, ts: Date.now() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // 提交一句输入
  if (req.method === 'POST' && url.pathname === '/ask') {
    try {
      const { text } = JSON.parse(await readBody(req)) as { text?: string };
      const t = (text ?? '').trim();
      if (!t) return json(res, 400, { error: 'empty' });
      json(res, 202, { ok: true });
      void runTurn(t);
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
    return;
  }

  // 回传审批决定
  if (req.method === 'POST' && url.pathname === '/approve') {
    try {
      const body = JSON.parse(await readBody(req)) as {
        id?: number;
        approved?: boolean;
        decision?: string;
      };
      const resolve = typeof body.id === 'number' ? pendingApprovals.get(body.id) : undefined;
      if (!resolve) return json(res, 404, { error: 'no such approval' });
      pendingApprovals.delete(body.id!);
      // decision 是新形态；老的 approved 布尔仍然认（旧前端缓存不至于点不动）
      const decision: ApprovalDecision =
        body.decision === 'always' || body.decision === 'allow' || body.decision === 'deny'
          ? body.decision
          : body.approved
            ? 'allow'
            : 'deny';
      resolve(decision);
      json(res, 200, { ok: true, decision });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
    return;
  }

  // 掐掉当前回合。只停这一个回合：历史保留、会话不变，可以接着聊
  if (req.method === 'POST' && url.pathname === '/abort') {
    if (!turnAbort || turnAbort.signal.aborted) return json(res, 409, { error: '现在没有回合在跑' });
    turnAbort.abort();
    broadcast({ type: 'web.notice', text: '已请求中断本回合（正在执行的那一步工具会跑完）', ts: Date.now() });
    return json(res, 200, { ok: true });
  }

  // ── 资料库 ────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/kb/list') {
    return json(res, 200, {
      // digest：这篇有没有蒸馏过的「摘要+别名」索引块（重新导入会失效，需要再蒸一次）
      docs: app.kb.list().map((d) => ({ ...d, digest: Boolean(app.kb.digestOf(d.id)) })),
      docCount: app.kb.docCount(),
      chunkCount: app.kb.chunkCount(),
      digestCount: app.kb.digestCount(),
      digestPending: app.kb.needsDigest().length,
    });
  }

  if (req.method === 'POST' && url.pathname === '/kb/import') {
    try {
      const { text, title, source } = JSON.parse(await readBody(req)) as {
        text?: string;
        title?: string;
        source?: string;
      };
      if (!text || !text.trim()) return json(res, 400, { error: '内容为空' });
      // 合规：导入前扫一遍疑似密钥。只提示不拦——判断要不要入库是人的事
      const secrets = scanSecrets(text);
      const { doc, chunks } = app.kb.import({ text, title, source });
      // 查重放在导入后，用真实的 doc.id 排除自己（同名导入本来就是覆盖同一篇）
      const duplicates = app.kb.duplicatesOf(text, { excludeId: doc.id });
      app.wire.emit({
        type: 'kb.imported',
        docId: doc.id,
        title: doc.title,
        chunks,
        chars: doc.chars,
        version: doc.version,
        ts: Date.now(),
      });
      return json(res, 200, { ok: true, doc, chunks, warnings: { secrets, duplicates } });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/kb/archive') {
    try {
      const { id, restore } = JSON.parse(await readBody(req)) as { id?: string; restore?: boolean };
      if (!id) return json(res, 400, { error: '缺少 id' });
      const ok = restore ? app.kb.restore(id) : app.kb.archive(id);
      app.wire.emit({
        type: 'kb.loaded',
        docs: app.kb.docCount(),
        chunks: app.kb.chunkCount(),
        path: '',
        ts: Date.now(),
      });
      return json(res, 200, { ok });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // 读回原文，给面板上的「编辑」用。带 version 时读历史版本（只读，不改当前）
  if (req.method === 'GET' && url.pathname === '/kb/raw') {
    const id = url.searchParams.get('id') ?? '';
    const vParam = url.searchParams.get('version');
    const doc = app.kb.list().find((d) => d.id === id);
    const version = vParam ? Number(vParam) : undefined;
    if (vParam && !Number.isInteger(version)) return json(res, 400, { error: '非法的版本号' });
    const text = app.kb.rawVersion(id, version);
    if (!doc || text === undefined) return json(res, 404, { error: '读不到这篇资料的原文' });
    return json(res, 200, { id, title: doc.title, version: version ?? doc.version, current: doc.version, text });
  }

  // 版本列表（当前版本 + history 里留下的旧版本）
  if (req.method === 'GET' && url.pathname === '/kb/versions') {
    const id = url.searchParams.get('id') ?? '';
    const versions = app.kb.versions(id);
    if (!versions.length) return json(res, 404, { error: '没有这篇资料' });
    return json(res, 200, { id, versions });
  }

  // 回滚：把旧版本内容当成一次新导入，版本号继续往前走
  if (req.method === 'POST' && url.pathname === '/kb/rollback') {
    try {
      const { id, version } = JSON.parse(await readBody(req)) as { id?: string; version?: number };
      if (!id) return json(res, 400, { error: '缺少 id' });
      if (!Number.isInteger(version)) return json(res, 400, { error: '缺少 version' });
      const { doc, chunks } = app.kb.rollback(id, version as number);
      app.wire.emit({
        type: 'kb.imported',
        docId: doc.id,
        title: doc.title,
        chunks,
        chars: doc.chars,
        version: doc.version,
        ts: Date.now(),
      });
      return json(res, 200, { ok: true, doc, chunks });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // 按当前切块参数重新索引全部资料（改了 chunker 参数后老文档不会自动跟着变）
  if (req.method === 'POST' && url.pathname === '/kb/reindex') {
    try {
      const r = app.kb.reindex();
      app.wire.emit({
        type: 'kb.loaded',
        docs: app.kb.docCount(),
        chunks: app.kb.chunkCount(),
        path: '',
        ts: Date.now(),
      });
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // 版本对比：回滚前先看清这一版改了什么。纯文本行级 diff，零依赖
  if (req.method === 'GET' && url.pathname === '/kb/diff') {
    const id = url.searchParams.get('id') ?? '';
    const doc = app.kb.list().find((d) => d.id === id);
    if (!doc) return json(res, 404, { error: '没有这篇资料' });
    const from = Number(url.searchParams.get('from'));
    const to = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : doc.version;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return json(res, 400, { error: '非法的版本号' });
    const oldText = app.kb.rawVersion(id, from);
    const newText = app.kb.rawVersion(id, to);
    if (oldText === undefined) return json(res, 404, { error: `读不到 v${from} 的原文` });
    if (newText === undefined) return json(res, 404, { error: `读不到 v${to} 的原文` });
    const { lines, stat } = lineDiff(oldText, newText);
    return json(res, 200, { id, title: doc.title, from, to, stat, lines: collapseSame(lines) });
  }

  // 蒸馏：给资料生成「摘要 + 别名」索引块（只参与检索打分，不注入正文）。
  // 不带 id 时只处理还没蒸馏过 / 蒸馏过但正文已更新的资料。
  if (req.method === 'POST' && url.pathname === '/kb/distill') {
    try {
      const { id } = JSON.parse((await readBody(req)) || '{}') as { id?: string };
      const r = await app.distill(id);
      return json(res, 200, { ok: true, ...r, pending: app.kb.needsDigest().length });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // 块级上下文：给每块补一句「这段在讲什么」+ 状态。一篇一次模型调用
  if (req.method === 'POST' && url.pathname === '/kb/context') {
    try {
      const { id } = JSON.parse((await readBody(req)) || '{}') as { id?: string };
      const r = await app.contextualize(id);
      return json(res, 200, {
        ok: true,
        ...r,
        pending: app.kb.needsContext().length,
        total: app.kb.contextCount(),
        chunks: app.kb.chunkCount(),
      });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // 真删（原文 + 索引一起清），不可恢复；想留着就用 /kb/archive
  if (req.method === 'POST' && url.pathname === '/kb/delete') {
    try {
      const { id } = JSON.parse(await readBody(req)) as { id?: string };
      if (!id) return json(res, 400, { error: '缺少 id' });
      const ok = app.kb.remove(id);
      if (!ok) return json(res, 404, { error: '没有这篇资料' });
      app.wire.emit({
        type: 'kb.loaded',
        docs: app.kb.docCount(),
        chunks: app.kb.chunkCount(),
        path: '',
        ts: Date.now(),
      });
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // ── wiki（资料编译成的条目层）────────────────────────────
  if (req.method === 'GET' && url.pathname === '/wiki/tree') {
    return json(res, 200, app.wikiTree());
  }

  if (req.method === 'GET' && url.pathname === '/wiki/graph') {
    return json(res, 200, app.wikiGraph());
  }

  if (req.method === 'GET' && url.pathname === '/wiki/impact') {
    const start = url.searchParams.get('ref') ?? url.searchParams.get('source') ?? '';
    const depth = Math.min(5, Math.max(1, Number(url.searchParams.get('depth') ?? 2) || 2));
    if (!start) return json(res, 400, { error: '缺少 ref 或 source' });
    return json(res, 200, { start, depth, impact: app.wikiImpact(start, depth) });
  }

  if (req.method === 'GET' && url.pathname === '/wiki/versions') {
    return json(res, 200, { versions: app.wikiVersions() });
  }

  if (req.method === 'GET' && url.pathname === '/wiki/diff') {
    const id = Number(url.searchParams.get('version'));
    if (!Number.isInteger(id) || id < 1) return json(res, 400, { error: 'version 必须是正整数' });
    return json(res, 200, { version: id, diff: app.wikiDiff(id) });
  }

  if (req.method === 'POST' && url.pathname === '/wiki/rollback') {
    try {
      const { version } = JSON.parse((await readBody(req)) || '{}') as { version?: number };
      if (!Number.isInteger(version) || version < 1) return json(res, 400, { error: 'version 必须是正整数' });
      const restored = app.wikiRollback(version);
      if (!restored) return json(res, 404, { error: '没有这个版本或版本为空' });
      return json(res, 200, { ok: true, restored });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // 一条条目：正文 + frontmatter + 反向链接 + 依据块的位置（点了能跳原文）
  if (req.method === 'GET' && url.pathname === '/wiki/page') {
    const ref = url.searchParams.get('ref') ?? '';
    const page = app.wiki.read(ref);
    if (!page) return json(res, 404, { error: '没有这个条目' });
    const back = backlinksOf(app.wiki.list()).get(ref) ?? [];
    // 依据块：给出所在文档与标题路径，前端才能显示「3. 分布式锁 #2」并跳过去
    const sources = page.sources.map((s) => {
      const sr = parseSourceRef(s);
      const chunk = sr ? app.kb.chunksOf(sr.docId).find((c) => c.index === sr.index) : undefined;
      return { ref: s, docId: sr?.docId ?? '', index: sr?.index ?? -1, headingPath: chunk?.headingPath ?? '' };
    });
    return json(res, 200, { ...page, backlinks: back, sourceChunks: sources });
  }

  // 附属文件：index / log / AGENTS（面板上也能点开看）
  if (req.method === 'GET' && url.pathname === '/wiki/file') {
    const name = url.searchParams.get('name') ?? '';
    if (name !== 'index' && name !== 'log' && name !== 'AGENTS') return json(res, 400, { error: '只支持 index/log/AGENTS' });
    const text = app.wiki.readFile(name);
    if (text === undefined) return json(res, 404, { error: '这个文件还不存在' });
    return json(res, 200, { name, text });
  }

  // 手工修正模型编错的条目。保存后重新校验一次，别让手改绕过溯源检查
  if (req.method === 'POST' && url.pathname === '/wiki/save') {
    try {
      const { ref, body, summary } = JSON.parse(await readBody(req)) as {
        ref?: string;
        body?: string;
        summary?: string;
      };
      const page = ref ? app.wiki.read(ref) : undefined;
      if (!page) return json(res, 404, { error: '没有这个条目' });
      if (typeof body !== 'string' || !body.trim()) return json(res, 400, { error: '正文为空' });
      const texts = page.sources
        .map((s) => {
          const sr = parseSourceRef(s);
          return sr ? (app.kb.chunksOf(sr.docId).find((c) => c.index === sr.index)?.text ?? '') : '';
        })
        .filter(Boolean);
      const check = verifyBody(body, texts);
      const next = {
        ...page,
        body,
        ...(typeof summary === 'string' ? { summary } : {}),
        related: extractLinks(body),
        verified: check.ok,
        ...(check.ok ? { unverified: undefined } : { unverified: check.missing }),
        ts: Date.now(),
      };
      app.wiki.snapshot(`edit: ${page.ref}`);
      app.wiki.write(next);
      app.wiki.writeIndex(app.wiki.list());
      app.wiki.appendLog(`手工编辑 ${page.ref}${check.ok ? '' : `（仍有 ${check.missing.length} 处找不到出处）`}`);
      return json(res, 200, { ok: true, verified: check.ok, missing: check.missing });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/wiki/delete') {
    try {
      const { ref } = JSON.parse(await readBody(req)) as { ref?: string };
      if (!ref) return json(res, 400, { error: '缺少 ref' });
      if (!app.wiki.read(ref)) return json(res, 404, { error: '没有这个条目' });
      app.wiki.snapshot(`delete: ${ref}`);
      const ok = app.wiki.remove(ref);
      if (!ok) return json(res, 404, { error: '没有这个条目' });
      app.wiki.writeIndex(app.wiki.list());
      app.wiki.appendLog(`删除条目 ${ref}（原文未动，可重新生成）`);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // 生成：不带 doc 就编译全部启用中的资料。要调模型，所以是显式动作。
  // staleOnly 只重建依据原文已改动的条目（自愈的执行端）
  if (req.method === 'POST' && url.pathname === '/wiki/build') {
    try {
      const { doc, staleOnly } = JSON.parse((await readBody(req)) || '{}') as {
        doc?: string;
        staleOnly?: boolean;
      };
      const r = await app.buildWiki(doc, { staleOnly: Boolean(staleOnly) });
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // 补摘要/别名：不带 ref 就把所有不齐的补一遍。也要调模型，同样是显式动作
  if (req.method === 'POST' && url.pathname === '/wiki/summarize') {
    try {
      const { ref } = JSON.parse((await readBody(req)) || '{}') as { ref?: string };
      const r = await app.summarizeWiki(ref);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // 质检：GET 只读上次结果 + 30 天趋势（不调模型、不花钱）；POST 才真跑一次
  if (req.method === 'GET' && url.pathname === '/wiki/audit') {
    const days = Number(url.searchParams.get('days') ?? 30) || 30;
    const history = app.wikiQuality(days);
    return json(res, 200, { history, last: history.at(-1) ?? null, pages: app.wiki.count() });
  }
  if (req.method === 'POST' && url.pathname === '/wiki/audit') {
    try {
      const { sample } = JSON.parse((await readBody(req)) || '{}') as { sample?: number };
      const r = await app.auditWiki({ sample: Number(sample) || 0 });
      return json(res, 200, { ok: true, report: r, history: app.wikiQuality(30) });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // ── 会话列表与轨迹 ────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/sessions') {
    return json(res, 200, {
      current: app.journal.sessionId,
      // 当前会话可能还没落盘（懒创建：一句话没说就不建文件），列表里当然也查不到它
      currentPending: app.journal.isPending(),
      sessions: listSessions(sessionsDir(WORKSPACE)),
    });
  }

  // 轨迹视图：拖到第 to 步时，「当时的事件」+「当时的对话状态」
  // 事件按窗口分页（默认给尾部一页），并派生出按回合分层的轨迹
  if (req.method === 'GET' && url.pathname === '/sessions/view') {
    const id = url.searchParams.get('id') ?? '';
    if (!isSafeSessionId(id)) return json(res, 400, { error: '非法的会话 id' });
    const toParam = Number(url.searchParams.get('to'));
    const fromParam = Number(url.searchParams.get('from'));
    const limitParam = Number(url.searchParams.get('limit'));
    const all = readEvents(sessionsDir(WORKSPACE), id);
    if (!all.length) return json(res, 404, { error: '读不到该会话' });
    const maxSeq = all.at(-1)!.seq;
    const to = Number.isFinite(toParam) && toParam > 0 ? Math.min(toParam, maxSeq) : maxSeq;
    const shown = all.filter((r) => r.seq <= to);
    const info = rebuildInfo(shown);

    // 长会话不整份发给浏览器：默认只给尾部一页，客户端往上翻时再要更早的
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 2000) : 400;
    const win = Number.isFinite(fromParam) && fromParam > 0 ? shown.filter((r) => r.seq >= fromParam) : shown.slice(-limit);
    const winFrom = win[0]?.seq ?? 1;

    // 窗口之前的部分：用来给回合编号，并认出「窗口开始时还没结束的那个回合」，
    // 否则翻到中段时那些行会被当成「回合之间」——那是假的。
    const prefix = shown.filter((r) => r.seq < winFrom);
    let turnsBefore = 0;
    let openTurn: { turnId: string; userText: string; startTs: number } | undefined;
    for (const r of prefix) {
      if (r.ev.type === 'turn.start') {
        turnsBefore++;
        openTurn = { turnId: r.ev.turnId, userText: r.ev.userText, startTs: r.ev.ts };
      } else if (r.ev.type === 'turn.end') {
        openTurn = undefined;
      }
    }

    return json(res, 200, {
      sessionId: id,
      maxSeq,
      to,
      turns: info.turns,
      atSeq: info.atSeq,
      window: {
        from: winFrom,
        to: win.at(-1)?.seq ?? winFrom,
        count: win.length,
        // 还有更早的没发过来：前端顶部给一个「加载更早」的入口
        hasEarlier: winFrom > (shown[0]?.seq ?? 1),
        pageSize: limit,
      },
      // 按回合分层的轨迹（纯派生，窗口内配不上对的调用不编耗时）
      trace: buildTrajectory(win, { openTurn, turnsBefore }),
      // 复用 CLI 的渲染器：面板上「原始日志」看到的和 replay 输出的是同一份文字
      lines: win.map((r) => ({ seq: r.seq, type: r.ev.type, text: formatEvent(r.ev).join('\n') })).filter((l) => l.text),
      // 不传 blobs：状态预览不需要把图片原图发到浏览器，占位串足够
      messages: rebuildHistory(shown).map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls?.map((c) => c.name),
      })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/sessions/fork') {
    try {
      const { id, seq } = JSON.parse(await readBody(req)) as { id?: string; seq?: number };
      if (!id || !isSafeSessionId(id)) return json(res, 400, { error: '非法的会话 id' });
      // 回合进行中切换历史会把正在进行的对话搅乱
      if (busy) return json(res, 409, { error: '上一个回合还在进行中，稍后再分叉' });
      const out = app.fork(id, typeof seq === 'number' ? seq : undefined);
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/sessions/new') {
    // 和分叉同样的理由：回合进行中切会话会把正在进行的对话搅乱
    if (busy) return json(res, 409, { error: '上一个回合还在进行中，稍后再新建' });
    const out = app.newSession();
    return json(res, 200, { ok: true, ...out });
  }

  // 改名：只追加一条 session.renamed，历史一行都不改
  if (req.method === 'POST' && url.pathname === '/sessions/rename') {
    try {
      const { id, title } = JSON.parse(await readBody(req)) as { id?: string; title?: string };
      if (!id || !isSafeSessionId(id)) return json(res, 400, { error: '非法的会话 id' });
      const t = (title ?? '').trim().slice(0, MAX_TITLE);
      if (!t) return json(res, 400, { error: '名字不能为空' });
      if (id === app.journal.sessionId) {
        // 当前会话必须走事件总线，让 Journal 自己分配 seq（直接写文件会撞号）
        app.wire.emit({ type: 'session.renamed', sessionId: id, title: t, ts: Date.now() });
        return json(res, 200, { ok: true, title: t });
      }
      const ok = renameSession(sessionsDir(WORKSPACE), id, t);
      return ok ? json(res, 200, { ok: true, title: t }) : json(res, 404, { error: '读不到该会话' });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // 删除：唯一会真正丢历史的操作，所以当前会话不许删
  if (req.method === 'POST' && url.pathname === '/sessions/delete') {
    try {
      const { id } = JSON.parse(await readBody(req)) as { id?: string };
      if (!id || !isSafeSessionId(id)) return json(res, 400, { error: '非法的会话 id' });
      if (id === app.journal.sessionId) {
        return json(res, 400, { error: '这是当前会话，先「新建会话」再删它' });
      }
      const ok = deleteSession(sessionsDir(WORKSPACE), id);
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: '删不掉（文件可能已经不在）' });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`\nGlass-Box Web UI: http://${HOST}:${PORT}`);
  console.log('（仅监听本地回环；有风险的操作会在页面上请求你确认）\n');
});

import readline from 'node:readline';
import { blobsDir, buildApp, sessionsDir } from './app.ts';
import type { Approver, ApprovalDecision, ApprovalRequest, Msg } from './engine/types.ts';
import { memorable } from './engine/types.ts';
import { Renderer } from './tui/renderer.ts';
import { FileBlobStore } from './engine/blobs.ts';
import { readEvents } from './engine/journal.ts';
import { rebuildHistory, rebuildInfo } from './engine/rebuild.ts';

const color = Boolean(process.stdout.isTTY);
const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
const oneline = (s: string, n = 100) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// 用一个行队列消费 stdin：无论真人逐行输入还是脚本一次性喂入，都不丢行。
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: color });
const queue: string[] = [];
let waiting: ((v: string | null) => void) | null = null;
let closed = false;
rl.on('line', (l) => {
  if (waiting) {
    const w = waiting;
    waiting = null;
    w(l);
  } else queue.push(l);
});
rl.on('close', () => {
  closed = true;
  if (waiting) {
    const w = waiting;
    waiting = null;
    w(null);
  }
});
function nextLine(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  if (queue.length) return Promise.resolve(queue.shift()!);
  if (closed) return Promise.resolve(null);
  return new Promise((res) => {
    waiting = res;
  });
}

/**
 * 当前回合的中断器（回合进行中才有值）。
 *
 * 以前唯一的停止手段是 Ctrl-C 杀进程——模型跑飞、命令卡住、检索绕圈，
 * 代价都是把整个进程连会话一起丢掉。现在 Esc / Ctrl-C 只掐这一个回合：
 * 已经做过的步骤留在历史里，接着聊就行。
 */
let turnAbort: AbortController | null = null;

/** 掐掉当前回合。返回 false = 现在没有回合在跑 */
function interrupt(): boolean {
  if (!turnAbort || turnAbort.signal.aborted) return false;
  turnAbort.abort();
  closeStreamLine();
  console.log(dim('\n[中断] 已请求停止本回合（正在执行的那一步工具会跑完）'));
  return true;
}

// 回合进行中按 Ctrl-C = 停这个回合；空闲时按 = 退出
rl.on('SIGINT', () => {
  if (!interrupt()) rl.close();
});
// terminal 模式下 readline 已经在 stdin 上开了 keypress，直接搭车监听 Esc
if (color) {
  process.stdin.on('keypress', (_ch: string, key?: { name?: string; ctrl?: boolean; meta?: boolean }) => {
    if (key?.name === 'escape' && !key.ctrl && !key.meta) interrupt();
  });
}

// 审批者：复用同一个输入队列逐条问（真人实时审批）
const approver: Approver = {
  async decide(req: ApprovalRequest): Promise<ApprovalDecision> {
    const mark = req.level === 'dangerous' ? '[危险]' : '[需确认]';
    const reason = req.reason ? `（${req.reason}）` : '';
    if (req.preview) {
      console.log(dim('  变更预览:'));
      for (const line of req.preview.split('\n')) console.log(dim('    ' + line));
    }
    // 只有 confirm、且没被标记记忆旁路的才给 a：
    // dangerous 一次点头不该换来永久授权，关键配置文件更要每次单独看
    const canRemember = memorable(req);
    const hint = canRemember ? '[y / a=以后同类不再问 / N]' : '[y/N]';
    const raw = (await nextLine(dim(`  ${mark} ${req.summary}${reason} 允许? ${hint} `))) ?? '';
    const ans = raw.trim().toLowerCase();
    if (canRemember && (ans === 'a' || ans === 'always')) return 'always';
    return /^y(es)?$/.test(ans) ? 'allow' : 'deny';
  },
};

/**
 * 恢复与分叉：
 *   --resume <sessionId>            续跑该会话（日志追加到同一个文件）
 *   --resume <sessionId> --at <seq> 从该步分叉出一个新会话（原会话一个字节都不动）
 * 对话状态从会话日志重建，图片从 blob 仓库还原。
 */
const argv = process.argv.slice(2);
const numAfter = (flag: string): number | undefined => {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) ? n : undefined;
};
const resumeIdx = argv.indexOf('--resume');
const resumeId = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined;
const atSeq = numAfter('--at');

const sdir = sessionsDir(process.cwd());
let restored: Msg[] | undefined;
let restoredTurns = 0;
const buildOpts: Parameters<typeof buildApp>[0] = { workspace: process.cwd(), approver };

if (resumeId) {
  const records = readEvents(sdir, resumeId, atSeq);
  if (!records.length) {
    console.error(`读不到会话 ${resumeId}（目录: ${sdir}）。用 node src/replay.ts 看看有哪些会话。`);
    process.exit(1);
  }
  const info = rebuildInfo(records);
  restored = rebuildHistory(records, new FileBlobStore(blobsDir(process.cwd())));
  restoredTurns = info.turns;
  if (atSeq === undefined) buildOpts.resumeSessionId = resumeId;
  else buildOpts.forkedFrom = { sessionId: resumeId, seq: info.atSeq, ts: info.atTs };
}

const app = buildApp(buildOpts);
const renderer = new Renderer({ color, cols: Math.min(process.stdout.columns || 100, 120) });

// 实时进度：把关键内部动作以简洁提示流式打印（玻璃盒的“边跑边看”）
let streamedThisTurn = false;
let streamLineOpen = false;
function closeStreamLine(): void {
  if (streamLineOpen) {
    process.stdout.write('\n');
    streamLineOpen = false;
  }
}

app.wire.subscribe((ev) => {
  renderer.apply(ev);
  // 流式输出结束后，先给它收个尾，再打印其它提示，避免粘在同一行
  if (ev.type !== 'llm.delta') closeStreamLine();
  switch (ev.type) {
    case 'llm.delta':
      if (!streamedThisTurn) {
        streamedThisTurn = true;
        streamLineOpen = true;
        process.stdout.write(bold('\nAI> '));
      }
      process.stdout.write(ev.text);
      break;
    case 'context.injected':
      if (ev.contributions.length) console.log(dim(`  · 注入上下文: ${ev.contributions.map((c) => c.source).join(', ')}`));
      break;
    case 'tool.call':
      console.log(dim(`  · 调用工具 ${ev.call.name}(${oneline(JSON.stringify(ev.call.args), 60)})`));
      break;
    case 'tool.result':
      console.log(dim(`  · 工具结果: ${oneline(ev.result.content, 80)}`));
      break;
    case 'subagent.start':
      console.log(dim(`  · 子 agent 开始: ${ev.task}`));
      break;
    case 'subagent.end':
      console.log(dim(`  · 子 agent 完成（用了 ${ev.toolsUsed.join(', ') || '无'}）`));
      break;
    case 'memory.injected':
      if (ev.items.length) console.log(dim(`  · 记忆注入 ${ev.items.length} 条（${ev.usedTokens}/${ev.budget} tok）`));
      break;
    case 'memory.distilled':
      console.log(dim(`  · 记忆蒸馏 +${ev.atoms.length}（共 ${ev.total}）`));
      break;
    case 'context.compacted':
      console.log(dim(`  · 上下文压缩：丢弃 ${ev.droppedMessages} 条，${ev.tokensBefore}→${ev.tokensAfter} tok`));
      break;
    case 'context.pruned':
      console.log(dim(`  · 削工具输出：${ev.prunedMessages} 条，省掉 ${ev.charsRemoved} 字`));
      break;
    case 'token.estimate':
      console.log(
        dim(
          `  · token 对账：估 ${ev.estimated} / 实 ${ev.actual}，偏差 ` +
            `${ev.drift >= 0 ? '+' : ''}${(ev.drift * 100).toFixed(1)}%`,
        ),
      );
      break;
    case 'turn.limit':
      console.log(dim(`  · 步数用尽（上限 ${ev.maxSteps}），已要求模型直接收尾`));
      break;
    case 'turn.aborted':
      console.log(dim(`  · 回合被中断（已执行 ${ev.steps} 次工具调用），历史保留，可以接着聊`));
      break;
    case 'web.request':
      console.log(
        dim(`  · 联网 ${ev.ok ? '✓' : '✗'} ${oneline(ev.url, 60)} · ${ev.ms}ms${ev.note ? ` · ${ev.note}` : ''}`),
      );
      break;
  }
});

app.init();
// 外部工具服务器（.glassbox/mcp.json）。没配就立刻返回，不影响启动速度
await app.initMcp();

if (restored) {
  app.session.restore(restored);
  const how = atSeq === undefined ? '续跑' : `分叉自 ${resumeId}@${atSeq}`;
  console.log(dim(`\n[会话] ${how}：恢复了 ${restoredTurns} 个回合、${restored.length} 条消息`));
}

console.log(bold('\nGlass-Box 交互式对话'));
console.log(dim('输入自然语言与 agent 对话。命令：/new 开新会话 · /panel 看玻璃盒面板 · /help 帮助 · /exit 退出'));
console.log(dim('回合进行中按 Esc（或 Ctrl-C）可中断本回合；空闲时按 Ctrl-C 退出。'));
console.log(dim(`会话日志: ${app.journal.path}${app.journal.isPending() ? '（说第一句话时才创建）' : ''}`));

for (;;) {
  const line = await nextLine(bold('\n你> '));
  if (line === null) break;
  const t = line.trim();
  if (!t) continue;
  if (t === '/exit' || t === '/quit') break;
  if (t === '/help') {
    console.log(dim('  /new  开一个空白会话  ·  /panel  显示玻璃盒内部状态面板  ·  /help 帮助  ·  /exit 退出'));
    console.log(dim('  回合跑飞了按 Esc 或 Ctrl-C 中断它（只停这一个回合，历史和会话都留着）。'));
    console.log(dim('  写文件 / 执行命令等有风险的操作会在这里请求你确认。'));
    continue;
  }
  if (t === '/new') {
    const s = app.newSession();
    console.log(dim(`\n[会话] 已开新会话 ${s.sessionId}（不带上文）\n会话日志: ${s.path}（说第一句话时才创建）`));
    continue;
  }
  if (t === '/panel') {
    console.log('\n' + renderer.frame());
    continue;
  }

  streamedThisTurn = false;
  turnAbort = new AbortController();
  const messages = await app.session.ask(t, turnAbort.signal).finally(() => {
    turnAbort = null;
  });
  closeStreamLine();
  if (!streamedThisTurn) console.log(bold('\nAI> ') + (messages.at(-1)?.content ?? ''));
}

rl.close();
console.log(dim('\n再见。'));

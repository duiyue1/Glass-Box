import readline from 'node:readline';
import { blobsDir, buildApp, sessionsDir } from './app.ts';
import type { Approver, ApprovalDecision, ApprovalRequest, Msg } from './engine/types.ts';
import { memorable } from './engine/types.ts';
import { Renderer } from './tui/renderer.ts';
import { FileBlobStore } from './engine/blobs.ts';
import { readEvents } from './engine/journal.ts';
import { rebuildHistory, rebuildInfo } from './engine/rebuild.ts';
import { hasFlag, resolveWorkspace, stripFlags } from './cli.ts';
import {
  applyPatch,
  changedFiles,
  createSandbox,
  patchStat,
  removeSandbox,
  sandboxPatch,
  type Sandbox,
} from './engine/sandbox.ts';

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

// --sandbox：整个会话跑在一份 git worktree 副本里，改了什么随时 /diff 看、
// 满意了 /apply 打回工作树。交互式会话恰恰是最需要它的形态——一次性任务你
// 还能盯着 diff，聊着聊着改二十个文件时根本没法逐条审
const wantSandbox = hasFlag(argv, '--sandbox');
let sandbox: Sandbox | undefined;
if (wantSandbox) {
  try {
    sandbox = createSandbox(resolveWorkspace(argv));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
const workspace = sandbox?.dir ?? resolveWorkspace(argv);
const sdir = sessionsDir(workspace);
let restored: Msg[] | undefined;
let restoredTurns = 0;
const buildOpts: Parameters<typeof buildApp>[0] = { workspace, approver };

if (resumeId) {
  const records = readEvents(sdir, resumeId, atSeq);
  if (!records.length) {
    console.error(`读不到会话 ${resumeId}（目录: ${sdir}）。用 node src/replay.ts 看看有哪些会话。`);
    process.exit(1);
  }
  const info = rebuildInfo(records);
  restored = rebuildHistory(records, new FileBlobStore(blobsDir(workspace)));
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
console.log(
  dim(
    '输入自然语言与 agent 对话。命令：/new 开新会话 · /panel 看玻璃盒面板 · /help 帮助 · /exit 退出' +
      (sandbox ? ' · /diff /apply /drop 管理隔离副本' : ''),
  ),
);
console.log(dim('回合进行中按 Esc（或 Ctrl-C）可中断本回合；空闲时按 Ctrl-C 退出。'));
if (sandbox) {
  console.log(dim(`[沙箱] 本会话跑在隔离副本里：${sandbox.dir}`));
  console.log(dim(`[沙箱] 分支 ${sandbox.branch}（从 HEAD 出发，你未提交的改动不在里面）`));
  console.log(dim('[沙箱] 会话里改的文件都在副本上；/diff 随时看，/apply 打回工作树，/drop 整个丢弃'));
}
console.log(dim(`会话日志: ${app.journal.path}${app.journal.isPending() ? '（说第一句话时才创建）' : ''}`));

// /drop 的出口标记：会话日志还在副本目录里开着，必须先退出循环、关掉 readline，
// 再删副本——顺序反了 Journal 会往一个已删除的目录里写
let dropSandboxAndExit = false;

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
    if (sandbox) {
      console.log(dim('  /diff   看隔离副本里 agent 改了哪些文件'));
      console.log(dim('  /apply  把副本的改动打回你的工作树（不产生提交，不满意 git checkout -- . 可回退）'));
      console.log(dim('  /drop   整个副本丢弃（连本次会话日志一起，不可恢复）'));
    }
    continue;
  }
  // ── 沙箱三连：会话中途随时看/合/扔 ──────────────────────────────
  if (sandbox && t === '/diff') {
    const changed = changedFiles(sandbox);
    if (changed.length === 0) {
      console.log(dim('\n[沙箱] 副本里还没有任何改动。'));
    } else {
      console.log(bold(`\n[沙箱] 副本里改了 ${changed.length} 个文件：`));
      console.log(dim(patchStat(sandbox)));
      console.log(dim(`完整 diff:  git -C ${sandbox.dir} diff --cached HEAD`));
    }
    continue;
  }
  if (sandbox && t === '/apply') {
    const changed = changedFiles(sandbox);
    if (changed.length === 0) {
      console.log(dim('\n[沙箱] 没有改动可合入。'));
      continue;
    }
    // 副本里的会话可能还在往上叠改动，所以每次都取当下这份补丁
    const patch = sandboxPatch(sandbox);
    const r = applyPatch(sandbox, patch);
    if (r.ok) {
      console.log(bold(`\n[沙箱] 已合入 ${changed.length} 个文件到你的工作树（只动工作树，没有提交）。`));
      console.log(dim('  不满意就 git checkout -- . 回退。注意：合入后副本继续有效，后面还能再 /apply 增量。'));
    } else {
      console.error(`[沙箱] 补丁没打上：${r.error}`);
      console.error(dim('  通常是你的工作树在同一处也改了。git -C ' + sandbox.dir + ' diff --cached HEAD 看看原文。'));
    }
    continue;
  }
  if (sandbox && t === '/drop') {
    const changed = changedFiles(sandbox);
    const q = changed.length
      ? `副本里有 ${changed.length} 个文件的改动没合入，连同本次会话日志一起丢弃？[y/N] `
      : '丢弃这个副本（本次会话日志会一起没）？[y/N] ';
    const ans = (await nextLine(dim(`  ${q}`))) ?? '';
    if (!/^y(es)?$/i.test(ans.trim())) {
      console.log(dim('  已取消。'));
      continue;
    }
    // 会话日志在副本目录里，先退出循环由 finally 清理，别在 Journal 还开着的时候删目录
    dropSandboxAndExit = true;
    break;
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
if (sandbox) {
  if (dropSandboxAndExit) {
    removeSandbox(sandbox);
    console.log(dim('\n[沙箱] 副本已丢弃。'));
  } else if (changedFiles(sandbox).length > 0) {
    // 正常退出但副本里有未处置的改动：把去路说清楚，别让它变成 worktree 列表里的孤儿
    console.log(dim(`\n[沙箱] 副本里还有 ${changedFiles(sandbox).length} 个文件的改动没处置。`));
    console.log(dim(`  看完整 diff: git -C ${sandbox.dir} diff --cached HEAD`));
    console.log(dim(`  手动合入:    git -C ${sandbox.dir} diff --cached HEAD | git apply --index`));
    console.log(dim(`  手动丢弃:    git worktree remove --force ${sandbox.dir} && git branch -D ${sandbox.branch}`));
  } else {
    removeSandbox(sandbox);
  }
}
console.log(dim('\n再见。'));

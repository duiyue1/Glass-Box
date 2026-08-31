import readline from 'node:readline/promises';
import type { Approver } from './engine/types.ts';
import { AutoApprover, InteractiveApprover } from './engine/approval.ts';
import { buildApp, parseTurns } from './app.ts';
import { formatSummary } from './activity/activity.ts';
import { formatEvent } from './logView.ts';
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

/**
 * 一次性跑几个回合的入口。
 *
 * 两种输出形态：
 * - 默认：给人看，`formatEvent` 渲染的事件流 + 最终回复。
 * - `--json`：给程序看，**stdout 只有 JSONL**（每行一个 wire 事件，末尾一行 result）。
 *   人类日志一律走 stderr，所以 `node src/index.ts "任务" --json | jq` 是干净的。
 *
 * `--sandbox` 让它在一份 git worktree 工作副本里跑，跑完只给你 diff（见 engine/sandbox.ts）。
 *
 * 退出码（能被 CI / 脚本直接判断，这是"能塞进流水线"的前提）：
 * - `0` 全部回合跑完
 * - `1` 有回合抛异常，或 `--apply` 时补丁没打上
 * - `2` 用法错误（参数不对、工作区不存在、`--sandbox` 但不是 git 仓库）
 */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const argv = process.argv.slice(2);
const json = hasFlag(argv, '--json');
const useSandbox = hasFlag(argv, '--sandbox');
const autoApply = hasFlag(argv, '--apply');
const requested = resolveWorkspace(argv);

// --json 下 stdout 是数据通道，所有人类可读的噪音让给 stderr
if (json) process.env.GB_LLM_QUIET = '1';

let sandbox: Sandbox | undefined;
if (useSandbox) {
  try {
    sandbox = createSandbox(requested);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(EXIT_USAGE);
  }
  console.error(`[Glass-Box] 隔离副本: ${sandbox.dir}`);
  console.error(`[Glass-Box] 分支 ${sandbox.branch}（从 HEAD 出发，你未提交的改动不在里面）`);
}
const workspace = sandbox?.dir ?? requested;

// 审批者：真实终端 -> 交互问 y/N；非交互 -> 按 GB_APPROVE 决定
function pickApprover(): Approver {
  // --json 意味着"被程序调用"，即使挂在 TTY 上也不该停下来等人敲 y
  if (process.stdin.isTTY && !json) return new InteractiveApprover();
  const mode = process.env.GB_APPROVE;
  if (mode === 'all') return new AutoApprover({ approveConfirm: true, approveDangerous: true });
  if (mode === 'none') return new AutoApprover({ approveConfirm: false, approveDangerous: false });
  return new AutoApprover({ approveConfirm: true, approveDangerous: false });
}

const app = buildApp({ workspace, approver: pickApprover() });
const emit = (obj: unknown): void => console.log(JSON.stringify(obj));

// 先订阅，再 init（保证 session.started / plugin.loaded / skill.available 不丢）
// 渲染逻辑和 replay.ts 共用 formatEvent：回放出来的和当时看到的必须一致
let lastSummary = { created: 0, edited: 0, ran: 0, other: 0 };
app.wire.subscribe((ev) => {
  if (ev.type === 'activity.updated') lastSummary = ev.summary;
  if (json) {
    // 事件已经过图片脱敏（redactImages），可以整条吐出去
    emit(ev);
    return;
  }
  for (const l of formatEvent(ev)) console.log(l);
});

app.init();
// 外部工具服务器（.glassbox/mcp.json）。没配就是零成本的一次 existsSync
await app.initMcp();

// 支持多回合：用 ";;" 分隔，可演示上下文压缩
const rest = stripFlags(argv, ['--workspace', '-C'], ['--json', '--sandbox', '--apply']);
const input = rest.join(' ') || 'echo 你好世界';

const replies: string[] = [];
let failure: string | undefined;
for (const turn of parseTurns(input)) {
  try {
    const messages = await app.session.ask(turn);
    const reply = messages.at(-1)?.content ?? '';
    replies.push(typeof reply === 'string' ? reply : JSON.stringify(reply));
    if (!json) console.log('最终回复:', reply, '\n');
  } catch (e) {
    failure = (e as Error).message;
    break;
  }
}

/** 副本跑完的收尾：给 diff、按需合入。返回要塞进 --json result 的那一段 */
async function settleSandbox(box: Sandbox): Promise<Record<string, unknown>> {
  const changed = changedFiles(box);
  if (changed.length === 0) {
    // 一个字都没改就没有留着的价值，顺手清掉，不给 git worktree list 留垃圾
    removeSandbox(box);
    if (!json) console.log('\n隔离副本里没有任何改动，已清理（这次的会话日志随副本一起没了）。');
    return { dir: box.dir, branch: box.branch, changed: [], applied: false, patch: '', removed: true };
  }

  const patch = sandboxPatch(box);
  if (!json) {
    console.log(`\n隔离副本改了 ${changed.length} 个文件：`);
    console.log(patchStat(box));
  }

  // --json 从不自动合入：机器读到 patch 之后怎么处理该由调用方决定
  let applied = false;
  let applyError: string | undefined;
  const wants = autoApply || (!json && process.stdin.isTTY && (await confirmApply()));
  if (wants) {
    const r = applyPatch(box, patch);
    applied = r.ok;
    if (!r.ok) applyError = r.error;
  }

  if (!json) {
    if (applied) {
      console.log('已合入到你的工作树（只动工作树，没有提交）。不满意就 git checkout -- .');
    } else if (applyError !== undefined) {
      console.error(`补丁没打上：${applyError}`);
    } else {
      console.log('没有合入。');
    }
    // 副本要么还留着 diff 要留着看，要么刚合入但会话日志还在里面——
    // 两种情况都得把"在哪、怎么看、怎么删"说清楚，不然它就成了 worktree 列表里的垃圾
    console.log(`\n副本: ${box.dir}`);
    if (!applied) console.log(`  看完整 diff:  git -C ${box.dir} diff --cached HEAD`);
    if (!applied) console.log(`  手动合入:     git -C ${box.dir} diff --cached HEAD | git apply --index`);
    console.log(`  用完删掉:     git worktree remove --force ${box.dir} && git branch -D ${box.branch}`);
  }
  if (applyError !== undefined) failure ??= `补丁没打上：${applyError}`;
  return { dir: box.dir, branch: box.branch, changed, applied, patch, applyError, removed: false };
}

async function confirmApply(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('把这些改动合入你的工作树吗？[y/N] ');
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

const sandboxInfo = sandbox ? await settleSandbox(sandbox) : undefined;

if (json) {
  emit({
    type: 'result',
    ok: failure === undefined,
    error: failure,
    replies,
    activity: lastSummary,
    sessionId: app.journal.sessionId,
    journal: app.journal.path,
    ...(sandboxInfo ? { sandbox: sandboxInfo } : {}),
  });
} else {
  if (failure !== undefined) console.error('执行失败:', failure);
  console.log('本次活动轨迹汇总:', formatSummary(lastSummary));
  console.log('会话日志:', app.journal.path);
}

process.exit(failure === undefined ? EXIT_OK : EXIT_FAILED);

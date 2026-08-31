import type { Plugin } from '../engine/plugin.ts';
import { safeAssess, type Approver, type Tool, type WireEvent } from '../engine/types.ts';
import { Wire } from '../engine/wire.ts';
import { ToolRegistry } from '../engine/toolRegistry.ts';
import { Loop, type Llm } from '../engine/loop.ts';
import { AutoApprover } from '../engine/approval.ts';
import { fsPlugin } from './fsPlugin.ts';
import { searchPlugin } from './searchPlugin.ts';
import { webPlugin } from './webPlugin.ts';
import { loadPlugins } from '../engine/plugin.ts';

/**
 * subagent 插件：提供 delegate 工具。
 * 把一个子任务下放给一个「上下文隔离、工具受限」的子 agent，
 * 子 agent 有自己的 Wire（不污染主时间线），跑完把结果回给主 agent。
 * 这是 Claude Code Task / AgentSwarm 的极简版。
 *
 * 两种模式：
 * - **只读**（默认）：read / glob / grep / fetch。查清一件事就回来。
 *   审批由子 agent 内部的 AutoApprover 处理（confirm 放行、dangerous 拒绝），
 *   因为只读工具里根本没有能造成损失的操作。
 * - **可写**（`write: true`）：额外拿到 write_file / edit_file，能真的改代码。
 *   审批**必须交回父级的 Approver**——见下面 pickApprover 的说明。
 *
 * llm 由父级注入：子 agent 必须和主 agent 用同一个模型，
 * 否则真实模型模式下会得到一个"没有智能"的子 agent。
 */

/** 只读子 agent 的步数上限：它只负责查清一件事，不该在里面长跑 */
const READONLY_STEPS = 6;
/** 可写子 agent 要读、要改、要复核，6 步不够用 */
const WRITE_STEPS = 12;

function steps(write: boolean): number {
  const raw = Number(process.env.GB_SUB_MAX_STEPS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return write ? WRITE_STEPS : READONLY_STEPS;
}

const READONLY_BRIEF =
  '你现在是一个只读子 agent：只能使用 read（读文件）、glob（找文件）、grep（搜内容）、fetch（抓网页）。' +
  '不能写文件、不能执行命令、不能联网搜索、也不能再 delegate。查清事实后直接给出结论。';

const WRITE_BRIEF =
  '你现在是一个可写子 agent：能用 read（读文件）、glob（找文件）、grep（搜内容）、write（写文件）、edit（精确编辑）。' +
  '不能执行命令、不能联网、也不能再 delegate。' +
  '每一次写入都会向人请求确认，所以动手前先读清楚现状，改动要小而准；' +
  '被拒绝就停下来把原因报回去，不要换个写法反复试。做完简要说明改了哪些文件。';

export function subagentPlugin(workspace: string, llm: Llm, parentApprover?: Approver): Plugin {
  return {
    name: 'subagent',
    setup(ctx) {
      const parentWire = ctx.wire;

      /**
       * 子 agent 用谁的审批者。
       *
       * 只读子 agent 用自己的 AutoApprover 就够了——它手里没有能造成损失的工具，
       * 唯一会被评为 dangerous 的是"读工作区外的文件"，而 AutoApprover 正好拒绝它。
       *
       * 可写子 agent **必须用父级的 Approver**，否则 `delegate` 就成了一条绕过审批的通道：
       * 「delegate: 把 package.json 的 test 脚本改掉」→ 子 agent 内部 AutoApprover
       * 自动放行 confirm → 写成了，人全程不知道。前面所有的分级、硬拒绝、
       * 关键配置文件保护都会被这一条抵消掉。
       */
      const pickApprover = (write: boolean): Approver =>
        write && parentApprover
          ? parentApprover
          : new AutoApprover({ approveConfirm: true, approveDangerous: false });

      const delegate: Tool = {
        name: 'delegate',
        /**
         * 只读子任务之间没有相互影响，可以同时跑——模型一次派三个"去查清 X"是常态，
         * 排队等于白等。可写的那些走不到并行：它们 assess 是 confirm，
         * 而并行的门槛之一就是"这一批一个都不需要审批"（否则几个弹窗同时冒出来，
         * 人不知道自己在批哪一个）。这条规则不用为 delegate 开特例，自然就对了。
         */
        parallelSafe: true,
        description:
          '把一个子任务下放给隔离的子 agent，返回其结论。' +
          '默认只读（搜索/读取）；传 write: true 让它能改文件（每次写入仍会向人确认）。' +
          '多个只读子任务可以在同一步里一起派出去，它们会并行执行',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: '交给子 agent 的子任务描述，要自带足够的上下文' },
            write: { type: 'boolean', description: '是否允许它写文件（默认 false，只读）' },
          },
          required: ['task'],
        },
        assess(args) {
          if (args.write !== true) return safeAssess();
          // 可写子 agent 值得让人看一眼再放出去：它接下来会自己决定改哪些文件。
          // 具体每一次写入还会各自弹一次审批，这里问的是"要不要把这件事交给它"
          return {
            level: 'confirm',
            summary: `派一个可写子 agent 去做: ${String(args.task ?? '')}`,
            reason: '它能改文件；每次写入仍会单独向你确认，但任务范围由它自己拆',
          };
        },
        async run(args) {
          const task = String(args.task ?? '');
          if (!task.trim()) return { ok: false, content: 'delegate 需要 task' };
          const write = args.write === true;

          // 子 agent：独立 Wire + 受限工具
          // 给 fetch 不给 search：它只该读父 agent 已经定位到的地址，不该自己去发散搜索
          const childWire = new Wire();
          const childTools = new ToolRegistry();
          loadPlugins(
            [
              fsPlugin({ readOnly: !write }),
              searchPlugin(),
              // 可写子 agent 不给联网：能改代码又能拉外部内容，等于一条把外部输入
              // 直接写进仓库的通道
              ...(write ? [] : [webPlugin({ fetchOnly: true })]),
            ],
            { tools: childTools, wire: childWire, workspace },
          );
          const child = new Loop(childWire, childTools, llm, pickApprover(write), {
            maxSteps: steps(write),
          });

          parentWire.emit({
            type: 'subagent.start',
            task,
            tools: childTools.list().map((t) => t.name),
            write,
            ts: Date.now(),
          });

          const msgs = await child.runTurn(task, [
            // 子 agent 的提示词是全局常量，会列出 delegate 等它其实没有的工具；
            // 这里显式告知它的能力边界，免得它白白浪费步数去调用不存在的工具。
            { role: 'system', content: write ? WRITE_BRIEF : READONLY_BRIEF },
          ]);

          const history = childWire.history();
          const toolsUsed = history
            .filter((e: WireEvent): e is Extract<WireEvent, { type: 'tool.call' }> => e.type === 'tool.call')
            .map((e) => e.call.name);
          // 可写子 agent 改了哪些文件，要冒泡到父级：主 agent 得知道现状变了，
          // 不能拿着改动前的印象继续往下做
          const changed = [
            ...new Set(
              history.flatMap((e: WireEvent) => {
                if (e.type !== 'tool.result') return [];
                const m = e.result.meta;
                if (m?.action !== 'created' && m?.action !== 'edited') return [];
                return typeof m.path === 'string' ? [m.path] : [];
              }),
            ),
          ];
          const result = msgs.at(-1)?.content ?? '';

          parentWire.emit({
            type: 'subagent.end',
            result,
            toolsUsed,
            steps: toolsUsed.length,
            changed,
            ts: Date.now(),
          });

          const files = changed.length ? `\n改动的文件：${changed.join(', ')}` : '';
          return {
            ok: true,
            content: `子 agent 完成（用了 ${toolsUsed.join(', ') || '无'}）：${result}${files}`,
            meta: { action: 'delegated', command: task, added: toolsUsed.length },
          };
        },
      };

      ctx.tools.register(delegate);
    },
  };
}

import type { Wire } from './wire.ts';
import type { ToolRegistry } from './toolRegistry.ts';

/** 插件在 setup 时能拿到的东西：工具登记处、事件总线、工作区根目录 */
export interface PluginContext {
  tools: ToolRegistry;
  wire: Wire;
  workspace: string;
}

/**
 * Plugin：能力的封装单元。
 * 一个插件在 setup 里把自己的工具注册进 ToolRegistry，也可以订阅 wire 事件。
 * 引擎核心完全不认识具体插件——这就是 deepseek-harness “everything is a plugin” 的极简版。
 */
export interface Plugin {
  name: string;
  setup(ctx: PluginContext): void;
}

/** 依次加载插件，并广播“某插件加载了、带来了哪些工具”，让加载过程也可观测。 */
export function loadPlugins(plugins: Plugin[], ctx: PluginContext): void {
  for (const plugin of plugins) {
    const before = new Set(ctx.tools.list().map((t) => t.name));
    plugin.setup(ctx);
    const added = ctx.tools.list().map((t) => t.name).filter((n) => !before.has(n));
    ctx.wire.emit({ type: 'plugin.loaded', name: plugin.name, tools: added, ts: Date.now() });
  }
}

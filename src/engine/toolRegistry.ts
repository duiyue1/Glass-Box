import type { Tool } from './types.ts';

/**
 * ToolRegistry：工具登记处。
 * 引擎本身不认识任何具体工具，工具都在这里“报到”。
 * Step2 引入插件后，插件会把自己的工具注册进来——引擎代码一行都不用改。
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}

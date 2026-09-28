import type { ConfigOption } from "../sdk";

export type OptionsProvider = () => ConfigOption[] | Promise<ConfigOption[]>;

/**
 * 动态选项提供器注册表：连接、数据库、脚本等下拉的来源。
 * 新增一种来源只要注册一个 Provider，节点与 UI 无需改动。
 */
export class ProviderRegistry {
  private providers = new Map<string, OptionsProvider>();

  register(id: string, provider: OptionsProvider): void {
    this.providers.set(id, provider);
  }

  registerAll(entries: Record<string, OptionsProvider>): void {
    for (const [id, provider] of Object.entries(entries))
      this.register(id, provider);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  async resolve(id: string): Promise<ConfigOption[]> {
    const provider = this.providers.get(id);

    if (!provider)
      return [];

    return provider();
  }
}

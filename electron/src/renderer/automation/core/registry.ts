import type { NodeDefinition, NodeManifest } from "../sdk";

/**
 * 节点注册表：唯一知道「有哪些节点」的地方。
 * 内置节点与外部节点包都只是往这里注册，引擎和 UI 一律通过它取。
 */
export class NodeRegistry {
  private nodes = new Map<string, NodeDefinition>();

  register(definition: NodeDefinition): void {
    const type = definition.manifest.type;

    if (this.nodes.has(type))
      throw new Error(`节点类型重复注册：${type}`);

    this.nodes.set(type, definition);
  }

  registerAll(definitions: NodeDefinition[]): void {
    for (const definition of definitions)
      this.register(definition);
  }

  /** 热插拔用：允许覆盖同名节点（外部插件升级场景） */
  replace(definition: NodeDefinition): void {
    this.nodes.set(definition.manifest.type, definition);
  }

  get(type: string | undefined): NodeDefinition | undefined {
    return type ? this.nodes.get(type) : undefined;
  }

  has(type: string): boolean {
    return this.nodes.has(type);
  }

  all(): NodeDefinition[] {
    return [...this.nodes.values()];
  }

  manifests(): NodeManifest[] {
    return this.all().map(definition => definition.manifest);
  }

  triggers(): NodeDefinition[] {
    return this.all().filter(definition => definition.manifest.trigger);
  }

  categories(): string[] {
    return [...new Set(this.all().map(definition => definition.manifest.category))];
  }

  clear(): void {
    this.nodes.clear();
  }
}

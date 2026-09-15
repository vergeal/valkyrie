import type { SchemaNode } from "../api";

/** 按 id 在对象树里找节点（树只缓存已加载的层级） */
export function findTreeNode(treeRoot: SchemaNode, treeChildren: Record<string, SchemaNode[]>, id: string): SchemaNode | null {
  if (treeRoot.id === id)
    return treeRoot;

  for (const children of Object.values(treeChildren))
    for (const child of children)
      if (child.id === id)
        return child;

  return null;
}

export function parentTreeNode(treeRoot: SchemaNode, treeChildren: Record<string, SchemaNode[]>, id: string): SchemaNode | null {
  const entry = Object.entries(treeChildren).find(([, children]) => children.some(child => child.id === id));

  return entry ? findTreeNode(treeRoot, treeChildren, entry[0]) : null;
}

/** 树节点属于哪个连接：沿父链找到 CONNECTION 节点 */
export function connectionOfNode(
  node: SchemaNode | null | undefined,
  treeRoot: SchemaNode,
  treeChildren: Record<string, SchemaNode[]>
): string | undefined {
  for (let current: SchemaNode | null = node ?? null, guard = 0; current && guard < 16; guard++) {
    if (current.kind === "CONNECTION")
      return current.label;

    current = parentTreeNode(treeRoot, treeChildren, current.id);
  }

  return undefined;
}

/** 模式排序权重：public 最前，系统模式最后，其余保持原顺序 */
export function schemaRank(name: string): number {
  if (name === "public")
    return 0;

  return /^(pg_|information_schema)/.test(name) ? 2 : 1;
}

/** 选中节点 → 执行上下文：连接名 + 数据库 + 模式 */
export function selectionContext(
  activeNode: SchemaNode | null,
  catalogOptions: SchemaNode[],
  treeRoot: SchemaNode,
  treeChildren: Record<string, SchemaNode[]>
): { connection?: string; catalog?: string; schema?: string } {
  const fallbackCatalog = catalogOptions[0]?.label;

  if (!activeNode)
    return { catalog: fallbackCatalog };

  const connection = connectionOfNode(activeNode, treeRoot, treeChildren);

  const catalog = activeNode.kind === "CATALOG" ? activeNode.label : activeNode.catalog ?? fallbackCatalog;
  const schema = activeNode.kind === "SCHEMA" ? activeNode.label : activeNode.schema;

  return { connection, catalog, schema };
}

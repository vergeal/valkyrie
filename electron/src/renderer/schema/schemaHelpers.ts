import type { SchemaNode } from "../api";

/*
 * 树查找索引：id → 节点、id → 父 id。
 * 以前每次查找都遍历全部子节点，connectionOfNode 还要沿父链反复查找（O(深度 × 节点数)）。
 * 这里按 treeChildren 对象缓存一份索引，对象换了（树更新）才重建，查找变 O(1)。
 */
interface TreeIndex {
  nodeOf: Map<string, SchemaNode>;
  parentOf: Map<string, string>;
}

const treeIndexCache = new WeakMap<Record<string, SchemaNode[]>, TreeIndex>();

function treeIndexOf(treeRoot: SchemaNode, treeChildren: Record<string, SchemaNode[]>): TreeIndex {
  const cached = treeIndexCache.get(treeChildren);

  if (cached)
    return cached;

  const nodeOf = new Map<string, SchemaNode>();
  const parentOf = new Map<string, string>();

  nodeOf.set(treeRoot.id, treeRoot);

  for (const [parentId, children] of Object.entries(treeChildren)) {
    for (const child of children) {
      nodeOf.set(child.id, child);
      parentOf.set(child.id, parentId);
    }
  }

  const index = { nodeOf, parentOf };
  treeIndexCache.set(treeChildren, index);

  return index;
}

/** 按 id 在对象树里找节点（树只缓存已加载的层级） */
export function findTreeNode(treeRoot: SchemaNode, treeChildren: Record<string, SchemaNode[]>, id: string): SchemaNode | null {
  return treeIndexOf(treeRoot, treeChildren).nodeOf.get(id) ?? null;
}

export function parentTreeNode(treeRoot: SchemaNode, treeChildren: Record<string, SchemaNode[]>, id: string): SchemaNode | null {
  const parentId = treeIndexOf(treeRoot, treeChildren).parentOf.get(id);

  return parentId ? findTreeNode(treeRoot, treeChildren, parentId) : null;
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

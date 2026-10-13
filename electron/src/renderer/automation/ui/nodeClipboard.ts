import type { Edge, Node } from "reactflow";
import { nextEdgeId, nextNodeId } from "../core";
import type { AutomationNodeData } from "./flowAdapter";
import { cloneEdges, cloneNodes } from "./useGraphHistory";

/** 画布内部的复制缓冲区：节点 + 两端都在选区内的连线 */
export interface GraphClip {
  nodes: Node<AutomationNodeData>[];
  edges: Edge[];
}

/** 粘贴时的默认偏移，避免和原节点完全重叠 */
export const PASTE_OFFSET = { x: 36, y: 36 };

/** 复制选中节点：只带上「两端都在选区里」的连线，粘出来的子图才自洽 */
export function clipOf(nodes: Node<AutomationNodeData>[], edges: Edge[]): GraphClip | null {
  const picked = nodes.filter(node => node.selected);

  if (picked.length === 0)
    return null;

  const ids = new Set(picked.map(node => node.id));

  return {
    nodes: cloneNodes(picked.map(node => ({ ...node, selected: false }))),
    edges: cloneEdges(edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)))
  };
}

/** 粘贴：换新 id、整体平移一点，并只选中新贴进来的节点 */
export function pasteClip(clip: GraphClip, offset = PASTE_OFFSET): GraphClip {
  const ids = new Map<string, string>();

  for (const node of clip.nodes)
    ids.set(node.id, nextNodeId());

  const nodes = clip.nodes.map(node => ({
    ...cloneNodes([node])[0],
    id: ids.get(node.id) as string,
    position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
    selected: true
  }));

  const edges = clip.edges.map(edge => ({
    ...cloneEdges([edge])[0],
    id: nextEdgeId(),
    source: ids.get(edge.source) as string,
    target: ids.get(edge.target) as string,
    selected: false
  }));

  return { nodes, edges };
}

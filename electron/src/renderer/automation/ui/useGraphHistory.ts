import { useCallback, useRef, useState } from "react";
import type { Edge, Node } from "reactflow";
import type { AutomationNodeData } from "./flowAdapter";

export interface GraphSnapshot {
  nodes: Node<AutomationNodeData>[];
  edges: Edge[];
}

/** 同一个字段连续输入只留第一条快照的合并窗口 */
const MERGE_WINDOW = 700;
/** 最多回退多少步 */
const LIMIT = 120;

/** 节点深拷贝：位置与配置各拷一层，撤销回去的对象不会被后续编辑改到 */
export function cloneNodes(nodes: Node<AutomationNodeData>[]): Node<AutomationNodeData>[] {
  return nodes.map(node => ({
    ...node,
    position: { ...node.position },
    data: { nodeType: node.data.nodeType, config: { ...node.data.config } }
  }));
}

export function cloneEdges(edges: Edge[]): Edge[] {
  return edges.map(edge => ({ ...edge, style: edge.style ? { ...edge.style } : edge.style }));
}

export interface GraphHistory {
  canUndo: boolean;
  canRedo: boolean;
  /** 变更前压一份快照；mergeKey 相同且间隔很短时只留第一条（连续输入合并成一步） */
  remember: (snapshot: GraphSnapshot, mergeKey?: string) => void;
  undo: (current: GraphSnapshot) => GraphSnapshot | null;
  redo: (current: GraphSnapshot) => GraphSnapshot | null;
  reset: () => void;
}

/**
 * 画布撤销 / 重做：撤销时把当前状态换到重做栈，两边都是整图快照。
 * 只做栈，不碰 reactflow，节点 / 连线的替换由调用方完成。
 */
export function useGraphHistory(): GraphHistory {
  const past = useRef<GraphSnapshot[]>([]);
  const future = useRef<GraphSnapshot[]>([]);
  const merge = useRef<{ key: string; at: number } | null>(null);
  /* 只用来刷新 canUndo / canRedo（栈本身在 ref 里，不进状态避免每次变更都重渲全画布） */
  const [, setVersion] = useState(0);

  const remember = useCallback((snapshot: GraphSnapshot, mergeKey?: string) => {
    const now = Date.now();

    if (mergeKey && merge.current?.key === mergeKey && now - merge.current.at < MERGE_WINDOW) {
      merge.current.at = now;
      future.current = [];
      return;
    }

    merge.current = mergeKey ? { key: mergeKey, at: now } : null;
    past.current.push(snapshot);

    if (past.current.length > LIMIT)
      past.current.shift();

    future.current = [];
    setVersion(value => value + 1);
  }, []);

  const undo = useCallback((current: GraphSnapshot) => {
    const previous = past.current.pop();

    if (!previous)
      return null;

    future.current.push(current);
    merge.current = null;
    setVersion(value => value + 1);

    return previous;
  }, []);

  const redo = useCallback((current: GraphSnapshot) => {
    const next = future.current.pop();

    if (!next)
      return null;

    past.current.push(current);
    merge.current = null;
    setVersion(value => value + 1);

    return next;
  }, []);

  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    merge.current = null;
    setVersion(value => value + 1);
  }, []);

  return {
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    remember,
    undo,
    redo,
    reset
  };
}

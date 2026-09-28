import type { NodeRegistry } from "./registry";
import type { NodeDefinition, WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from "../sdk";
import { emptyWorkflowGraph } from "../sdk";

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

export function nextNodeId(): string {
  return nextId("node");
}

export function nextEdgeId(): string {
  return nextId("edge");
}

export function createNode(type: string, position: { x: number; y: number }): WorkflowGraphNode {
  return { id: nextNodeId(), type, position, config: {} };
}

/** 归一化签名：忽略节点/连线顺序与画布视图，用于判断是否有未保存修改 */
export function graphSignature(graph: WorkflowGraph | null | undefined): string {
  if (!graph)
    return "";

  const nodes = [...graph.nodes]
    .map(node => ({ id: node.id, type: node.type, x: Math.round(node.position.x), y: Math.round(node.position.y), config: node.config }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const edges = [...graph.edges]
    .map(edge => ({ id: edge.id, s: edge.source, sh: edge.sourceHandle ?? null, t: edge.target, th: edge.targetHandle ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify({ nodes, edges });
}

export interface GraphIndex {
  nodes: Map<string, WorkflowGraphNode>;
  /** `${nodeId}:${handle}` → 目标节点 id（exec 线） */
  execOutgoing: Map<string, string>;
  /** `${nodeId}:${portId}` → { nodeId, handle }（data 线） */
  dataIncoming: Map<string, { nodeId: string; handle: string }>;
  triggers: string[];
}

export function indexGraph(graph: WorkflowGraph, registry: NodeRegistry): GraphIndex {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const execOutgoing = new Map<string, string>();
  const dataIncoming = new Map<string, { nodeId: string; handle: string }>();
  const triggers: string[] = [];

  for (const node of graph.nodes) {
    const definition = registry.get(node.type);

    if (definition?.manifest.trigger)
      triggers.push(node.id);
  }

  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);

    if (!source || !target)
      continue;

    const handle = edge.sourceHandle ?? "";
    const port = registry.get(source.type)?.manifest.outputs.find(item => item.id === handle);
    /* 端口定义优先；找不到定义时退回命名约定 */
    const isExec = port ? port.kind === "exec" : handle === "" || handle.startsWith("exec") || handle.startsWith("out-");

    if (isExec)
      execOutgoing.set(`${edge.source}:${handle}`, edge.target);
    else
      dataIncoming.set(`${edge.target}:${edge.targetHandle ?? ""}`, { nodeId: edge.source, handle });
  }

  return { nodes, execOutgoing, dataIncoming, triggers };
}

export interface GraphIssue {
  nodeId?: string;
  level: "error" | "warning";
  message: string;
}

/** 设计期校验：缺触发器、未连连接、必填项缺失、类型不匹配、不可达节点 */
export function validateGraph(graph: WorkflowGraph, registry: NodeRegistry): GraphIssue[] {
  const issues: GraphIssue[] = [];

  for (const node of graph.nodes) {
    const definition = registry.get(node.type);

    if (!definition) {
      issues.push({ nodeId: node.id, level: "error", message: `未知节点类型：${node.type}` });
      continue;
    }

    for (const field of definition.manifest.config) {
      if (field.required && field.default === undefined && (node.config[field.key] === undefined || node.config[field.key] === ""))
        issues.push({ nodeId: node.id, level: "warning", message: `「${field.label}」未填写` });
    }
  }

  const { triggers, nodes } = indexGraph(graph, registry);

  if (graph.nodes.length > 0 && triggers.length === 0)
    issues.push({ level: "error", message: "缺少触发器节点，工作流无法运行" });

  const reachable = new Set<string>();
  const stack = [...triggers];

  while (stack.length > 0) {
    const id = stack.pop() as string;

    if (reachable.has(id))
      continue;

    reachable.add(id);

    for (const edge of graph.edges) {
      if (edge.source !== id || !edge.sourceHandle)
        continue;

      const port = registry.get(nodes.get(edge.source)?.type ?? "")?.manifest.outputs.find(item => item.id === edge.sourceHandle);

      if (port?.kind === "exec" && nodes.has(edge.target))
        stack.push(edge.target);
    }
  }

  for (const node of graph.nodes) {
    const definition = registry.get(node.type);

    if (!definition?.manifest.trigger && !reachable.has(node.id))
      issues.push({ nodeId: node.id, level: "warning", message: "该节点未接入执行流，不会被执行" });
  }

  return issues;
}

/** 找到第一个触发器作为运行入口 */
export function findTrigger(graph: WorkflowGraph, registry: NodeRegistry): WorkflowGraphNode | null {
  for (const node of graph.nodes) {
    if (registry.get(node.type)?.manifest.trigger)
      return node;
  }

  return null;
}

export function defaultGraph(): WorkflowGraph {
  return emptyWorkflowGraph();
}

export function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  return JSON.parse(JSON.stringify(graph)) as WorkflowGraph;
}

export function edgeTarget(index: GraphIndex, nodeId: string, handle: string): string | undefined {
  return index.execOutgoing.get(`${nodeId}:${handle}`);
}

export type { NodeDefinition, WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode };

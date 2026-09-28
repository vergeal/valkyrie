import type { Edge, Node, Viewport } from "reactflow";
import type { WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from "../sdk";
import { nextEdgeId, nextNodeId } from "../core";

export const AUTOMATION_NODE_TYPE = "automation";
export const AUTOMATION_DND_TYPE = "application/valkyrie-automation-node";

export interface AutomationNodeData {
  nodeType: string;
  config: Record<string, unknown>;
}

export function toFlowNodes(graph: WorkflowGraph | null | undefined): Node<AutomationNodeData>[] {
  return (graph?.nodes ?? []).map(node => ({
    id: node.id,
    type: AUTOMATION_NODE_TYPE,
    position: node.position,
    data: { nodeType: node.type, config: { ...node.config } }
  }));
}

export function toFlowEdges(graph: WorkflowGraph | null | undefined): Edge[] {
  return (graph?.edges ?? []).map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    type: "smoothstep",
    animated: true,
    style: { strokeWidth: 2 }
  }));
}

export function toGraph(nodes: Node<AutomationNodeData>[], edges: Edge[], viewport?: Viewport): WorkflowGraph {
  const graphNodes: WorkflowGraphNode[] = nodes.map(node => ({
    id: node.id,
    type: node.data.nodeType,
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    config: { ...node.data.config }
  }));

  const graphEdges: WorkflowGraphEdge[] = edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null
  }));

  return { version: 1, viewport, nodes: graphNodes, edges: graphEdges };
}

export function createFlowNode(nodeType: string, position: { x: number; y: number }): Node<AutomationNodeData> {
  return {
    id: nextNodeId(),
    type: AUTOMATION_NODE_TYPE,
    position,
    data: { nodeType, config: {} }
  };
}

export function createFlowEdge(source: string, sourceHandle: string, target: string, targetHandle: string): Edge {
  return {
    id: nextEdgeId(),
    source,
    sourceHandle,
    target,
    targetHandle,
    type: "smoothstep",
    animated: true,
    style: { strokeWidth: 2 }
  };
}

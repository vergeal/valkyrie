import type { NodeRegistry } from "./registry";
import type { WorkflowGraph } from "../sdk";
import { catalogOf, connectionNameOf, schemaOf } from "../sdk";

/** 节点上游提供的执行上下文（设计期静态推断出来的） */
export interface HandleContext {
  connection?: string;
  catalog?: string;
  schema?: string;
}

/**
 * 设计期静态推断某个节点能拿到什么执行上下文：
 * 沿着数据线往上找「打开连接 / 打开数据库 / 打开模式」这些节点，读出它们的连接名、
 * 库名、模式名。用于「打开查询脚本」按上游过滤可选脚本。
 */
export function resolveNodeContext(graph: WorkflowGraph, registry: NodeRegistry, nodeId: string): HandleContext {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const dataIncoming = new Map<string, { nodeId: string; handle: string }>();

  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);

    if (!source || !edge.targetHandle)
      continue;

    const port = registry.get(source.type)?.manifest.outputs.find(item => item.id === (edge.sourceHandle ?? ""));
    const isExec = port ? port.kind === "exec" : false;

    if (!isExec)
      dataIncoming.set(`${edge.target}:${edge.targetHandle}`, { nodeId: edge.source, handle: edge.sourceHandle ?? "" });
  }

  const valueOfOutput = (id: string, handle: string): unknown => {
    const node = nodes.get(id);

    if (!node)
      return undefined;

    const config = node.config ?? {};

    switch (node.type) {
      case "open-connection":
        return config.connection;

      case "open-database":
        return {
          connection: valueOfInput(id, "connection") ?? config.connection,
          catalog: config.database
        };

      case "open-schema": {
        const database = valueOfInput(id, "database");

        return {
          connection: connectionNameOf(database) ?? valueOfInput(id, "connection"),
          catalog: catalogOf(database),
          schema: config.schema
        };
      }

      default:
        return undefined;
    }
  };

  const valueOfInput = (id: string, portId: string): unknown => {
    const incoming = dataIncoming.get(`${id}:${portId}`);

    return incoming ? valueOfOutput(incoming.nodeId, incoming.handle) : undefined;
  };

  return {
    connection: connectionNameOf(valueOfInput(nodeId, "connection"))
      ?? connectionNameOf(valueOfInput(nodeId, "database"))
      ?? connectionNameOf(valueOfInput(nodeId, "schema")),
    catalog: catalogOf(valueOfInput(nodeId, "database")) ?? catalogOf(valueOfInput(nodeId, "schema")),
    schema: schemaOf(valueOfInput(nodeId, "schema"))
  };
}

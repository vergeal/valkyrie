import type { NodeDefinition, PortDefinition } from "../sdk";
import type { NodeRegistry } from "../core";

export type HandleType = "source" | "target";

export function portOf(registry: NodeRegistry, nodeType: string, handleId: string | null | undefined): PortDefinition | null {
  if (!handleId)
    return null;

  const manifest = registry.get(nodeType)?.manifest;

  if (!manifest)
    return null;

  return manifest.inputs.find(port => port.id === handleId)
    ?? manifest.outputs.find(port => port.id === handleId)
    ?? null;
}

function dataTypesMatch(a: PortDefinition, b: PortDefinition): boolean {
  if (!a.dataType || !b.dataType || a.dataType === "any" || b.dataType === "any")
    return true;

  return a.dataType === b.dataType;
}

/** 拖出这条线以后，候选节点是否有可对接的端口 */
export function compatible(definition: NodeDefinition, port: PortDefinition, handleType: HandleType): boolean {
  const manifest = definition.manifest;

  if (handleType === "source") {
    if (port.kind === "exec")
      return manifest.inputs.some(input => input.kind === "exec");

    return manifest.inputs.some(input => input.kind === "data" && dataTypesMatch(port, input));
  }

  if (port.kind === "exec")
    return manifest.outputs.some(output => output.kind === "exec");

  return manifest.outputs.some(output => output.kind === "data" && dataTypesMatch(port, output));
}

export function compatibleNodes(registry: NodeRegistry, port: PortDefinition, handleType: HandleType): NodeDefinition[] {
  return registry.all().filter(definition => compatible(definition, port, handleType));
}

/** 在候选节点上找到实际要连的端口 */
export function matchPort(definition: NodeDefinition, port: PortDefinition, handleType: HandleType): PortDefinition | null {
  const manifest = definition.manifest;

  if (handleType === "source") {
    if (port.kind === "exec")
      return manifest.inputs.find(input => input.kind === "exec") ?? null;

    return manifest.inputs.find(input => input.kind === "data" && dataTypesMatch(port, input)) ?? null;
  }

  if (port.kind === "exec")
    return manifest.outputs.find(output => output.kind === "exec") ?? null;

  return manifest.outputs.find(output => output.kind === "data" && dataTypesMatch(port, output)) ?? null;
}

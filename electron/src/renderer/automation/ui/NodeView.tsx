import { Handle, Position, type NodeProps } from "reactflow";
import type { ConfigField, ConfigOption, PortDefinition } from "../sdk";
import { renderControl } from "./controls";
import { useAutomation } from "./context";
import type { AutomationNodeData } from "./flowAdapter";

function handleClass(port: PortDefinition): string {
  if (port.kind === "exec")
    return "am-handle-exec";

  switch (port.dataType) {
    case "int":
    case "decimal":
      return "am-handle-number";
    case "string":
    case "secret":
      return "am-handle-string";
    case "bool":
      return "am-handle-bool";
    case "datetime":
      return "am-handle-datetime";
    case "array":
    case "table":
      return "am-handle-array";
    case "object":
    case "connection":
    case "database":
      return "am-handle-object";
    default:
      return "am-handle-data";
  }
}

export function AutomationNodeView({ id, data, selected }: NodeProps<AutomationNodeData>) {
  const { registry, options, setConfigValue } = useAutomation();
  const definition = registry.get(data.nodeType);

  if (!definition)
    return null;

  const manifest = definition.manifest;
  const config = data.config;

  const optionsFor = (field: ConfigField): ConfigOption[] =>
    field.optionsSource ? options[field.optionsSource] ?? [] : field.options ?? [];

  const renderPort = (port: PortDefinition) => (
    <div key={port.id} className={`am-port am-port-${port.direction}`}>
      {port.direction === "input" && (
        <Handle type="target" position={Position.Left} id={port.id} className={`am-handle ${handleClass(port)}`} />
      )}
      <span className={`am-port-label${port.kind === "exec" ? " is-exec" : ""}`}>{port.name}</span>
      {port.direction === "output" && (
        <Handle type="source" position={Position.Right} id={port.id} className={`am-handle ${handleClass(port)}`} />
      )}
    </div>
  );

  const inputs = manifest.inputs.filter(port => port.kind === "exec");
  const dataInputs = manifest.inputs.filter(port => port.kind === "data");
  const outputs = manifest.outputs;
  const inlineFields = manifest.config.filter(field => field.inline);

  return (
    <div className={`am-node${selected ? " is-selected" : ""}`}>
      <div className="am-node-header" style={{ background: manifest.color ?? "#6b7280" }}>
        <span className="am-node-title">{manifest.title}</span>
        {manifest.risk === "destructive" && <span className="am-node-risk">危险</span>}
      </div>

      <div className="am-node-body">
        <div className="am-node-columns">
          <div className="am-node-column">
            {inputs.map(renderPort)}
            {dataInputs.map(renderPort)}
          </div>
          <div className="am-node-column is-right">
            {outputs.map(renderPort)}
          </div>
        </div>

        {inlineFields.length > 0 && (
          <div className="am-node-inline">
            {inlineFields.map(field => (
              <label key={field.key} className="am-inline-field">
                <span className="am-inline-label">{field.label}</span>
                {renderControl(field, config[field.key], optionsFor(field), value => setConfigValue(id, field.key, value))}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

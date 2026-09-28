import type { Node } from "reactflow";
import { ERROR_POLICY_FIELDS } from "../core";
import { Icon } from "../../ui/icons";
import { renderControl } from "./controls";
import { useAutomation } from "./context";
import type { AutomationNodeData } from "./flowAdapter";

export function Inspector({ node, onDelete }: { node: Node<AutomationNodeData> | null; onDelete: (id: string) => void }) {
  const { registry, options, setConfigValue } = useAutomation();

  if (!node) {
    return (
      <aside className="am-inspector">
        <div className="am-inspector-title">属性</div>
        <div className="am-empty">在画布上选择一个节点</div>
      </aside>
    );
  }

  const definition = registry.get(node.data.nodeType);

  if (!definition) {
    return (
      <aside className="am-inspector">
        <div className="am-inspector-title">属性</div>
        <div className="am-empty">未知节点类型：{node.data.nodeType}</div>
      </aside>
    );
  }

  const manifest = definition.manifest;
  const fields = manifest.trigger || manifest.pure ? manifest.config : [...manifest.config, ...ERROR_POLICY_FIELDS];

  return (
    <aside className="am-inspector">
      <div className="am-inspector-head">
        <span className="am-inspector-dot" style={{ background: manifest.color ?? "#6b7280" }} />
        <span className="am-inspector-title">{manifest.title}</span>
        <button type="button" className="am-icon-btn" title="删除节点" onClick={() => onDelete(node.id)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      {manifest.description && <div className="am-inspector-desc">{manifest.description}</div>}

      <div className="am-inspector-fields">
        {fields.length === 0 && <div className="am-empty">该节点无需配置</div>}
        {fields.map(field => {
          const resolved = field.optionsSource ? options[field.optionsSource] ?? [] : field.options ?? [];
          const control = renderControl(field, node.data.config[field.key], resolved, value => setConfigValue(node.id, field.key, value));

          return (
            <div className="am-field" key={field.key}>
              {field.type !== "checkbox" && (
                <label className="am-field-label">
                  {field.label}
                  {field.required && <span className="am-required">*</span>}
                </label>
              )}
              {control}
              {field.description && <div className="am-field-desc">{field.description}</div>}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

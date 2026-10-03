import { type ReactElement } from "react";
import { chooseOpenPath } from "../../api";
import type { ConfigField, ConfigOption } from "../sdk";

export interface ControlProps {
  field: ConfigField;
  value: unknown;
  options: ConfigOption[];
  onChange: (value: unknown) => void;
}

export type ControlComponent = (props: ControlProps) => ReactElement;

class ControlRegistry {
  private controls = new Map<string, ControlComponent>();

  register(type: string, component: ControlComponent): void {
    this.controls.set(type, component);
  }

  get(type: string): ControlComponent | undefined {
    return this.controls.get(type);
  }
}

export const controlRegistry = new ControlRegistry();

function TextControl({ field, value, onChange }: ControlProps): ReactElement {
  return (
    <input
      className="am-input"
      value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
      placeholder={field.placeholder}
      onChange={event => onChange(event.target.value)}
    />
  );
}

function TextareaControl({ field, value, onChange }: ControlProps): ReactElement {
  return (
    <textarea
      className="am-input am-textarea"
      rows={field.rows ?? 3}
      value={typeof value === "string" ? value : ""}
      placeholder={field.placeholder}
      onChange={event => onChange(event.target.value)}
    />
  );
}

function CodeControl({ field, value, onChange }: ControlProps): ReactElement {
  return (
    <textarea
      className={`am-input am-textarea am-code${field.language === "sql" ? " is-sql" : ""}`}
      rows={field.rows ?? 4}
      spellCheck={false}
      value={typeof value === "string" ? value : ""}
      placeholder={field.placeholder}
      onChange={event => onChange(event.target.value)}
    />
  );
}

function NumberControl({ field, value, onChange }: ControlProps): ReactElement {
  return (
    <input
      className="am-input"
      type="number"
      value={typeof value === "number" ? value : ""}
      min={field.min}
      max={field.max}
      step={field.step}
      placeholder={field.placeholder}
      onChange={event => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
    />
  );
}

function CheckboxControl({ field, value, onChange }: ControlProps): ReactElement {
  return (
    <label className="am-checkbox">
      <input type="checkbox" checked={Boolean(value)} onChange={event => onChange(event.target.checked)} />
      <span>{field.label}</span>
    </label>
  );
}

function SelectControl({ field, value, options, onChange }: ControlProps): ReactElement {
  const current = value == null ? "" : String(value);

  return (
    <select className={`am-select${current ? "" : " is-placeholder"}`} value={current} onChange={event => onChange(event.target.value)}>
      <option value="">{field.placeholder ?? "请选择"}</option>
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

function PasswordControl({ field, value, onChange }: ControlProps): ReactElement {
  return (
    <input
      className="am-input"
      type="password"
      value={typeof value === "string" ? value : ""}
      placeholder={field.placeholder}
      onChange={event => onChange(event.target.value)}
    />
  );
}

function FileControl({ field, value, onChange }: ControlProps): ReactElement {
  return (
    <span className="am-file">
      <input
        className="am-input"
        value={typeof value === "string" ? value : ""}
        placeholder={field.placeholder ?? "选择文件"}
        onChange={event => onChange(event.target.value)}
      />
      <button
        type="button"
        className="tbtn"
        onClick={async () => {
          const picked = await chooseOpenPath({
            title: field.label,
            filters: [
              { name: "SQL 脚本", extensions: ["sql"] },
              { name: "所有文件", extensions: ["*"] }
            ]
          });

          if (picked)
            onChange(picked);
        }}
      >
        浏览…
      </button>
    </span>
  );
}

controlRegistry.register("text", TextControl);
controlRegistry.register("textarea", TextareaControl);
controlRegistry.register("number", NumberControl);
controlRegistry.register("checkbox", CheckboxControl);
controlRegistry.register("select", SelectControl);
controlRegistry.register("connection", SelectControl);
controlRegistry.register("code", CodeControl);
controlRegistry.register("password", PasswordControl);
controlRegistry.register("file", FileControl);
controlRegistry.register("keyvalue", CodeControl);

export function renderControl(field: ConfigField, value: unknown, options: ConfigOption[], onChange: (value: unknown) => void): ReactElement {
  const Control = controlRegistry.get(field.type) ?? TextControl;

  return <Control field={field} value={value} options={options} onChange={onChange} />;
}

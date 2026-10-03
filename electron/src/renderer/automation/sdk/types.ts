/**
 * 自动化 SDK：节点作者唯一需要了解的公共契约。
 * 这一层不依赖引擎、UI、宿主，是整套系统最稳定的部分。
 */

export type PortDirection = "input" | "output";
export type PortKind = "exec" | "data";

export type DataType =
  | "any"
  | "int"
  | "decimal"
  | "string"
  | "bool"
  | "datetime"
  | "object"
  | "array"
  | "table"
  | "connection"
  | "database"
  | "secret";

export interface PortDefinition {
  id: string;
  name: string;
  direction: PortDirection;
  kind: PortKind;
  dataType?: DataType;
  multiple?: boolean;
  required?: boolean;
  description?: string;
}

export type ConfigFieldType =
  | "text"
  | "textarea"
  | "number"
  | "checkbox"
  | "select"
  | "code"
  | "password"
  | "connection"
  | "file"
  | "keyvalue";

export interface ConfigOption {
  label: string;
  value: string;
  logo?: string;
}

export interface ConfigField {
  key: string;
  label: string;
  type: ConfigFieldType;
  default?: unknown;
  placeholder?: string;
  description?: string;
  required?: boolean;
  options?: ConfigOption[];
  /** 动态选项来源的 Provider id，例如 "connections" */
  optionsSource?: string;
  /** code 控件的语言（sql / json / text） */
  language?: string;
  min?: number;
  max?: number;
  step?: number;
  /** 密钥字段：日志与导出时自动打码 */
  secret?: boolean;
  /** 是否在节点卡片上内联显示（否则只在右侧属性面板编辑） */
  inline?: boolean;
  rows?: number;
}

export type NodeRisk = "read" | "write" | "destructive";

/** 节点声明：端口、配置、分类、能力依赖、风险级别，全部由节点自带 */
export interface NodeManifest {
  type: string;
  title: string;
  category: string;
  version: number;
  icon?: string;
  color?: string;
  description?: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  config: ConfigField[];
  requires?: string[];
  risk?: NodeRisk;
  /** 触发器节点：可作为工作流入入口 */
  trigger?: boolean;
  /** 纯数据节点：无 exec 线，可被数据线按需求值 */
  pure?: boolean;
}

/* ------------------------------ 工作流图 ------------------------------ */

export interface WorkflowGraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface WorkflowGraphEdge {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}

export interface WorkflowGraph {
  version: number;
  viewport?: { x: number; y: number; zoom: number };
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

export interface WorkflowFileMeta {
  name: string;
  modified: number;
  size: number;
}

export interface WorkflowFile extends WorkflowFileMeta {
  graph: WorkflowGraph;
}

export function emptyWorkflowGraph(): WorkflowGraph {
  return { version: 1, nodes: [], edges: [] };
}

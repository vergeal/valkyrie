import type { DataType, NodeManifest, PortDefinition, WorkflowGraph } from "./types";
import type { LoggerService, NodeServices, VariableStore } from "./services";

export interface ExecInputs {
  [portId: string]: unknown;
}

export interface ExecResult {
  /** 数据端口的输出值，按端口 id 存 */
  outputs?: Record<string, unknown>;
  /** 要激活的执行出口 handle；缺省走第一个 exec 输出 */
  next?: string | string[] | null;
}

/** 控制流节点可用的特权能力；普通节点不要使用 */
export interface FlowHooks {
  /** 注册一个错误处理出口，返回 token；发生异常时引擎会跳到该出口 */
  pushErrorHandler(handle: string): number;
  popErrorHandler(token: number): void;
  variables: VariableStore;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface NodeContext {
  runId: string;
  graph: WorkflowGraph;
  nodeId: string;
  signal: AbortSignal;
  services: NodeServices;
  logger: LoggerService;
  flow: FlowHooks;
}

export type Executor = (args: {
  ctx: NodeContext;
  inputs: ExecInputs;
  config: Record<string, unknown>;
}) => Promise<ExecResult | void> | ExecResult | void;

export interface NodeDefinition {
  manifest: NodeManifest;
  execute?: Executor;
}

/** 节点作者统一用这个函数声明节点，便于将来做校验 / 类型推断 */
export function defineNode(definition: NodeDefinition): NodeDefinition {
  return definition;
}

export function execOut(id = "exec-out", name = "下一步"): PortDefinition {
  return { id, name, direction: "output", kind: "exec" };
}

export function execIn(id = "exec-in", name = "执行"): PortDefinition {
  return { id, name, direction: "input", kind: "exec" };
}

export function dataIn(id: string, name: string, dataType: DataType = "any", extra: Partial<PortDefinition> = {}): PortDefinition {
  return { id, name, direction: "input", kind: "data", dataType, ...extra };
}

export function dataOut(id: string, name: string, dataType: DataType = "any", extra: Partial<PortDefinition> = {}): PortDefinition {
  return { id, name, direction: "output", kind: "data", dataType, ...extra };
}

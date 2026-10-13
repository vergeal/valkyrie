import { createContext, useContext } from "react";
import type { ConfigOption } from "../sdk";
import type { NodeRegistry, RunRecord } from "../core";

export interface AutomationContextValue {
  registry: NodeRegistry;
  /** Provider id → 已解析的动态选项（连接等） */
  options: Record<string, ConfigOption[]>;
  /** 节点 id → 该节点按上游连接/库/模式过滤后的脚本选项 */
  scriptOptions: Record<string, ConfigOption[]>;
  /** 最近一次运行记录：开始 / 结束节点上展示 */
  run: RunRecord | null;
  setConfigValue: (nodeId: string, key: string, value: unknown) => void;
}

export const AutomationContext = createContext<AutomationContextValue>({
  registry: null as unknown as NodeRegistry,
  options: {},
  scriptOptions: {},
  run: null,
  setConfigValue: () => undefined
});

export function useAutomation(): AutomationContextValue {
  return useContext(AutomationContext);
}

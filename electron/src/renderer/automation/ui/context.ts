import { createContext, useContext } from "react";
import type { ConfigOption } from "../sdk";
import type { NodeRegistry } from "../core";

export interface AutomationContextValue {
  registry: NodeRegistry;
  /** Provider id → 已解析的动态选项（连接、数据库等） */
  options: Record<string, ConfigOption[]>;
  setConfigValue: (nodeId: string, key: string, value: unknown) => void;
}

export const AutomationContext = createContext<AutomationContextValue>({
  registry: null as unknown as NodeRegistry,
  options: {},
  setConfigValue: () => undefined
});

export function useAutomation(): AutomationContextValue {
  return useContext(AutomationContext);
}

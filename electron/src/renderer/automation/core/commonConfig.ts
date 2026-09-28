import type { ConfigField } from "../sdk";

/** 所有执行型节点共用的错误处理配置；由引擎统一实现，节点作者无需关心 */
export const ERROR_POLICY_FIELDS: ConfigField[] = [
  {
    key: "onError",
    label: "出错时",
    type: "select",
    default: "stop",
    options: [
      { label: "停止工作流", value: "stop" },
      { label: "继续执行", value: "continue" }
    ]
  },
  { key: "retryCount", label: "重试次数", type: "number", default: 0, min: 0, max: 10 },
  { key: "retryDelay", label: "重试间隔 (ms)", type: "number", default: 1000, min: 0 }
];

export interface ErrorPolicy {
  onError: "stop" | "continue";
  retryCount: number;
  retryDelay: number;
}

export function readErrorPolicy(config: Record<string, unknown>): ErrorPolicy {
  const onError = config.onError === "continue" ? "continue" : "stop";
  const retryCount = Number(config.retryCount ?? 0);
  const retryDelay = Number(config.retryDelay ?? 1000);

  return {
    onError,
    retryCount: Number.isFinite(retryCount) && retryCount > 0 ? Math.floor(retryCount) : 0,
    retryDelay: Number.isFinite(retryDelay) && retryDelay > 0 ? retryDelay : 0
  };
}

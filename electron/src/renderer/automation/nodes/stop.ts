import { defineNode, execIn } from "../sdk";

export default defineNode({
  manifest: {
    type: "stop",
    title: "停止",
    category: "流程控制",
    version: 1,
    icon: "alert",
    color: "#dc2626",
    description: "主动结束工作流，可选择标记为失败",
    inputs: [execIn()],
    outputs: [],
    config: [
      {
        key: "mode",
        label: "结果",
        type: "select",
        default: "success",
        options: [
          { label: "成功结束", value: "success" },
          { label: "失败结束", value: "failure" }
        ]
      },
      { key: "message", label: "消息", type: "text" }
    ]
  },
  execute: ({ config }) => {
    if (config.mode === "failure")
      throw new Error(String(config.message || "工作流主动终止"));

    return { next: null };
  }
});

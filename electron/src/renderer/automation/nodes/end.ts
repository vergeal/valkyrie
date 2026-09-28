import { defineNode, execIn } from "../sdk";

export default defineNode({
  manifest: {
    type: "end",
    title: "结束",
    category: "流程控制",
    version: 1,
    icon: "stop",
    color: "#dc2626",
    description: "工作流终点",
    inputs: [execIn("exec-in", "结束")],
    outputs: [],
    config: []
  },
  execute: () => ({ next: null })
});

import { defineNode, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "manual-start",
    title: "手动触发",
    category: "触发器",
    version: 1,
    icon: "play",
    color: "#dc2626",
    description: "工作流的手动入口，点击「运行」从这里开始",
    trigger: true,
    inputs: [],
    outputs: [execOut("exec-out", "开始")],
    config: []
  },
  execute: () => ({ next: "exec-out" })
});

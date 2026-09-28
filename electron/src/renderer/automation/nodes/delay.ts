import { defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "delay",
    title: "等待",
    category: "流程控制",
    version: 1,
    icon: "clock",
    color: "#d97706",
    description: "等待指定毫秒后再继续",
    inputs: [execIn()],
    outputs: [execOut()],
    config: [{ key: "ms", label: "等待时长 (ms)", type: "number", default: 1000, min: 0, inline: true }]
  },
  execute: async ({ ctx, config }) => {
    await ctx.flow.sleep(Number(config.ms ?? 0), ctx.signal);
    return {};
  }
});

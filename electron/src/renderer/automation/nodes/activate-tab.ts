import { dataIn, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "activate-tab",
    title: "激活查询页",
    category: "工作区",
    version: 1,
    icon: "terminal",
    color: "#0d9488",
    description: "把指定查询页切到前台，方便查看 / 复制结果",
    requires: ["workspace"],
    risk: "read",
    inputs: [execIn(), dataIn("tab", "页签", "string")],
    outputs: [execOut()],
    config: [{ key: "tab", label: "页签 id（未接线时使用）", type: "text", inline: true }]
  },
  execute: ({ ctx, inputs, config }) => {
    const tab = String(inputs.tab ?? config.tab ?? "").trim();

    if (!tab)
      throw new Error("激活查询页：缺少页签 id");

    ctx.services.workspace.activateTab(tab);

    return {};
  }
});

import { defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "open-connection",
    title: "打开连接",
    category: "数据库",
    version: 1,
    icon: "plug",
    color: "#7c3aed",
    description: "为本次运行建立一条独立连接，可脱离界面当前会话",
    requires: ["database"],
    risk: "read",
    inputs: [execIn()],
    outputs: [execOut()],
    config: [{ key: "connection", label: "连接", type: "connection", required: true, optionsSource: "connections", inline: true }]
  },
  execute: async ({ ctx, config }) => {
    const connection = String(config.connection ?? "").trim();

    if (!connection)
      throw new Error("打开连接：未选择连接");

    if (!ctx.services.database.isOpen(connection)) {
      await ctx.services.database.open(connection);
      ctx.logger.log("info", `已打开连接「${connection}」`);
    }

    return {};
  }
});

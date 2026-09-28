import { defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "close-connection",
    title: "关闭连接",
    category: "数据库",
    version: 1,
    icon: "close",
    color: "#7c3aed",
    description: "关闭本次运行建立的连接",
    requires: ["database"],
    risk: "read",
    inputs: [execIn()],
    outputs: [execOut()],
    config: [{ key: "connection", label: "连接", type: "connection", required: true, optionsSource: "connections", inline: true }]
  },
  execute: async ({ ctx, config }) => {
    const connection = String(config.connection ?? "").trim();

    if (!connection)
      throw new Error("关闭连接：未选择连接");

    if (ctx.services.database.isOpen(connection)) {
      await ctx.services.database.close(connection);
      ctx.logger.log("info", `已关闭连接「${connection}」`);
    }

    return {};
  }
});

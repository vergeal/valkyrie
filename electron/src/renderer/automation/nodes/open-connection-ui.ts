import { dataIn, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "open-connection-ui",
    title: "打开连接（界面）",
    category: "工作区",
    version: 1,
    icon: "plug",
    color: "#0d9488",
    description: "在客户端里打开连接会话（对象树 / 页签都在界面上），已打开则复用",
    requires: ["workspace"],
    risk: "read",
    inputs: [execIn(), dataIn("connection", "连接", "connection")],
    outputs: [execOut()],
    config: [{ key: "connection", label: "连接", type: "connection", required: true, optionsSource: "connections", inline: true }]
  },
  execute: async ({ ctx, inputs, config }) => {
    const connection = String(inputs.connection ?? config.connection ?? "").trim();

    if (!connection)
      throw new Error("打开连接：未选择连接");

    if (!ctx.services.workspace.listOpenConnections().includes(connection)) {
      await ctx.services.workspace.openConnection(connection);
      ctx.logger.log("info", `已在界面打开连接「${connection}」`);
    }

    return {};
  }
});

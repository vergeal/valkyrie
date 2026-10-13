import { dataOut, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "open-connection",
    title: "打开连接",
    category: "连接",
    version: 1,
    icon: "plug",
    color: "#0d9488",
    description: "在界面上打开连接（已打开则复用），并输出连接句柄供后续节点使用",
    requires: ["workspace"],
    risk: "read",
    inputs: [execIn()],
    outputs: [execOut(), dataOut("connection", "连接句柄", "connection")],
    config: [
      { key: "connection", label: "连接", type: "connection", required: true, optionsSource: "connections", inline: true }
    ]
  },
  execute: async ({ ctx, config }) => {
    const connection = String(config.connection ?? "").trim();

    if (!connection)
      throw new Error("打开连接：未选择连接");

    if (!ctx.services.workspace.listOpenConnections().includes(connection)) {
      await ctx.services.workspace.openConnection(connection);
      ctx.logger.log("info", `已打开连接「${connection}」`);
    }

    return { outputs: { connection } };
  }
});

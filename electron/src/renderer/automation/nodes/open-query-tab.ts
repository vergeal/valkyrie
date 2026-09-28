import { dataIn, dataOut, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "open-query-tab",
    title: "打开查询页",
    category: "工作区",
    version: 1,
    icon: "terminal",
    color: "#0d9488",
    description: "为连接 / 库建一个查询标签页，可预置脚本内容",
    requires: ["workspace"],
    risk: "read",
    inputs: [execIn(), dataIn("connection", "连接", "connection"), dataIn("database", "库", "string")],
    outputs: [execOut(), dataOut("tab", "页签", "string")],
    config: [
      { key: "connection", label: "连接", type: "connection", required: true, optionsSource: "connections", inline: true },
      { key: "database", label: "库 / 模式", type: "text", inline: true, placeholder: "留空用连接默认" },
      { key: "asSchema", label: "按模式处理", type: "checkbox", default: false },
      { key: "title", label: "页签标题", type: "text", placeholder: "支持 {connection} / {database}" },
      { key: "sql", label: "预置脚本", type: "code", language: "sql", rows: 3 }
    ]
  },
  execute: ({ ctx, inputs, config }) => {
    const connection = String(inputs.connection ?? config.connection ?? "").trim();
    const database = String(inputs.database ?? config.database ?? "").trim();
    const asSchema = Boolean(config.asSchema);

    if (!connection)
      throw new Error("打开查询页：未选择连接");

    const title = String(config.title ?? "")
      .replace(/\{connection\}/g, connection)
      .replace(/\{database\}/g, database)
      .trim();

    const tabId = ctx.services.workspace.openTab({
      connection,
      catalog: asSchema ? undefined : database || undefined,
      schema: asSchema ? database || undefined : undefined,
      title: title || undefined,
      sql: typeof config.sql === "string" && config.sql.trim() ? config.sql : undefined
    });

    ctx.logger.log("info", `已打开查询页「${title || connection}」`);

    return { outputs: { tab: tabId } };
  }
});

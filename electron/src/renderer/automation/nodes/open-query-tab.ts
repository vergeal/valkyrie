import { dataIn, dataOut, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "open-query-tab",
    title: "打开查询页",
    category: "工作区",
    version: 1,
    icon: "terminal",
    color: "#0d9488",
    description: "把连接接进来，为它建一个查询标签页，并可预置一段查询脚本",
    requires: ["workspace", "files"],
    risk: "read",
    inputs: [execIn(), dataIn("connection", "连接", "connection", { required: true }), dataIn("database", "库", "string")],
    outputs: [execOut(), dataOut("tab", "页签", "string")],
    config: [
      { key: "script", label: "查询脚本", type: "file", placeholder: "选择 .sql 文件（可选）" },
      { key: "database", label: "库 / 模式", type: "text", inline: true, placeholder: "留空用连接默认" },
      { key: "asSchema", label: "按模式处理", type: "checkbox", default: false },
      { key: "title", label: "页签标题", type: "text", placeholder: "支持 {connection} / {database}" },
      { key: "sql", label: "内联脚本（可选，脚本文件优先）", type: "code", language: "sql", rows: 3 }
    ]
  },
  execute: async ({ ctx, inputs, config }) => {
    const connection = String(inputs.connection ?? "").trim();
    const database = String(inputs.database ?? config.database ?? "").trim();
    const asSchema = Boolean(config.asSchema);

    if (!connection)
      throw new Error("打开查询页：必须接入「连接」引脚");

    let sql = typeof config.sql === "string" ? config.sql : "";
    const script = String(config.script ?? "").trim();

    if (script)
      sql = await ctx.services.files.readText(script);

    const title = String(config.title ?? "")
      .replace(/\{connection\}/g, connection)
      .replace(/\{database\}/g, database)
      .trim();

    const tabId = ctx.services.workspace.openTab({
      connection,
      catalog: asSchema ? undefined : database || undefined,
      schema: asSchema ? database || undefined : undefined,
      title: title || undefined,
      sql: sql.trim() ? sql : undefined
    });

    ctx.logger.log("info", `已打开查询页「${title || connection}」`);

    return { outputs: { tab: tabId } };
  }
});

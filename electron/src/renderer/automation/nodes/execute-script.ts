import { dataIn, dataOut, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "execute-script",
    title: "执行脚本",
    category: "工作区",
    version: 1,
    icon: "code",
    color: "#0d9488",
    description: "读取 .sql 脚本并在查询页里执行，结果留在界面供查看 / 复制",
    requires: ["workspace", "files"],
    risk: "write",
    inputs: [execIn(), dataIn("connection", "连接", "connection"), dataIn("database", "库", "string")],
    outputs: [execOut(), dataOut("tab", "页签", "string")],
    config: [
      {
        key: "source",
        label: "脚本来源",
        type: "select",
        default: "file",
        inline: true,
        options: [
          { label: "本地 .sql 文件", value: "file" },
          { label: "内联 SQL", value: "inline" }
        ]
      },
      { key: "path", label: "脚本文件", type: "text", inline: true, placeholder: "例如 /Users/me/sql/check.sql" },
      { key: "sql", label: "内联 SQL", type: "code", language: "sql", rows: 3 },
      { key: "connection", label: "连接", type: "connection", required: true, optionsSource: "connections", inline: true },
      { key: "database", label: "库 / 模式", type: "text", inline: true },
      { key: "asSchema", label: "按模式处理", type: "checkbox", default: false }
    ]
  },
  execute: async ({ ctx, inputs, config }) => {
    const connection = String(inputs.connection ?? config.connection ?? "").trim();
    const database = String(inputs.database ?? config.database ?? "").trim();
    const asSchema = Boolean(config.asSchema);

    if (!connection)
      throw new Error("执行脚本：未选择连接");

    const inline = config.source === "inline";
    let sql = "";

    if (inline) {
      sql = String(config.sql ?? "");
    } else {
      const file = String(config.path ?? "").trim();

      if (!file)
        throw new Error("执行脚本：未填写脚本文件路径");

      sql = await ctx.services.files.readText(file);
    }

    if (!sql.trim())
      throw new Error("执行脚本：脚本内容为空");

    if (!ctx.services.workspace.listOpenConnections().includes(connection)) {
      await ctx.services.workspace.openConnection(connection);
    }

    const title = database ? `${connection} / ${database}` : connection;
    const tabId = ctx.services.workspace.openTab({
      connection,
      catalog: asSchema ? undefined : database || undefined,
      schema: asSchema ? database || undefined : undefined,
      title,
      sql
    });

    await ctx.services.workspace.runTab(tabId);
    ctx.logger.log("info", `已执行脚本：${title}`);

    return { outputs: { tab: tabId } };
  }
});

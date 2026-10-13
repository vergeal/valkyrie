import { dataIn, defineNode, execIn, execOut } from "../sdk";
import { catalogOf, connectionNameOf, schemaOf } from "../sdk";

export default defineNode({
  manifest: {
    type: "execute-sql",
    title: "执行 SQL",
    category: "脚本",
    version: 1,
    icon: "play",
    color: "#0d9488",
    description: "执行手写的 SQL：自动新建查询页，设置连接 / 数据库 / 模式后执行",
    requires: ["workspace"],
    risk: "write",
    inputs: [
      execIn(),
      dataIn("connection", "连接", "connection"),
      dataIn("database", "数据库", "database"),
      dataIn("schema", "模式", "object")
    ],
    outputs: [execOut()],
    config: [
      { key: "sql", label: "SQL", type: "code", language: "sql", required: true, inline: true, rows: 5 },
      { key: "title", label: "页签标题", type: "text", placeholder: "留空用默认" }
    ]
  },
  execute: async ({ ctx, inputs, config }) => {
    const connection = connectionNameOf(inputs.schema) ?? connectionNameOf(inputs.database) ?? connectionNameOf(inputs.connection);
    const catalog = catalogOf(inputs.database) ?? catalogOf(inputs.schema);
    const schema = schemaOf(inputs.schema);
    const sql = String(config.sql ?? "").trim();
    const title = String(config.title ?? "").trim();

    if (!connection)
      throw new Error("执行 SQL：缺少连接（请接入连接 / 模式句柄）");

    if (!sql)
      throw new Error("执行 SQL：SQL 不能为空");

    if (!ctx.services.workspace.listOpenConnections().includes(connection))
      await ctx.services.workspace.openConnection(connection);

    const tabId = ctx.services.workspace.openTab({ connection, catalog, schema, title: title || undefined, sql });
    await ctx.services.workspace.runTab(tabId);

    return {};
  }
});

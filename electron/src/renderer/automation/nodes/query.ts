import { dataOut, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "query",
    title: "查询",
    category: "数据库",
    version: 1,
    icon: "search",
    color: "#7c3aed",
    description: "执行 SELECT，输出结果集",
    requires: ["database"],
    risk: "read",
    inputs: [execIn()],
    outputs: [
      execOut(),
      dataOut("result", "结果集", "table"),
      dataOut("rows", "行数组", "array"),
      dataOut("rowCount", "行数", "int")
    ],
    config: [
      { key: "connection", label: "连接", type: "connection", required: true, optionsSource: "connections", inline: true },
      { key: "sql", label: "SQL", type: "code", language: "sql", required: true, inline: true, rows: 4 }
    ]
  },
  execute: async ({ ctx, config }) => {
    const connection = String(config.connection ?? "").trim();
    const sql = String(config.sql ?? "").trim();

    if (!connection)
      throw new Error("查询：未选择连接");

    if (!sql)
      throw new Error("查询：SQL 不能为空");

    if (!ctx.services.database.isOpen(connection))
      throw new Error(`查询：连接「${connection}」尚未打开，请先接「打开连接」节点`);

    const result = await ctx.services.database.query(connection, sql);

    ctx.logger.log("info", `查询返回 ${result.rows.length} 行`);

    return { outputs: { result, rows: result.rows, rowCount: result.rows.length } };
  }
});

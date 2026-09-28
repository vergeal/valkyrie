import { dataOut, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "execute-sql",
    title: "执行 SQL",
    category: "数据库",
    version: 1,
    icon: "code",
    color: "#7c3aed",
    description: "执行 DML / DDL，输出受影响行数",
    requires: ["database"],
    risk: "write",
    inputs: [execIn()],
    outputs: [execOut(), dataOut("affected", "影响行数", "int")],
    config: [
      { key: "connection", label: "连接", type: "connection", required: true, optionsSource: "connections", inline: true },
      { key: "sql", label: "SQL", type: "code", language: "sql", required: true, inline: true, rows: 4 }
    ]
  },
  execute: async ({ ctx, config }) => {
    const connection = String(config.connection ?? "").trim();
    const sql = String(config.sql ?? "").trim();

    if (!connection)
      throw new Error("执行 SQL：未选择连接");

    if (!sql)
      throw new Error("执行 SQL：SQL 不能为空");

    if (!ctx.services.database.isOpen(connection))
      throw new Error(`执行 SQL：连接「${connection}」尚未打开，请先接「打开连接」节点`);

    const result = await ctx.services.database.execute(connection, sql);
    const affected = result.affected ?? result.rowCount ?? 0;

    ctx.logger.log("info", `受影响 ${affected} 行`);

    return { outputs: { affected } };
  }
});

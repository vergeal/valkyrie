import { dataIn, dataOut, defineNode, execIn, execOut } from "../sdk";
import { connectionNameOf } from "../sdk";

export default defineNode({
  manifest: {
    type: "open-database",
    title: "打开数据库",
    category: "连接",
    version: 1,
    icon: "database",
    color: "#0d9488",
    description: "指定数据库名（手动输入），输出数据库句柄供后续节点使用",
    inputs: [execIn(), dataIn("connection", "连接", "connection")],
    outputs: [execOut(), dataOut("database", "数据库", "database")],
    config: [
      { key: "connection", label: "连接（未接线时使用）", type: "connection", optionsSource: "connections" },
      { key: "database", label: "数据库", type: "text", required: true, inline: true, placeholder: "数据库名" }
    ]
  },
  execute: ({ inputs, config }) => {
    const connection = connectionNameOf(inputs.connection) ?? connectionNameOf(config.connection);
    const database = String(config.database ?? "").trim();

    if (!connection)
      throw new Error("打开数据库：缺少连接（请接入「打开连接」的连接句柄）");

    if (!database)
      throw new Error("打开数据库：请填写数据库名");

    return { outputs: { database: { connection, catalog: database } } };
  }
});

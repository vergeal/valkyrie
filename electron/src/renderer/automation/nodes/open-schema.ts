import { dataIn, dataOut, defineNode, execIn, execOut } from "../sdk";
import { catalogOf, connectionNameOf } from "../sdk";

export default defineNode({
  manifest: {
    type: "open-schema",
    title: "打开模式",
    category: "连接",
    version: 1,
    icon: "folder",
    color: "#0d9488",
    description: "指定模式名（手动输入），输出模式句柄供后续节点使用",
    inputs: [execIn(), dataIn("connection", "连接", "connection"), dataIn("database", "数据库", "database")],
    outputs: [execOut(), dataOut("schema", "模式", "object")],
    config: [
      { key: "schema", label: "模式", type: "text", required: true, inline: true, placeholder: "模式名" }
    ]
  },
  execute: ({ inputs, config }) => {
    const connection = connectionNameOf(inputs.database) ?? connectionNameOf(inputs.connection);
    const catalog = catalogOf(inputs.database);
    const schema = String(config.schema ?? "").trim();

    if (!connection)
      throw new Error("打开模式：缺少连接（请接入连接 / 数据库句柄）");

    if (!schema)
      throw new Error("打开模式：请填写模式名");

    return { outputs: { schema: { connection, catalog, schema } } };
  }
});

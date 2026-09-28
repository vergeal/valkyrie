import { dataIn, dataOut, defineNode, execIn, execOut } from "../sdk";

interface DatabaseItem {
  label: string;
  kind: string;
}

interface LoopState {
  items: DatabaseItem[];
  index: number;
}

export default defineNode({
  manifest: {
    type: "foreach-database",
    title: "遍历库/模式",
    category: "流程控制",
    version: 1,
    icon: "database",
    color: "#d97706",
    description: "在当前连接下遍历所有库 / 模式，循环体里注入「当前库」",
    requires: ["workspace"],
    inputs: [execIn(), dataIn("connection", "连接", "connection")],
    outputs: [
      execOut("out-loop", "循环体"),
      execOut("out-done", "完成"),
      dataOut("database", "当前库", "string"),
      dataOut("kind", "类型", "string"),
      dataOut("index", "下标", "int")
    ],
    config: [{ key: "connection", label: "连接（未接线时使用）", type: "connection", optionsSource: "connections", inline: true }]
  },
  execute: async ({ ctx, inputs, config }) => {
    const key = `$loop:${ctx.nodeId}`;
    let state = ctx.flow.variables.get(key) as LoopState | undefined;

    if (!state) {
      const connection = String(inputs.connection ?? config.connection ?? "").trim();

      if (!connection)
        throw new Error("遍历库：缺少连接");

      state = { items: await ctx.services.workspace.listDatabases(connection), index: 0 };
    }

    if (state.index < state.items.length) {
      const item = state.items[state.index];
      state.index += 1;
      ctx.flow.variables.set(key, state);
      return { outputs: { database: item.label, kind: item.kind, index: state.index - 1 }, next: "out-loop" };
    }

    ctx.flow.variables.set(key, undefined);
    return { next: "out-done" };
  }
});

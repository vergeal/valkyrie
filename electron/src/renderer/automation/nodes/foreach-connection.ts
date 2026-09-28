import { dataOut, defineNode, execIn, execOut } from "../sdk";

interface LoopState {
  items: string[];
  index: number;
}

export default defineNode({
  manifest: {
    type: "foreach-connection",
    title: "遍历连接",
    category: "流程控制",
    version: 1,
    icon: "plug",
    color: "#d97706",
    description: "依次遍历选中的连接（留空=全部），循环体里注入「当前连接」",
    requires: ["workspace"],
    inputs: [execIn()],
    outputs: [execOut("out-loop", "循环体"), execOut("out-done", "完成"), dataOut("connection", "当前连接", "connection"), dataOut("index", "下标", "int")],
    config: [{ key: "connections", label: "连接（逗号分隔，留空=全部）", type: "text", inline: true, placeholder: "本地_MySQL, 生产_PG" }]
  },
  execute: ({ ctx, config }) => {
    const key = `$loop:${ctx.nodeId}`;
    let state = ctx.flow.variables.get(key) as LoopState | undefined;

    if (!state) {
      const configured = String(config.connections ?? "")
        .split(/[,，\n]/)
        .map(item => item.trim())
        .filter(Boolean);

      const available = ctx.services.workspace.listConnections().map(item => item.name);
      state = { items: configured.length > 0 ? available.filter(name => configured.includes(name)) : available, index: 0 };
    }

    if (state.index < state.items.length) {
      const connection = state.items[state.index];
      state.index += 1;
      ctx.flow.variables.set(key, state);
      return { outputs: { connection, index: state.index - 1 }, next: "out-loop" };
    }

    ctx.flow.variables.set(key, undefined);
    return { next: "out-done" };
  }
});

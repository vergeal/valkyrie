import { dataIn, dataOut, defineNode, execIn, execOut } from "../sdk";

interface LoopState {
  items: unknown[];
  index: number;
}

function parseItems(raw: unknown): unknown[] {
  if (Array.isArray(raw))
    return raw;

  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

export default defineNode({
  manifest: {
    type: "foreach",
    title: "遍历",
    category: "流程控制",
    version: 1,
    icon: "refresh",
    color: "#d97706",
    description: "对数组逐项执行循环体，全部完成后走「完成」",
    inputs: [execIn(), dataIn("items", "数组", "array")],
    outputs: [execOut("out-loop", "循环体"), execOut("out-done", "完成"), dataOut("item", "当前项"), dataOut("index", "下标", "int")],
    config: [{ key: "items", label: "数组（未接线时使用，JSON）", type: "code", language: "json", rows: 3 }]
  },
  execute: ({ ctx, inputs, config }) => {
    const key = `$loop:${ctx.nodeId}`;
    let state = ctx.flow.variables.get(key) as LoopState | undefined;

    if (!state)
      state = { items: parseItems(inputs.items ?? config.items), index: 0 };

    if (state.index < state.items.length) {
      const item = state.items[state.index];
      state.index += 1;
      ctx.flow.variables.set(key, state);
      return { outputs: { item, index: state.index - 1 }, next: "out-loop" };
    }

    ctx.flow.variables.set(key, undefined);
    return { next: "out-done" };
  }
});

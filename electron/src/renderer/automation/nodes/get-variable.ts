import { dataOut, defineNode } from "../sdk";

export default defineNode({
  manifest: {
    type: "get-variable",
    title: "读取变量",
    category: "数据",
    version: 1,
    icon: "download",
    color: "#7c3aed",
    description: "读取运行变量",
    pure: true,
    inputs: [],
    outputs: [dataOut("value", "值")],
    config: [{ key: "name", label: "变量名", type: "text", required: true, inline: true }]
  },
  execute: ({ ctx, config }) => ({ outputs: { value: ctx.flow.variables.get(String(config.name ?? "")) } })
});

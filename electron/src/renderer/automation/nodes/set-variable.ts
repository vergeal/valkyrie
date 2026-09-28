import { dataIn, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "set-variable",
    title: "设置变量",
    category: "数据",
    version: 1,
    icon: "save",
    color: "#7c3aed",
    description: "把一个值写入运行变量，供后续节点引用",
    inputs: [execIn(), dataIn("value", "值")],
    outputs: [execOut()],
    config: [
      { key: "name", label: "变量名", type: "text", required: true, placeholder: "例如 total" },
      { key: "value", label: "值（未接线时使用）", type: "textarea", rows: 2 }
    ]
  },
  execute: ({ ctx, inputs, config }) => {
    const name = String(config.name ?? "").trim();

    if (!name)
      throw new Error("设置变量：变量名不能为空");

    ctx.flow.variables.set(name, inputs.value ?? config.value);

    return {};
  }
});

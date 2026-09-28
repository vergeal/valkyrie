import { dataIn, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "assert",
    title: "断言",
    category: "流程控制",
    version: 1,
    icon: "check",
    color: "#d97706",
    description: "条件成立走「通过」，否则走「失败」",
    inputs: [execIn(), dataIn("condition", "条件", "bool")],
    outputs: [execOut("out-pass", "通过"), execOut("out-fail", "失败")],
    config: [{ key: "condition", label: "条件值（未接线时使用）", type: "checkbox", default: false }]
  },
  execute: ({ inputs, config }) => {
    const value = inputs.condition ?? config.condition;

    return { next: value ? "out-pass" : "out-fail" };
  }
});

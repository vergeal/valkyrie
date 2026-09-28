import { dataIn, defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "if",
    title: "条件分支",
    category: "流程控制",
    version: 1,
    icon: "workflow",
    color: "#d97706",
    description: "条件为真走「真」分支，否则走「假」分支",
    inputs: [execIn(), dataIn("condition", "条件", "bool")],
    outputs: [execOut("out-true", "真"), execOut("out-false", "假")],
    config: [{ key: "condition", label: "条件值（未接线时使用）", type: "checkbox", default: false }]
  },
  execute: ({ inputs, config }) => {
    const value = inputs.condition ?? config.condition;

    return { next: value ? "out-true" : "out-false" };
  }
});

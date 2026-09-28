import { dataIn, dataOut, defineNode } from "../sdk";

function compare(operator: string, a: unknown, b: unknown): boolean {
  switch (operator) {
    case "!=":
      return a !== b;
    case ">":
      return Number(a) > Number(b);
    case ">=":
      return Number(a) >= Number(b);
    case "<":
      return Number(a) < Number(b);
    case "<=":
      return Number(a) <= Number(b);
    case "contains":
      return String(a ?? "").includes(String(b ?? ""));
    case "isEmpty":
      return a == null || a === "" || (Array.isArray(a) && a.length === 0);
    default:
      return a === b;
  }
}

export default defineNode({
  manifest: {
    type: "compare",
    title: "比较",
    category: "数据",
    version: 1,
    icon: "sliders",
    color: "#7c3aed",
    description: "比较两个值，输出布尔结果",
    pure: true,
    inputs: [dataIn("a", "A 值"), dataIn("b", "B 值")],
    outputs: [dataOut("result", "结果", "bool")],
    config: [
      {
        key: "operator",
        label: "运算符",
        type: "select",
        default: "==",
        inline: true,
        options: [
          { label: "等于 ==", value: "==" },
          { label: "不等于 !=", value: "!=" },
          { label: "大于 >", value: ">" },
          { label: "大于等于 >=", value: ">=" },
          { label: "小于 <", value: "<" },
          { label: "小于等于 <=", value: "<=" },
          { label: "包含", value: "contains" },
          { label: "为空", value: "isEmpty" }
        ]
      }
    ]
  },
  execute: ({ inputs, config }) => ({
    outputs: { result: compare(String(config.operator ?? "=="), inputs.a, inputs.b) }
  })
});

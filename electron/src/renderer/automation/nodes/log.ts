import { dataIn, defineNode, execIn, execOut } from "../sdk";

function format(value: unknown): string {
  if (value == null)
    return "";

  return typeof value === "string" ? value : JSON.stringify(value);
}

export default defineNode({
  manifest: {
    type: "log",
    title: "写日志",
    category: "数据",
    version: 1,
    icon: "info",
    color: "#0891b2",
    description: "向运行日志输出一条消息",
    inputs: [execIn(), dataIn("value", "附加数据")],
    outputs: [execOut()],
    config: [
      { key: "message", label: "消息", type: "text", required: true, inline: true, placeholder: "支持 {变量名} 占位" },
      {
        key: "level",
        label: "级别",
        type: "select",
        default: "info",
        options: [
          { label: "调试", value: "debug" },
          { label: "信息", value: "info" },
          { label: "警告", value: "warn" },
          { label: "错误", value: "error" }
        ]
      }
    ]
  },
  execute: ({ ctx, inputs, config }) => {
    const raw = String(config.message ?? "");
    const rendered = raw.replace(/\{(\w+)\}/g, (_match, name: string) => format(ctx.flow.variables.get(name)));
    const extra = format(inputs.value);
    const level = (config.level as "debug" | "info" | "warn" | "error") ?? "info";

    ctx.logger.log(level, extra ? `${rendered} ${extra}` : rendered);

    return {};
  }
});

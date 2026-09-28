import { defineNode, execIn, execOut } from "../sdk";

export default defineNode({
  manifest: {
    type: "notify",
    title: "通知",
    category: "通知",
    version: 1,
    icon: "info",
    color: "#0d9488",
    description: "弹出应用内 / 系统通知",
    inputs: [execIn()],
    outputs: [execOut()],
    config: [
      { key: "title", label: "标题", type: "text", default: "自动化", inline: true },
      { key: "message", label: "内容", type: "textarea", required: true, rows: 2 },
      {
        key: "level",
        label: "级别",
        type: "select",
        default: "info",
        options: [
          { label: "信息", value: "info" },
          { label: "成功", value: "success" },
          { label: "警告", value: "warning" },
          { label: "错误", value: "error" }
        ]
      }
    ]
  },
  execute: async ({ ctx, config }) => {
    await ctx.services.notify.notify({
      title: String(config.title ?? "自动化"),
      message: String(config.message ?? ""),
      level: (config.level as "info" | "success" | "warning" | "error") ?? "info"
    });

    return {};
  }
});

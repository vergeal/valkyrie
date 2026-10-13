import { dataIn, defineNode, execIn, execOut } from "../sdk";

interface ScriptSelection {
  connection: string;
  scope: string;
  name: string;
}

function parseSelection(raw: unknown): ScriptSelection | null {
  if (typeof raw !== "string" || !raw.trim())
    return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ScriptSelection>;

    if (typeof parsed.connection === "string" && typeof parsed.scope === "string" && typeof parsed.name === "string")
      return { connection: parsed.connection, scope: parsed.scope, name: parsed.name };
  } catch {
    /* 选项值不是合法 JSON：当未选择处理 */
  }

  return null;
}

export default defineNode({
  manifest: {
    type: "open-script",
    title: "打开查询脚本",
    category: "脚本",
    version: 1,
    icon: "code",
    color: "#0d9488",
    description: "选择本地已保存的查询脚本，打开成新的查询页；连接 / 库 / 模式按脚本路径自动推断；可选打开后执行",
    requires: ["workspace"],
    inputs: [execIn(), dataIn("connection", "连接", "connection")],
    outputs: [execOut()],
    config: [
      { key: "script", label: "查询脚本", type: "select", required: true, optionsSource: "scripts", inline: true },
      { key: "run", label: "打开后执行", type: "checkbox", default: false, inline: true }
    ]
  },
  execute: async ({ ctx, config }) => {
    const selection = parseSelection(config.script);

    if (!selection)
      throw new Error("打开查询脚本：请选择一个脚本");

    /* 连接上下文由脚本自身路径推断，交给工作区按客户端既有逻辑打开 */
    await ctx.services.workspace.openScript({
      connection: selection.connection,
      scope: selection.scope,
      name: selection.name,
      run: Boolean(config.run)
    });

    return {};
  }
});

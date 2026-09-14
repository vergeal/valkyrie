/**
 * 快捷键提示文案。
 *
 * macOS 用 ⌘（Command），其它平台用 Ctrl —— 真正按下的组合键在 Monaco 里走
 * CtrlCmd、在窗口级监听里同时判断 ctrlKey / metaKey，这里只负责「显示什么」。
 * 平台由 preload 从 process.platform 带过来，比 navigator.platform 可靠。
 */
export const IS_MAC = typeof window !== "undefined" && window.valkyrie?.platform === "darwin";

/**
 * Electron accelerator 写法（原生菜单直接用，系统会把提示右对齐画在菜单右侧）。
 * 应用内的下拉菜单也从这里派生显示文案，避免两处各写一份。
 */
export const ACCEL = {
  run: "CmdOrCtrl+R",
  runEnter: "CmdOrCtrl+Enter",
  format: "CmdOrCtrl+Shift+F",
  save: "CmdOrCtrl+S",
  saveAs: "CmdOrCtrl+Shift+S",
  selectAll: "CmdOrCtrl+A",
  expand: "CmdOrCtrl+W",
  shrink: "CmdOrCtrl+Shift+W",
  copy: "CmdOrCtrl+C",
  cut: "CmdOrCtrl+X",
  paste: "CmdOrCtrl+V",
  options: "CmdOrCtrl+,",
  space: "CmdOrCtrl+Space"
};

/** accelerator → 界面显示文案：Windows/Linux 用 Ctrl+X，macOS 用 ⌃⌥⇧⌘ 符号 */
export function acceleratorLabel(accelerator: string): string {
  const parts = accelerator.split("+");
  const key = parts[parts.length - 1] ?? "";
  const mods = parts.slice(0, -1);
  const command = mods.some(mod => mod === "CmdOrCtrl" || mod === "Cmd");
  const control = mods.some(mod => mod === "Control");
  const shift = mods.some(mod => mod === "Shift");
  const alt = mods.some(mod => mod === "Alt");
  const label = key.length === 1 ? key.toUpperCase() : (IS_MAC && key === "Enter" ? "⏎" : key);

  if (!IS_MAC) {
    return [
      control || command ? "Ctrl" : "",
      shift ? "Shift" : "",
      alt ? "Alt" : "",
      label
    ].filter(Boolean).join("+");
  }

  return `${control ? "⌃" : ""}${alt ? "⌥" : ""}${shift ? "⇧" : ""}${command ? "⌘" : ""}${label}`;
}

export const KEY = {
  run: acceleratorLabel(ACCEL.run),
  runEnter: acceleratorLabel(ACCEL.runEnter),
  format: acceleratorLabel(ACCEL.format),
  save: acceleratorLabel(ACCEL.save),
  saveAs: acceleratorLabel(ACCEL.saveAs),
  selectAll: acceleratorLabel(ACCEL.selectAll),
  expand: acceleratorLabel(ACCEL.expand),
  shrink: acceleratorLabel(ACCEL.shrink),
  copy: acceleratorLabel(ACCEL.copy),
  cut: acceleratorLabel(ACCEL.cut),
  paste: acceleratorLabel(ACCEL.paste),
  space: acceleratorLabel(ACCEL.space)
};

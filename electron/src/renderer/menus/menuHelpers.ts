import type { NativeMenuItem } from "../api";
import type { MenuEntry } from "../ui/Menu";

/**
 * macOS：把应用内菜单转成可序列化结构交给主进程，
 * 点击后主进程回传项 id，这里再按 id 找到对应的动作执行（动作闭包只存在渲染层）。
 */
export function serializeAppMenuItem(
  entry: MenuEntry,
  id: string,
  actions: Record<string, () => void>
): NativeMenuItem {
  if (entry.separator)
    return { type: "separator" };

  const item: NativeMenuItem = { id, label: entry.label ?? "", enabled: !entry.disabled };

  if (entry.accelerator)
    item.accelerator = entry.accelerator;

  if (entry.children?.length)
    item.submenu = entry.children.map((child, index) => serializeAppMenuItem(child, `${id}.${index}`, actions));
  else if (entry.action)
    actions[id] = entry.action;

  return item;
}

import { useEffect, useRef } from "react";
import { onAppMenu, setAppMenu, type NativeMenuItem } from "../api";
import { IS_MAC } from "../keys";
import type { MenuEntry } from "../ui/Menu";
import { serializeAppMenuItem } from "./menuHelpers";

/**
 * macOS：菜单栏用系统顶部菜单栏。把应用内菜单转成可序列化结构交给主进程，
 * 点击后主进程回传项 id，这里再按 id 找到对应的动作执行（动作闭包只存在渲染层）。
 * 菜单结构 / 可用态没变时（比如只是结果集变了）不重建，避免系统菜单频繁闪烁。
 */
export function useAppMenu(menus: { label: string; items: MenuEntry[] }[]) {
  const appMenuActionsRef = useRef<Record<string, () => void>>({});
  const appMenuActions: Record<string, () => void> = {};

  const appMenuTemplate: NativeMenuItem[] = menus.map((menu, index) => ({
    label: menu.label,
    submenu: menu.items.map((entry, itemIndex) => serializeAppMenuItem(entry, `${index}.${itemIndex}`, appMenuActions))
  }));

  appMenuActionsRef.current = appMenuActions;

  const appMenuSignature = JSON.stringify(appMenuTemplate);

  useEffect(() => {
    if (!IS_MAC)
      return;

    void setAppMenu(appMenuTemplate);
    /* 只在结构与可用态变化时同步；动作通过 ref 取最新，不进依赖 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appMenuSignature]);

  useEffect(() => {
    if (!IS_MAC)
      return;

    return onAppMenu(id => appMenuActionsRef.current[id]?.());
  }, []);

  return { appMenuTemplate };
}

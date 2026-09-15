import { MenuButton, type MenuEntry } from "./Menu";

/** 顶部应用菜单栏（非 macOS）：结构由 menus 模块构建。 */
export function AppMenuBar(props: {
  menus: { label: string; items: MenuEntry[] }[];
  openMenu: string | null;
  onOpenChange: (open: boolean, label: string) => void;
  status: string;
}) {
  const { menus, openMenu, onOpenChange, status } = props;

  return (
    <nav className="menubar" onMouseLeave={() => onOpenChange(false, openMenu ?? "")}>
      {menus.map(menu => (
        <MenuButton
          key={menu.label}
          label={menu.label}
          entries={menu.items}
          open={openMenu === menu.label}
          onOpenChange={open => onOpenChange(open, menu.label)}
        />
      ))}
      <span className="menubar-right">{status}</span>
    </nav>
  );
}

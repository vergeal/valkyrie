import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { acceleratorLabel } from "../keys";
import { Icon } from "./icons";
import { showMenu, type NativeMenuItem } from "../api";
import { imageDataUrl, menuIconDataUrl } from "./menuIcon";

export interface MenuEntry {
  label?: string;
  action?: () => void;
  separator?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** 菜单项左侧图标（lucide 映射名，会栅格化成位图给系统菜单用） */
  icon?: string;
  /** 位图图标（各数据库品牌 logo 之类的资源地址）：与 icon 二选一 */
  image?: string;
  /** 图标颜色，默认中性灰 */
  iconColor?: string;
  /**
   * 快捷键（Electron accelerator 写法，如 CmdOrCtrl+R）。
   * 原生菜单交给系统画在最右侧；应用内下拉菜单用它派生显示文案。
   */
  accelerator?: string;
  /** 二级菜单：有 children 时这一项变成可展开的子菜单 */
  children?: MenuEntry[];
}

/**
 * 菜单项渲染：右键菜单与下拉菜单共用同一套样式类（.menu-item）。
 * Radix 会用 data-highlighted / data-disabled 标记状态，键盘与鼠标行为一致。
 */
function renderEntries(
  entries: MenuEntry[],
  components: { Item: typeof DropdownMenu.Item; Separator: typeof DropdownMenu.Separator }
) {
  const { Item, Separator } = components;

  return entries.map((entry, index) => entry.separator
    ? <Separator key={`sep-${index}`} className="ctx-sep" />
    : entry.children
      ? (
        <DropdownMenu.Sub key={`${entry.label}-${index}`}>
          <DropdownMenu.SubTrigger
            className={`menu-item${entry.danger ? " is-danger" : ""}`}
            disabled={entry.disabled}
          >
            {entry.image
              ? <img className="menu-item-icon" src={entry.image} width={13} height={13} alt="" draggable={false} />
              : entry.icon && <Icon name={entry.icon} size={13} className="menu-item-icon" />}
            <span className="menu-item-label">{entry.label}</span>
            <Icon name="chevronRight" size={12} className="menu-item-chevron" />
          </DropdownMenu.SubTrigger>

          <DropdownMenu.Portal>
            <DropdownMenu.SubContent
              className="menu-dropdown menu-submenu"
              sideOffset={4}
              alignOffset={-4}
              collisionPadding={8}
            >
              {renderEntries(entry.children, components)}
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
      )
    : (
      <Item
        key={`${entry.label}-${index}`}
        className={`menu-item${entry.danger ? " is-danger" : ""}`}
        disabled={entry.disabled}
        onSelect={() => entry.action?.()}
      >
        {entry.image
          ? <img className="menu-item-icon" src={entry.image} width={13} height={13} alt="" draggable={false} />
          : entry.icon && <Icon name={entry.icon} size={13} className="menu-item-icon" />}
        <span className="menu-item-label">{entry.label}</span>
        {entry.accelerator && <span className="menu-item-accel">{acceleratorLabel(entry.accelerator)}</span>}
      </Item>
    ));
}

/**
 * 弹系统原生右键菜单并执行选中项。
 * 菜单项里的图标/危险色等样式由系统决定，这里只传文本与可用状态。
 */
export async function popupNativeMenu(entries: MenuEntry[]) {
  if (entries.length === 0)
    return;

  const toNativeItem = async (entry: MenuEntry, id: string): Promise<NativeMenuItem> => {
    if (entry.separator)
      return { type: "separator" as const };

    return {
      id,
      label: entry.label ?? "",
      enabled: !entry.disabled,
      /* 快捷键提示由系统右对齐显示，不注册成全局快捷键 */
      accelerator: entry.accelerator,
      /* 有图标就先栅格化成 PNG，系统菜单才能显示（品牌 logo 走 image） */
      icon: entry.image
        ? await imageDataUrl(entry.image) ?? undefined
        : entry.icon
          ? await menuIconDataUrl(entry.icon, entry.iconColor) ?? undefined
          : undefined,
      /* 二级菜单：递归转换，id 用 2 / 2.1 这样的路径 */
      submenu: entry.children
        ? await Promise.all(entry.children.map((child, childIndex) => toNativeItem(child, `${id}.${childIndex}`)))
        : undefined
    };
  };

  const items: NativeMenuItem[] = await Promise.all(
    entries.map((entry, index) => toNativeItem(entry, String(index)))
  );

  const chosen = await showMenu(items);

  if (chosen == null)
    return;

  /* 按路径找到被点的那一项（二级菜单是 "2.1" 这种 id） */
  let list = entries;
  let found: MenuEntry | undefined;

  for (const part of chosen.split(".")) {
    found = list[Number(part)];

    if (!found)
      return;

    list = found.children ?? [];
  }

  found?.action?.();
}

/** 顶部菜单栏的一项：点击 / 悬停展开 */
export function MenuButton(props: {
  label: string;
  entries: MenuEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 额外的类名（比如面板里的小按钮样式） */
  className?: string;
  /** 按钮左侧图标（lucide 名） */
  icon?: string;
}) {
  const { label, entries, open, onOpenChange, className, icon } = props;

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenu.Trigger
        className={`menu${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
        /* Windows 习惯：鼠标移上去就展开 */
        onPointerEnter={() => onOpenChange(true)}
      >
        {icon && <Icon name={icon} size={13} />}
        {label}
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu-dropdown"
          align="start"
          sideOffset={2}
          collisionPadding={8}
        >
          {renderEntries(entries, { Item: DropdownMenu.Item, Separator: DropdownMenu.Separator })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

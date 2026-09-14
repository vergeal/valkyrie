import { useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icon } from "./icons";
import { SYSTEM_FONT } from "../settings";

interface FontSelectProps {
  value: string;
  /** 第一项通常是「系统默认」，其后是本机字体 */
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}

/**
 * 字体选择器：本机字体可能有几百个，用带搜索框的下拉而不是普通 Select。
 * 用 Radix DropdownMenu 承载，才能和设置窗口（Radix Dialog 焦点陷阱）正确共存；
 * 每项用自身字体预览，「系统默认」用继承字体。
 */
export function FontSelect({ value, options, onChange, ariaLabel }: FontSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open)
      return;

    setQuery("");
    /* Radix 打开时默认聚焦第一项，改成聚焦搜索框 */
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);

    return () => window.clearTimeout(timer);
  }, [open]);

  const current = options.find(option => option.value === value);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () => needle ? options.filter(option => option.label.toLowerCase().includes(needle)) : options,
    [options, needle]
  );

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`vk-select-btn${open ? " is-open" : ""}`}
          aria-label={ariaLabel}
          title={current?.label}
        >
          <span className="vk-select-value">{current?.label ?? "—"}</span>
          <Icon name="chevronDown" size={12} className="vk-select-caret" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="vk-font-select-menu"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          {/* 阻止按键冒泡到 Radix 的 typeahead，输入框才能正常打字 */}
          <div className="vk-font-select-search" onKeyDown={event => event.stopPropagation()}>
            <Icon name="search" size={12} />
            <input
              ref={inputRef}
              type="search"
              value={query}
              placeholder="搜索字体…"
              aria-label="搜索字体"
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Escape")
                  setOpen(false);

                if (event.key === "Enter" && filtered[0]) {
                  onChange(filtered[0].value);
                  setOpen(false);
                }
              }}
            />
          </div>

          {filtered.length === 0 && <div className="vk-font-select-empty">没有匹配的字体</div>}

          <div className="vk-font-select-list">
            {filtered.map(option => (
              <DropdownMenu.Item
                key={option.value}
                className={`vk-font-select-item${option.value === value ? " is-active" : ""}`}
                style={option.value === SYSTEM_FONT ? undefined : { fontFamily: `"${option.value}"` }}
                onSelect={() => onChange(option.value)}
              >
                <span className="vk-font-select-name">{option.label}</span>
                {option.value === value && <Icon name="check" size={12} />}
              </DropdownMenu.Item>
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

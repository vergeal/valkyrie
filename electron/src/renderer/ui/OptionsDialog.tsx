import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Dialog } from "./Dialog";
import { Icon } from "./icons";
import { FontSelect } from "./FontSelect";
import { NumberField } from "./NumberField";
import { Select } from "./Select";
import {
  DEFAULT_SETTINGS,
  FALLBACK_FONT_FAMILIES,
  LOG_LIMIT_OPTIONS,
  PAGE_SIZE_OPTIONS,
  SYSTEM_FONT,
  TAB_SIZE_OPTIONS,
  listSystemFonts,
  type AppSettings,
  type FontKind,
  type FontOption,
  type ThemeMode
} from "../settings";
import { IS_MAC } from "../keys";

interface OptionsDialogProps {
  settings: AppSettings;
  theme: ThemeMode;
  onChange: (patch: Partial<AppSettings>) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onClose: () => void;
}

interface SettingRow {
  key: string;
  label: string;
  desc: string;
  /** 搜索时一并匹配的额外关键字 */
  keywords?: string;
  control: ReactNode;
}

interface Category {
  id: string;
  label: string;
  icon: string;
  rows: SettingRow[];
}

function sizeOptions(values: number[], unit = "px") {
  return values.map(value => ({ value: String(value), label: `${value} ${unit}`.trim() }));
}

/**
 * 选项：左侧分类 + 右侧设置项的专业设置窗口（参考 VS Code / IDEA 的偏好设置），
 * 顶部带搜索，改完立即生效并持久化到 settings.json。
 */
export function OptionsDialog(props: OptionsDialogProps) {
  const { settings, theme, onChange, onThemeChange, onClose } = props;
  const [active, setActive] = useState("appearance");
  const [keyword, setKeyword] = useState("");
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  /* 枚举本机字体：列表里给出系统里的所有字体供选择 */
  useEffect(() => {
    let alive = true;

    void listSystemFonts().then(fonts => {
      if (alive)
        setSystemFonts(fonts);
    });

    return () => {
      alive = false;
    };
  }, []);

  /**
   * 字体下拉：系统默认 + 本机已装字体 + 常见编程字体兜底 + 当前值
   * （当前值可能已不在系统里，仍要能显示出来）。
   */
  function fontFamilyOptions(kind: FontKind, current: string): FontOption[] {
    const systemLabel = kind === "ui"
      ? "系统默认"
      : IS_MAC
        ? (kind === "editor" ? "系统默认（Monaco）" : "系统默认（Menlo）")
        : "系统默认（Consolas）";

    const options: FontOption[] = [{ value: SYSTEM_FONT, label: systemLabel }];
    const seen = new Set<string>([SYSTEM_FONT]);

    const add = (family: string) => {
      if (family && !seen.has(family)) {
        seen.add(family);
        options.push({ value: family, label: family });
      }
    };

    systemFonts.forEach(add);
    FALLBACK_FONT_FAMILIES.forEach(add);
    add(current);

    return options;
  }

  function check(key: keyof AppSettings, label: string, desc: string, keywords?: string): SettingRow {
    return {
      key,
      label,
      desc,
      keywords,
      control: (
        <input
          type="checkbox"
          checked={Boolean(settings[key])}
          aria-label={label}
          onChange={event => onChange({ [key]: event.target.checked } as Partial<AppSettings>)}
        />
      )
    };
  }

  function pick(
    key: keyof AppSettings,
    label: string,
    desc: string,
    value: string,
    options: { value: string; label: string }[],
    keywords?: string
  ): SettingRow {
    return {
      key,
      label,
      desc,
      keywords,
      control: (
        <Select
          value={value}
          options={options}
          aria-label={label}
          onChange={next => onChange({ [key]: next } as Partial<AppSettings>)}
        />
      )
    };
  }

  /** 字体选择：列出本机所有字体，可搜索 */
  function font(key: keyof AppSettings, label: string, kind: FontKind, desc: string, keywords?: string): SettingRow {
    const current = String(settings[key] ?? SYSTEM_FONT);

    return {
      key,
      label,
      desc,
      keywords,
      control: (
        <FontSelect
          value={current}
          options={fontFamilyOptions(kind, current)}
          ariaLabel={label}
          onChange={next => onChange({ [key]: next } as Partial<AppSettings>)}
        />
      )
    };
  }

  /** 数字输入：不限档位，用户自己填 */
  function number(key: keyof AppSettings, label: string, desc: string, min: number, max: number, keywords?: string): SettingRow {
    return {
      key,
      label,
      desc,
      keywords,
      control: (
        <NumberField
          value={Number(settings[key])}
          min={min}
          max={max}
          ariaLabel={label}
          onChange={next => onChange({ [key]: next } as Partial<AppSettings>)}
        />
      )
    };
  }

  const categories: Category[] = useMemo(() => [
    {
      id: "appearance",
      label: "外观",
      icon: "sun",
      rows: [
        {
          key: "theme",
          label: "主题",
          desc: "浅色 / 深色 / 跟随系统；深色使用 GitHub Dark 配色",
          keywords: "theme dark light 深色 浅色",
          control: (
            <Select
              value={theme}
              aria-label="主题"
              options={[
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
                { value: "system", label: "跟随系统" }
              ]}
              onChange={value => onThemeChange(value as ThemeMode)}
            />
          )
        },
        font("uiFontFamily", "字体", "ui", "菜单、工具栏、对象树等界面文字使用的字体，可搜索本机字体", "font 字体 系统字体"),
        number("uiFontSize", "界面字号", "菜单、工具栏、对象树等界面文字大小（px）", 10, 28, "font 字体 字号"),
        check("startMaximized", "启动时最大化窗口", "关闭后按上次的窗口大小启动"),
        check("gridHeaderType", "结果表头显示字段类型", "关掉后表头只显示字段名，行高更紧凑"),
        check("gridRowNumbers", "结果表显示行号列", "左侧的 # 列"),
        check("gridZebra", "结果表斑马纹", "隔行浅色，便于横向读数据")
      ]
    },
    {
      id: "editor",
      label: "编辑器",
      icon: "code",
      rows: [
        number("editorFontSize", "字号", "SQL 编辑器的文字大小（px）", 10, 40, "font 字体 字号"),
        font("editorFontFamily", "字体", "editor", "默认用系统字体；也可指定本机已安装的字体，可搜索", "font 字体 系统字体"),
        pick("editorTabSize", "缩进宽度", "一个制表符等于几个空格", String(settings.editorTabSize),
          sizeOptions(TAB_SIZE_OPTIONS, "空格")),
        check("editorWordWrap", "自动换行", "长语句折行显示，不用左右滚动"),
        check("editorLineNumbers", "显示行号", "编辑器左侧的行号栏"),
        check("editorWhitespace", "显示空格与缩进标记", "缩进的空格画成点、制表符画成箭头，并画出缩进参考线（默认关闭）",
          "whitespace 空白 空格 缩进 点 参考线"),
        check("editorMinimap", "显示缩略图", "右侧的代码缩略图（大文件时更耗性能）"),
        check("suggestEnabled", "智能提示", "关键字 / 表名 / 字段补全；快捷键可手动触发")
      ]
    },
    {
      id: "grid",
      label: "数据表格",
      icon: "table",
      rows: [
        number("gridFontSize", "字号", "结果表与对象列表的文字大小（px）", 10, 28, "font 字体 字号"),
        font("gridFontFamily", "字体", "grid", "默认用系统字体；也可指定本机已安装的字体，可搜索", "font 字体 系统字体"),
        pick("pageSize", "默认行数限制", "数据页每次读取的行数", String(settings.pageSize),
          PAGE_SIZE_OPTIONS.map(value => ({ value: String(value), label: `${value} 行` })), "分页 行数")
      ]
    },
    {
      id: "query",
      label: "查询与日志",
      icon: "terminal",
      rows: [
        pick("logLimit", "日志最多保留条数", "超出后丢弃最早的记录", String(settings.logLimit),
          LOG_LIMIT_OPTIONS.map(value => ({ value: String(value), label: `${value} 条` })), "log 日志 条数")
      ]
    }
  ], [settings, theme, onChange, onThemeChange, systemFonts]);

  const needle = keyword.trim().toLowerCase();
  const matched = useMemo(() => categories
    .map(category => ({
      ...category,
      rows: needle
        ? category.rows.filter(row =>
            `${row.label} ${row.desc} ${row.keywords ?? ""} ${category.label}`.toLowerCase().includes(needle))
        : category.rows
    }))
    .filter(category => category.rows.length > 0), [categories, needle]);

  const current = matched.find(category => category.id === active) ?? matched[0];

  return (
    <Dialog
      title={<><Icon name="sliders" size={14} />选项</>}
      className="options-dialog"
      onClose={onClose}
    >
      <div className="options-search">
        <Icon name="search" size={13} />
        <input
          type="search"
          value={keyword}
          placeholder="搜索设置…"
          aria-label="搜索设置"
          onChange={event => setKeyword(event.target.value)}
        />
      </div>

      <div className="options-tabs">
        <nav className="options-nav" aria-label="设置分类">
          {matched.map(category => (
            <button
              key={category.id}
              type="button"
              className={`options-nav-item${current?.id === category.id ? " is-active" : ""}`}
              onClick={() => setActive(category.id)}
            >
              <Icon name={category.icon} size={13} />
              {category.label}
            </button>
          ))}
        </nav>

        <div className="options-body">
          {current
            ? current.rows.map(row => (
              <div className="opt-row" key={`${current.id}-${row.key}`}>
                <span className="opt-text">
                  <span className="opt-label">{row.label}</span>
                  <span className="opt-desc">{row.desc}</span>
                </span>
                <span className="opt-control">{row.control}</span>
              </div>
            ))
            : <div className="empty">没有匹配「{keyword}」的设置</div>}
        </div>
      </div>

      <div className="modal-actions options-actions">
        <button
          type="button"
          className="mini-btn"
          onClick={() => {
            onChange(DEFAULT_SETTINGS);
            onThemeChange(DEFAULT_SETTINGS.theme);
          }}
        >
          <Icon name="refresh" size={13} />恢复默认值
        </button>
        <span className="modal-actions-push" />
        <button type="button" className="mini-btn is-default" onClick={onClose}>关闭</button>
      </div>
    </Dialog>
  );
}

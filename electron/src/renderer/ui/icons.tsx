import {
  ArrowDownToLine,
  Calendar,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code,
  Columns3,
  Copy,
  Database,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Info,
  KeyRound,
  Layers,
  List,
  Lock,
  MonitorSmartphone,
  Moon,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  TextWrap,
  Trash2,
  TriangleAlert,
  User,
  X
} from "lucide-react";
import type { ComponentType } from "react";

/**
 * 表格图标：Excel 风格的绿色底 + 白色网格，比线性图标更容易一眼认出"表"。
 */
export function SheetIcon({ size = 14, className }: { size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0.5" y="1.5" width="15" height="13" rx="2.2" fill="#21a366" />
      <path
        d="M5.5 1.5v13M10.5 1.5v13M0.5 6h15M0.5 10h15"
        stroke="#ffffff"
        strokeWidth="1"
        opacity="0.92"
      />
    </svg>
  );
}

/**
 * 图标名到 Lucide 组件的映射，保持调用方只依赖语义名。
 */
const ICONS: Record<string, ComponentType<{ size?: number; className?: string; strokeWidth?: number }>> = {
  database: Database,
  table: SheetIcon,
  folder: Folder,
  folderOpen: FolderOpen,
  terminal: Terminal,
  play: Play,
  stop: Square,
  refresh: RefreshCw,
  plus: Plus,
  search: Search,
  columns: Columns3,
  key: KeyRound,
  download: Download,
  check: Check,
  close: X,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  info: Info,
  code: Code,
  list: List,
  layers: Layers,
  trash: Trash2,
  copy: Copy,
  eraser: Eraser,
  wrap: TextWrap,
  latest: ArrowDownToLine,
  sun: Sun,
  moon: Moon,
  system: MonitorSmartphone,
  calendar: Calendar,
  calendarClock: CalendarClock,
  clock: Clock,
  /* 连接 / 表单类 */
  server: Server,
  host: HardDrive,
  user: User,
  lock: Lock,
  eye: Eye,
  eyeOff: EyeOff,
  file: FileText,
  save: Save,
  pencil: Pencil,
  plug: Plug,
  shield: ShieldCheck,
  sliders: SlidersHorizontal,
  alert: TriangleAlert,
  ok: CircleCheck,
  fail: CircleAlert
};

/**
 * 图标语义色（浅色主题取值，深色主题对应值见 styles.css 的 .icon-* 规则）。
 * 供系统原生菜单栅格化时取色，保证原生菜单里的图标也是彩色的。
 */
export const ICON_COLORS: Record<string, string> = {
  play: "#15a34a",
  plus: "#15a34a",
  check: "#15a34a",
  save: "#15a34a",
  plug: "#15a34a",
  shield: "#15a34a",
  ok: "#15a34a",
  stop: "#dc2626",
  trash: "#dc2626",
  alert: "#dc2626",
  fail: "#dc2626",
  refresh: "#2563eb",
  copy: "#2563eb",
  database: "#2563eb",
  host: "#2563eb",
  server: "#2563eb",
  pencil: "#2563eb",
  info: "#2563eb",
  latest: "#2563eb",
  search: "#0284c7",
  terminal: "#0284c7",
  wrap: "#0891b2",
  columns: "#0891b2",
  system: "#0891b2",
  code: "#7c3aed",
  layers: "#7c3aed",
  download: "#7c3aed",
  moon: "#7c3aed",
  sliders: "#7c3aed",
  user: "#7c3aed",
  folder: "#d97706",
  folderOpen: "#d97706",
  key: "#d97706",
  lock: "#d97706",
  sun: "#d97706",
  eraser: "#ea580c",
  list: "#0d9488",
  file: "#0d9488",
  calendar: "#2563eb",
  calendarClock: "#2563eb",
  clock: "#2563eb"
};

interface IconProps {
  name: string;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 14, className }: IconProps) {
  const Component = ICONS[name] ?? Info;

  /* 带上 icon-<名字>，颜色由 styles.css 里的语义色规则给 */
  return (
    <Component
      size={size}
      className={`icon icon-${name}${className ? ` ${className}` : ""}`}
      strokeWidth={1.7}
    />
  );
}

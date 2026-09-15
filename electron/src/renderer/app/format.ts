import type { ProgressEvent } from "../api";

export function formatProgress(event: ProgressEvent): string {
  const detail = event.detail ?? "";
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });

  switch (event.kind) {
    case "execute":
      return `[${time}] execute  ${detail}`;
    case "query":
      return `[${time}] query    ${detail}`;
    case "skip":
      return `[${time}] skip     ${detail}`;
    case "update":
      return `[${time}] update   ${detail}`;
    case "rows":
      return `[${time}] 影响行数 ${detail}`;
    case "cost":
      return `[${time}] 耗时 ${detail} ms`;
    default:
      return "";
  }
}

/** 语句级报错也写进日志面板：格式与执行日志一致 */
export function formatErrorLog(message: string): string {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });

  return `[${time}] error    ${message}`;
}

/**
 * 磁盘占用换算：数据层统一返回字节，这里换算成 B / KB / MB / GB / TB。
 * 只用于展示，排序请用原始字节数比较。
 */
export function formatByteSize(bytes?: number | null): string {
  if (bytes == null)
    return "-";

  if (bytes < 1024)
    return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(1)} ${units[index]}`;
}

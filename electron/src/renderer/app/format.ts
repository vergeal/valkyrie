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

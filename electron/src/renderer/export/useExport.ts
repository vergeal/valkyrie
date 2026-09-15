import { useEffect, useRef, useState } from "react";
import { chooseSavePath, invoke, messageOf, onEvent, type ProgressEvent, type SchemaNode } from "../api";
import type { ExportProgress, SessionState } from "../app/appTypes";
import { tableParams } from "../table/tableHelpers";

interface UseExportOptions {
  /** 当前结果集的 jobId（导出查询结果用），没有则导出入口静默返回 */
  resultJobId: number | undefined;
  /** 表 / 库 / 模式节点 → 会话（按节点所属连接取） */
  resolveSession: (node: SchemaNode) => SessionState | null;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

/**
 * 导出生命周期：结果集导出（CSV / Excel）、单表与整库导出（.sql），
 * 以及后端按表 / 分页上报的进度事件与进度百分比。
 */
export function useExport(options: UseExportOptions) {
  const { resultJobId, resolveSession, onError, onStatus } = options;
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  /* 当前这次导出的 token：只接受与它匹配的进度事件，避免多次导出串台 */
  const exportTokenRef = useRef<string | null>(null);

  useEffect(() => {
    return onEvent((event: ProgressEvent) => {
      if (event.channel !== "export.progress")
        return;

      const progress = event as ProgressEvent & {
        token?: string; current?: number; total?: number; totalRows?: number;
        table?: string; rows?: number; phase?: string;
      };

      if (progress.token && progress.token === exportTokenRef.current)
        setExportProgress({
          token: progress.token,
          current: progress.current ?? 0,
          total: progress.total ?? 0,
          totalRows: progress.totalRows ?? 0,
          table: progress.table,
          rows: progress.rows ?? 0,
          phase: progress.phase
        });
    });
  }, []);

  async function exportResult(format: "csv" | "excel") {
    if (!resultJobId)
      return;

    const extension = format === "csv" ? "csv" : "xlsx";
    const target = await chooseSavePath({
      title: "导出查询结果",
      defaultPath: `result-${Date.now()}.${extension}`,
      filters: format === "csv"
        ? [{ name: "CSV 文件", extensions: ["csv"] }]
        : [{ name: "Excel 文件", extensions: ["xlsx"] }]
    });

    if (!target)
      return;

    try {
      await invoke("result.export", { jobId: resultJobId, format, path: target });
      onStatus(`已导出到 ${target}`);
    } catch (e) {
      onError(messageOf(e));
    }
  }

  /** 导出单张表：结构，或结构 + 数据（写成一份 .sql） */
  async function exportTableSql(node: SchemaNode, withData: boolean) {
    const target = resolveSession(node);

    if (!target)
      return;

    const path = await chooseSavePath({
      title: withData ? "导出表结构和数据" : "导出表结构",
      defaultPath: `${node.label}.sql`,
      filters: [{ name: "SQL 文件", extensions: ["sql"] }]
    });

    if (!path)
      return;

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    exportTokenRef.current = token;
    setExportProgress({ token, current: 0, total: 0, totalRows: 0, table: node.label, rows: 0, phase: "count" });

    try {
      const payload = await invoke<{ tables: number; rows: number }>("table.export", {
        ...tableParams(target.sessionId, node),
        path,
        withData,
        token
      });

      onStatus(withData
        ? `已导出 ${node.label}（${payload.rows} 行）到 ${path}`
        : `已导出 ${node.label} 表结构到 ${path}`);
    } catch (e) {
      onError(messageOf(e));
    } finally {
      exportTokenRef.current = null;
      setExportProgress(null);
    }
  }

  /** 导出整个数据库 / 模式下所有表：结构，或结构 + 数据 */
  async function exportDatabaseSql(node: SchemaNode, withData: boolean) {
    const target = resolveSession(node);

    if (!target)
      return;

    const path = await chooseSavePath({
      title: withData ? "导出数据库结构和数据" : "导出数据库结构",
      defaultPath: `${node.label}.sql`,
      filters: [{ name: "SQL 文件", extensions: ["sql"] }]
    });

    if (!path)
      return;

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    exportTokenRef.current = token;
    setExportProgress({ token, current: 0, total: 0, totalRows: 0, table: node.label, rows: 0, phase: "count" });

    try {
      const payload = await invoke<{ tables: number; rows: number }>("database.export", {
        sessionId: target.sessionId,
        catalog: node.catalog ?? (node.kind === "CATALOG" ? node.label : undefined),
        schema: node.schema ?? (node.kind === "SCHEMA" ? node.label : undefined),
        path,
        withData,
        token
      });

      onStatus(withData
        ? `已导出 ${payload.tables} 张表（${payload.rows} 行）到 ${path}`
        : `已导出 ${payload.tables} 张表的结构到 ${path}`);
    } catch (e) {
      onError(messageOf(e));
    } finally {
      exportTokenRef.current = null;
      setExportProgress(null);
    }
  }

  /* 导出进度百分比：按真实行数走；总行数未知时退回表数；都未知则 null（走不确定动画） */
  const exportPercent = (() => {
    if (!exportProgress || exportProgress.phase !== "dump")
      return null;

    if (exportProgress.totalRows > 0)
      return Math.min(100, Math.round((exportProgress.rows / exportProgress.totalRows) * 100));

    if (exportProgress.total > 0)
      return Math.min(100, Math.round((exportProgress.current / exportProgress.total) * 100));

    return null;
  })();

  return { exportProgress, exportResult, exportTableSql, exportDatabaseSql, exportPercent };
}

import { useEffect, useRef } from "react";
import { confirmClose, onCloseRequest, showMessage } from "../api";
import type { WorkTab } from "./appTypes";
import { describeUnsaved, hasUnsaved, type SqlResolver } from "../tabs/tabHelpers";

/**
 * 关闭窗口 / 退出应用前的未保存兜底：
 * 主进程拦下关闭请求后，这里检查有没有未保存的标签页 —— 没有就直接放行，
 * 有就弹原生对话框列出这些标签，用户确认后才真正关闭。
 */
export function useCloseGuard(tabs: WorkTab[], resolveSql?: SqlResolver) {
  /* 事件只在挂载时订阅一次，用 ref 取最新的标签状态 */
  const tabsRef = useRef(tabs);
  const resolveRef = useRef(resolveSql);
  /* 确认框弹出期间忽略重复的关闭请求（点两次关闭按钮等） */
  const askingRef = useRef(false);

  tabsRef.current = tabs;
  resolveRef.current = resolveSql;

  useEffect(() => {
    return onCloseRequest(() => {
      if (askingRef.current)
        return;

      const unsaved = tabsRef.current.filter(tab => hasUnsaved(tab, resolveRef.current));

      if (unsaved.length === 0) {
        confirmClose(true);
        return;
      }

      askingRef.current = true;

      void showMessage({
        type: "warning",
        title: "未保存的修改",
        message: "以下标签还有没保存的内容：",
        detail: `${unsaved.map(tab => describeUnsaved(tab, resolveRef.current)).join("\n")}\n\n关闭后改动会丢失，确定关闭吗？`,
        buttons: ["取消", "退出"]
      }).then(response => {
        askingRef.current = false;
        confirmClose(response === 1);
      }).catch(() => {
        /* 弹框失败时保守处理：不关闭，避免误丢改动 */
        askingRef.current = false;
        confirmClose(false);
      });
    });
  }, []);
}

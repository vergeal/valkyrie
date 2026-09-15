import { useEffect, useState } from "react";
import { toast } from "sonner";
import { onWindowState, showMessage } from "../api";

/**
 * 真正属于 App root 的生命周期与全局 UI 状态：
 * 状态栏文案、忙碌计数、正在执行的动作、错误提示（系统原生消息框）、窗口最大化。
 */
export function useAppLifecycle() {
  const [status, setStatus] = useState("就绪");
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  /* 正在执行的动作（按钮名），用于给按钮本身加加载态 */
  const [pending, setPending] = useState<string | null>(null);

  /* 操作反馈：浮层提示（sonner）+ 状态栏转圈，让用户知道动作确实执行了 */
  function flash(text: string) {
    toast.success(text);
  }

  async function withBusy<T>(action: () => Promise<T>): Promise<T> {
    setBusy(value => value + 1);
    try {
      return await action();
    } finally {
      setBusy(value => value - 1);
    }
  }

  /* 错误提示走系统原生消息框（不是网页弹层） */
  useEffect(() => {
    if (!error)
      return;

    void showMessage({
      type: "error",
      title: "出错了",
      message: error,
      buttons: ["确定"]
    });
  }, [error]);

  useEffect(() => {
    return onWindowState(state => setMaximized(state.maximized));
  }, []);

  /* 旧版记住的「结果区很高」布局会让默认值不生效，这里清一次让它回到新默认 */
  useEffect(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.includes("valkyrie.layout.rows") && !key.includes("rows-v4"))
        window.localStorage.removeItem(key);
    }
  }, []);

  return { status, setStatus, maximized, error, setError, busy, pending, setPending, flash, withBusy };
}

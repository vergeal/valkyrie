import { messageOf } from "../api";

/** 复制文本并给状态栏反馈：成功提示前 40 字，失败走错误通道。 */
export async function copyTextToClipboard(
  text: string,
  callbacks: { onStatus: (message: string) => void; onError: (message: string) => void }
): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
    callbacks.onStatus(`已复制：${text.length > 40 ? text.slice(0, 40) + "…" : text}`);
  } catch (e) {
    callbacks.onError(messageOf(e));
  }
}

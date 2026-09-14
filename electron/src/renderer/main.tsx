import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { IS_MAC } from "./keys";
import { preloadSystemFonts } from "./settings";
import "./styles.css";
import "sonner/dist/styles.css";

/* 平台类挂到 <html>：字体等基样式要覆盖到 body 下的 Portal（下拉 / 弹窗） */
document.documentElement.classList.toggle("is-mac", IS_MAC);

/* 启动时先把本机字体列表取回来并预热，避免之后打开设置 / 字体下拉卡顿 */
preloadSystemFonts();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

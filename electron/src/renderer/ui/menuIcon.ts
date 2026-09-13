import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon, ICON_COLORS } from "./icons";

/** 菜单图标尺寸：Windows 原生菜单按 16px 逻辑尺寸绘制 */
const ICON_SIZE = 16;

/* 同一个图标只栅格化一次 */
const cache = new Map<string, Promise<string | null>>();

/**
 * 把应用内图标渲染成 PNG data URL，供系统原生菜单使用。
 * 原生菜单只接受位图（SVG 不支持），所以这里用 canvas 栅格化一次并缓存。
 */
export function menuIconDataUrl(name: string, color?: string): Promise<string | null> {
  /* 没指定颜色就用该图标的语义色，原生菜单里的图标同样是彩色的 */
  const resolved = color ?? ICON_COLORS[name] ?? "#6b7280";
  const key = `${name}|${resolved}`;
  const cached = cache.get(key);

  if (cached)
    return cached;

  const pending = (async () => {
    try {
      const markup = renderToStaticMarkup(
        createElement(Icon, { name, size: ICON_SIZE }) as unknown as ReactElement
      ).replace(/currentColor/g, resolved);

      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      await image.decode();

      const canvas = document.createElement("canvas");
      canvas.width = ICON_SIZE;
      canvas.height = ICON_SIZE;

      const context = canvas.getContext("2d");

      if (!context)
        return null;

      context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  })();

  cache.set(key, pending);
  return pending;
}

/**
 * 把位图资源（各数据库的品牌 logo）缩到菜单图标尺寸并转成 PNG data URL，
 * 供系统原生菜单使用；同一地址只处理一次。
 */
export function imageDataUrl(url: string, size = ICON_SIZE): Promise<string | null> {
  const key = `img|${url}|${size}`;
  const cached = cache.get(key);

  if (cached)
    return cached;

  const pending = (async () => {
    try {
      const image = new Image();

      image.src = url;
      await image.decode();

      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;

      const context = canvas.getContext("2d");

      if (!context)
        return null;

      /* 等比缩放到方形画布内居中，避免 logo 被拉变形 */
      const scale = Math.min(size / image.width, size / image.height);
      const width = image.width * scale;
      const height = image.height * scale;

      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  })();

  cache.set(key, pending);
  return pending;
}

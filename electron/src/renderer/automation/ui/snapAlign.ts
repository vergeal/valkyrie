/**
 * 卡片拖动对齐磁吸：拖动时把卡片贴到其它卡片的边 / 中线上，并给出要画的辅助线。
 * 只做纯计算，不碰 DOM 与 reactflow，方便单独验证。
 */

export interface AlignRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AlignGuide {
  /** true = 竖线（x 恒定，from / to 是 y 区间）；false = 横线 */
  vertical: boolean;
  at: number;
  from: number;
  to: number;
}

export interface SnapResult {
  /** 叠在原始位置上让卡片贴线的位移 */
  dx: number;
  dy: number;
  guides: AlignGuide[];
}

/** 一条候选线：坐标 + 落在这条线上的卡片范围（画辅助线用） */
interface AlignLine {
  at: number;
  start: number;
  end: number;
}

/** 卡片在一条轴上的三条线：起边 / 中线 / 终边 */
function edgePositions(start: number, size: number): number[] {
  return [start, start + size / 2, start + size];
}

/** 包住一组卡片的矩形（拖动多张卡片时按整体对齐） */
export function boundingRect(rects: AlignRect[]): AlignRect {
  const x = Math.min(...rects.map(rect => rect.x));
  const y = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.w));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.h));

  return { x, y, w: right - x, h: bottom - y };
}

/** 收集候选线：axis = "x" 出竖线（跨 y 方向），axis = "y" 出横线 */
function collectLines(rects: AlignRect[], axis: "x" | "y"): AlignLine[] {
  const lines = new Map<number, AlignLine>();

  for (const rect of rects) {
    const at = axis === "x" ? rect.x : rect.y;
    const size = axis === "x" ? rect.w : rect.h;
    const start = axis === "x" ? rect.y : rect.x;
    const extent = axis === "x" ? rect.h : rect.w;

    for (const value of edgePositions(at, size)) {
      const line = lines.get(value);

      if (line) {
        line.start = Math.min(line.start, start);
        line.end = Math.max(line.end, start + extent);
      } else {
        lines.set(value, { at: value, start, end: start + extent });
      }
    }
  }

  return [...lines.values()];
}

/** 在一条轴上找最近的可吸附线 */
function snapAxis(
  rect: AlignRect,
  lines: AlignLine[],
  axis: "x" | "y",
  threshold: number
): { delta: number; guide: AlignGuide | null } {
  const at = axis === "x" ? rect.x : rect.y;
  const size = axis === "x" ? rect.w : rect.h;
  const start = axis === "x" ? rect.y : rect.x;
  const extent = axis === "x" ? rect.h : rect.w;
  let best: { delta: number; line: AlignLine } | null = null;

  for (const source of edgePositions(at, size)) {
    for (const line of lines) {
      const delta = line.at - source;

      if (Math.abs(delta) > threshold)
        continue;

      if (!best || Math.abs(delta) < Math.abs(best.delta))
        best = { delta, line };
    }
  }

  if (!best)
    return { delta: 0, guide: null };

  /* 辅助线要连到参与对齐的卡片上，所以取两者并集 */
  return {
    delta: best.delta,
    guide: {
      vertical: axis === "x",
      at: best.line.at,
      from: Math.min(start, best.line.start),
      to: Math.max(start + extent, best.line.end)
    }
  };
}

/**
 * 把 rect 跟其它卡片做边 / 中线对齐。
 * threshold 用 flow 坐标：调用方按当前缩放换算（屏幕上的手感距离 / zoom）。
 */
export function snapRect(rect: AlignRect, others: AlignRect[], threshold: number): SnapResult {
  if (others.length === 0 || threshold <= 0)
    return { dx: 0, dy: 0, guides: [] };

  const vertical = snapAxis(rect, collectLines(others, "x"), "x", threshold);
  const horizontal = snapAxis(rect, collectLines(others, "y"), "y", threshold);
  const guides = [vertical.guide, horizontal.guide].filter((guide): guide is AlignGuide => guide !== null);

  return { dx: vertical.delta, dy: horizontal.delta, guides };
}

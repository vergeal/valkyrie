export interface TableRef {
  word: string;
  start: number;
  end: number;
}

/**
 * 标出文本里处于注释 / 字符串中的字符位置（1 = 跳过）。
 * 支持 `--`、`//`、`#` 行注释，斜杠星号块注释（含文档注释），`'...'` 字符串（`''` 转义）。
 * 这些位置不做表名识别，避免注释里的 SQL 被高亮 / 当成可点击。
 */
function markExcluded(text: string): Uint8Array {
  const excluded = new Uint8Array(text.length);
  const length = text.length;
  let i = 0;

  while (i < length) {
    const c = text[i];

    /* 行注释：--、//、# 都算 */
    if ((c === "-" && text[i + 1] === "-") || (c === "/" && text[i + 1] === "/") || c === "#") {
      while (i < length && text[i] !== "\n")
        excluded[i++] = 1;

      continue;
    }

    /* 块注释：斜杠星号开始，星号斜杠结束（文档注释同理） */
    if (c === "/" && text[i + 1] === "*") {
      while (i < length && !(text[i] === "*" && text[i + 1] === "/"))
        excluded[i++] = 1;

      /* 收尾的两个字符也跳过 */
      if (i < length) {
        excluded[i++] = 1;

        if (i < length)
          excluded[i++] = 1;
      }

      continue;
    }

    if (c === "'") {
      excluded[i++] = 1;

      while (i < length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            excluded[i++] = 1;
            excluded[i++] = 1;
            continue;
          }

          excluded[i++] = 1;
          break;
        }

        excluded[i++] = 1;
      }

      continue;
    }

    i++;
  }

  return excluded;
}

/** 提取文本里命中的表名（大小写不敏感），自动跳过注释 / 字符串 */
export function collectTableRefs(text: string, names: Set<string>): TableRef[] {
  const refs: TableRef[] = [];

  if (!names || names.size === 0)
    return refs;

  const excluded = markExcluded(text);
  const pattern = /[A-Za-z_][\w$]*/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (excluded[match.index])
      continue;

    const word = match[0];

    if (names.has(word.toLowerCase()))
      refs.push({ word, start: match.index, end: match.index + word.length });
  }

  return refs;
}

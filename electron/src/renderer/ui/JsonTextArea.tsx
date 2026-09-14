import { useMemo, useRef, type RefObject } from "react";

interface JsonTextAreaProps {
  value: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  className?: string;
  ariaLabel?: string;
  spellCheck?: boolean;
}

/** 内容是不是 JSON 对象 / 数组（只有结构化 JSON 才值得高亮） */
function parseJsonObject(source: string): unknown | null {
  const text = source.trim();

  if (!text || (text[0] !== "{" && text[0] !== "["))
    return null;

  try {
    const parsed = JSON.parse(text);

    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

const escapeHtml = (text: string) => text.replace(/[&<>]/g, char => HTML_ESCAPES[char]);

/**
 * 把原始 JSON 文本按 token 包成带类名的 span（不改动空白与格式，
 * 这样高亮层与输入框逐字对齐）。串是键还是值看它后面第一个非空白字符是不是冒号。
 */
function highlightJson(source: string): string {
  let html = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    /* 字符串 */
    if (char === '"') {
      let end = index + 1;

      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }

        if (source[end] === '"') {
          end++;
          break;
        }

        end++;
      }

      let lookahead = end;

      while (lookahead < source.length && /\s/.test(source[lookahead]))
        lookahead++;

      const kind = source[lookahead] === ":" ? "key" : "string";

      html += `<span class="tok-${kind}">${escapeHtml(source.slice(index, end))}</span>`;
      index = end;
      continue;
    }

    /* 数字 */
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));

    if (number) {
      html += `<span class="tok-number">${number[0]}</span>`;
      index += number[0].length;
      continue;
    }

    /* 字面量 */
    const literal = /^(true|false|null)\b/.exec(source.slice(index));

    if (literal) {
      html += `<span class="tok-literal">${literal[0]}</span>`;
      index += literal[0].length;
      continue;
    }

    if ("{}[],:".includes(char)) {
      html += `<span class="tok-punct">${escapeHtml(char)}</span>`;
      index++;
      continue;
    }

    html += escapeHtml(char);
    index++;
  }

  return html;
}

/**
 * 多行编辑输入框：内容是 JSON（对象 / 数组）时叠一层语法高亮 ——
 * 透明文字的 textarea 浮在渲染好的 `<pre>` 上，滚动同步，逐字对齐。
 * DOM 结构保持不变（高亮层显隐切换），这样边打字边短暂不合法时也不会重挂输入框、丢焦点。
 */
export function JsonTextArea({ value, onChange, textareaRef, className, ariaLabel, spellCheck }: JsonTextAreaProps) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const isJson = useMemo(() => parseJsonObject(value) !== null, [value]);
  const highlighted = useMemo(() => isJson ? highlightJson(value) : "", [isJson, value]);

  const syncScroll = () => {
    const area = textareaRef.current;
    const pre = preRef.current;

    if (area && pre) {
      pre.scrollTop = area.scrollTop;
      pre.scrollLeft = area.scrollLeft;
    }
  };

  return (
    <div className={`json-edit${isJson ? " is-json" : ""}`}>
      <pre
        ref={preRef}
        className="json-edit-highlight"
        aria-hidden="true"
        /* 末尾补换行：文本以换行结尾时 pre 不会少一行，避免和输入框错位 */
        dangerouslySetInnerHTML={{ __html: isJson ? `${highlighted}\n` : "" }}
      />
      <textarea
        ref={textareaRef}
        className={`json-edit-input${className ? ` ${className}` : ""}`}
        value={value}
        spellCheck={spellCheck}
        aria-label={ariaLabel}
        onChange={event => onChange(event.target.value)}
        onScroll={syncScroll}
      />
    </div>
  );
}

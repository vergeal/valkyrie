/*
 * Monaco 精简入口：只带编辑器核心 + SQL 语言。
 *
 * 直接用 `monaco-editor` 会把基本语言（abap/cpp/java/… 80+ 个）和
 * CSS/HTML/JSON/TS language service 全部打进 bundle；这里改为编辑器 API +
 * editor.all（全部编辑器功能，含 suggest / smartSelect 等）+ 仅 SQL 语言。
 */
import "monaco-editor/esm/vs/editor/editor.all.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";

import * as monacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { language as sqlLanguage } from "monaco-editor/esm/vs/basic-languages/sql/sql.js";

export * from "monaco-editor/esm/vs/editor/editor.api";

/*
 * 给 SQL 补上行注释高亮：Monaco 内置只认 `--`，这里再支持 `#` 与 `//`。
 * 直接覆盖 tokenizer 后，注册表优先返回它，懒加载工厂不会再把它盖回去。
 */
type MonarchLanguage = Parameters<typeof monacoApi.languages.setMonarchTokensProvider>[1];

const sqlBase = sqlLanguage as unknown as { tokenizer: Record<string, unknown> };

monacoApi.languages.setMonarchTokensProvider("sql", {
  ...(sqlLanguage as unknown as object),
  tokenizer: {
    ...sqlBase.tokenizer,
    comments: [
      [/--+.*/, "comment"],
      [/\/\/.*/, "comment"],
      [/#.*/, "comment"],
      [/\/\*/, { token: "comment.quote", next: "@comment" }]
    ]
  }
} as MonarchLanguage);

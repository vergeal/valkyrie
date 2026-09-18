/*
 * Monaco 精简入口：只带编辑器核心 + SQL 语言。
 *
 * 直接用 `monaco-editor` 会把基本语言（abap/cpp/java/… 80+ 个）和
 * CSS/HTML/JSON/TS language service 全部打进 bundle；这里改为编辑器 API +
 * editor.all（全部编辑器功能，含 suggest / smartSelect 等）+ 仅 SQL 语言。
 */
import "monaco-editor/esm/vs/editor/editor.all.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";

export * from "monaco-editor/esm/vs/editor/editor.api";

import * as monaco from "./monaco";
import { invoke, type SuggestionItem } from "../api";

export interface SuggestionContext {
  sessionId?: string;
  connection?: string;
  catalog?: string;
  schema?: string;
  type?: string;
}

/** 数据层返回的补全类型 → Monaco 内置弹窗的图标类型 */
export function completionKind(kind: string): monaco.languages.CompletionItemKind {
  switch (kind) {
    case "Function":
      return monaco.languages.CompletionItemKind.Function;
    case "Operator":
      return monaco.languages.CompletionItemKind.Operator;
    case "Class":
      return monaco.languages.CompletionItemKind.Class;
    case "Field":
      return monaco.languages.CompletionItemKind.Field;
    case "Module":
      return monaco.languages.CompletionItemKind.Module;
    case "Snippet":
      return monaco.languages.CompletionItemKind.Snippet;
    default:
      return monaco.languages.CompletionItemKind.Keyword;
  }
}

/**
 * SQL 智能提示：候选项来自 Java 侧上下文引擎，过滤/排序交给 Monaco。
 * 上下文通过 getContext 每次实时读取（避免闭包在旧状态上）。
 */
export function registerCompletionProvider(getContext: () => SuggestionContext): monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [" ", "."],
    provideCompletionItems: async (model, position) => {
      const context = getContext();

      /* 没有会话也还有该方言的关键字提示（连接关闭后的情况） */
      if (!context.sessionId && !context.type)
        return { suggestions: [] };

      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

      try {
        const payload = await invoke<{ suggestions: SuggestionItem[] }>("sql.suggest", {
          sessionId: context.sessionId,
          connection: context.connection,
          type: context.type,
          catalog: context.catalog,
          schema: context.schema,
          sql: model.getValue(),
          offset: model.getOffsetAt(position)
        });

        return {
          suggestions: (payload.suggestions ?? []).map(item => ({
            label: item.label,
            kind: completionKind(item.kind),
            detail: item.detail || undefined,
            insertText: item.insertText ?? item.label,
            /* 片段交给 Monaco 展开 ${1:...} 占位符 */
            insertTextRules: item.kind === "Snippet"
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
            range
          }))
        };
      } catch {
        return { suggestions: [] };
      }
    }
  });
}

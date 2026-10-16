import * as monaco from "./monaco";
import { invoke, type SuggestionItem } from "../api";
import { BUILTIN_SUGGESTIONS, needsTableName } from "./sqlKeywords";

export interface SuggestionContext {
  sessionId?: string;
  connection?: string;
  catalog?: string;
  schema?: string;
  type?: string;
  /** 当前库 / 模式下的表名（控制台工具栏已经加载过），数据层还没答复时先用它顶上 */
  tables?: string[];
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

/** 数据层没在「一眨眼」的时间里答复就先出这些：内置关键字 + 光标位置急需的表名 */
const FALLBACK_MS = 600;

function mergeItems(primary: SuggestionItem[], extra: SuggestionItem[]): SuggestionItem[] {
  const merged = new Map<string, SuggestionItem>();

  /* 先放兜底的，后面的（数据层结果）覆盖同名的，保留更详细的 detail / 类型 */
  for (const item of extra)
    merged.set(item.label.toUpperCase(), item);

  for (const item of primary)
    merged.set(item.label.toUpperCase(), item);

  return [...merged.values()];
}

/**
 * SQL 智能提示：候选项来自 Java 侧上下文引擎，过滤/排序交给 Monaco。
 * <p>
 * 弹窗不等数据层：先把内置关键字（光标在 FROM / JOIN 后面时再加上已知表名）摆上，
 * 数据层结果回来后覆盖同名项；同一上下文的请求会复用，结果按上下文缓存，
 * 因此敲键时基本都是「立刻出，随后补全」。
 */
export function registerCompletionProvider(getContext: () => SuggestionContext): monaco.IDisposable {
  /* 上下文 → 上次拿到的完整候选；上下文 → 在途请求（避免连续敲键重复发请求） */
  const cached = new Map<string, SuggestionItem[]>();
  const inflight = new Map<string, Promise<SuggestionItem[]>>();

  const toSuggestions = (items: SuggestionItem[], range: monaco.Range) => items.map(item => ({
    label: item.label,
    kind: completionKind(item.kind),
    detail: item.detail || undefined,
    insertText: item.insertText ?? item.label,
    /* 片段交给 Monaco 展开 ${1:...} 占位符 */
    insertTextRules: item.kind === "Snippet"
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    range
  }));

  /** 数据层请求：同一上下文复用同一个在途 Promise，成功后就地缓存 */
  const request = (key: string, params: Record<string, unknown>) => {
    const pending = inflight.get(key);

    if (pending)
      return pending;

    const promise = invoke<{ suggestions: SuggestionItem[] }>("sql.suggest", params)
      .then(payload => {
        const items = payload.suggestions ?? [];

        cached.set(key, items);
        return items;
      })
      .catch(() => cached.get(key) ?? [])
      .finally(() => inflight.delete(key));

    inflight.set(key, promise);
    return promise;
  };

  /** 立刻能给的候选：内置关键字（+ 该写表名时的已知表名） */
  const instantItems = (context: SuggestionContext, textBeforeCursor: string): SuggestionItem[] => {
    const tables = needsTableName(textBeforeCursor)
      ? (context.tables ?? []).map(label => ({ label, kind: "Class", insertText: label }))
      : [];

    return mergeItems(tables, BUILTIN_SUGGESTIONS);
  };

  return monaco.languages.registerCompletionItemProvider("sql", {
    /* 只在「.」后主动弹出（表别名.字段）；正常单词输入由 quickSuggestions 触发，空格不再触发 */
    triggerCharacters: ["."],
    provideCompletionItems: async (model, position) => {
      const context = getContext();
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const key = [context.sessionId ?? "", context.connection ?? "", context.catalog ?? "", context.schema ?? ""].join("|");
      const modelValue = model.getValue();
      const offset = model.getOffsetAt(position);
      const textBeforeCursor = modelValue.slice(0, offset);
      const instant = instantItems(context, textBeforeCursor);
      const known = cached.get(key);

      /* 连接已关闭、又没有方言信息：至少给内置关键字，不再返回空 */
      if (!context.sessionId && !context.connection && !context.type)
        return { suggestions: toSuggestions(known ?? instant, range) };

      const pending = request(key, {
        sessionId: context.sessionId,
        connection: context.connection,
        type: context.type,
        catalog: context.catalog,
        schema: context.schema,
        sql: modelValue,
        offset
      });

      /* 数据层很快（本机进程）就等它；偶尔慢（首次读远端元数据）就先出兜底候选 */
      const settled = await Promise.race([
        pending,
        new Promise<null>(resolve => window.setTimeout(() => resolve(null), FALLBACK_MS))
      ]);

      if (settled)
        return { suggestions: toSuggestions(mergeItems(settled, instant), range) };

      return { suggestions: toSuggestions(mergeItems(known ?? [], instant), range) };
    }
  });
}

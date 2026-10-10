import * as monaco from "./monaco";
import { collectTableRefs } from "./sqlTableRefs";

export interface TableHighlightOptions {
  /** 当前表名集合（小写） */
  getNames: () => Set<string>;
}

/**
 * 文档里的表名基础高亮：用装饰上一个颜色类（`editor-table-ref`），
 * 让表名始终有语法高亮色；按住 Cmd/Ctrl 时的「可点击」表现（蓝色 + 手型）由
 * LinkProvider 的 `.detected-link*` 样式负责。
 */
export function registerTableHighlight(
  editor: monaco.editor.IStandaloneCodeEditor,
  options: TableHighlightOptions
): monaco.IDisposable {
  const decorations = editor.createDecorationsCollection([]);
  let timer = 0;

  const refresh = () => {
    const model = editor.getModel();

    if (!model)
      return;

    const names = options.getNames();

    if (!names || names.size === 0) {
      decorations.clear();
      return;
    }

    const refs = collectTableRefs(model.getValue(), names);
    const ranges: monaco.editor.IModelDeltaDecoration[] = refs.map(ref => {
      const start = model.getPositionAt(ref.start);
      const end = model.getPositionAt(ref.end);

      return {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: { inlineClassName: "editor-table-ref" }
      };
    });

    decorations.set(ranges);
  };

  /* 逐键重扫整篇太重：停顿后再刷新 */
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(refresh, 150);
  };

  const contentSub = editor.onDidChangeModelContent(schedule);
  const modelSub = editor.onDidChangeModel(schedule);

  refresh();

  return {
    dispose() {
      window.clearTimeout(timer);
      contentSub.dispose();
      modelSub.dispose();
      decorations.clear();
    }
  };
}

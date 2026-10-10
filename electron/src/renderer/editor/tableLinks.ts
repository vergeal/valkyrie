import * as monaco from "./monaco";
import { collectTableRefs } from "./sqlTableRefs";

const SCHEME = "valkyrie-table";

export interface TableLinkOptions {
  /** 当前可打开的表名集合（小写） */
  getNames: () => Set<string>;
  /** Cmd/Ctrl + 点击表名时回调（传原始大小写的名字） */
  onOpen: (name: string) => void;
}

/**
 * 表名的「可点击」表现：按住 Cmd/Ctrl 时，Monaco 会把这些表名标成链接
 * （`.detected-link` / `.detected-link-active`）；配色与手型光标由 CSS 控制，
 * 点击时通过自定义 link opener 打开对应表。
 */
export function registerTableLinks(options: TableLinkOptions): monaco.IDisposable {
  const provider = monaco.languages.registerLinkProvider("sql", {
    provideLinks(model) {
      const names = options.getNames();

      if (!names || names.size === 0)
        return { links: [] };

      const links: monaco.languages.ILink[] = collectTableRefs(model.getValue(), names).map(ref => {
        const start = model.getPositionAt(ref.start);
        const end = model.getPositionAt(ref.end);

        return {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          url: monaco.Uri.parse(`${SCHEME}://open/${encodeURIComponent(ref.word)}`),
          tooltip: `打开表 ${ref.word}`
        };
      });

      return { links };
    }
  });

  const opener = monaco.editor.registerLinkOpener({
    open(resource) {
      if (resource.scheme !== SCHEME)
        return false;

      options.onOpen(decodeURIComponent(resource.path.replace(/^\//, "")));
      return true;
    }
  });

  return {
    dispose() {
      provider.dispose();
      opener.dispose();
    }
  };
}

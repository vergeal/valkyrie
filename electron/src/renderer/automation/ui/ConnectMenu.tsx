import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeDefinition } from "../sdk";
import { Icon } from "../../ui/icons";

export interface ConnectMenuState {
  screenX: number;
  screenY: number;
  flowX: number;
  flowY: number;
}

export function ConnectMenu(props: {
  nodes: NodeDefinition[];
  state: ConnectMenuState;
  onPick: (type: string) => void;
  onClose: () => void;
}) {
  const { nodes, state, onPick, onClose } = props;
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();

    if (!keyword)
      return nodes;

    return nodes.filter(definition =>
      definition.manifest.title.toLowerCase().includes(keyword)
      || definition.manifest.type.toLowerCase().includes(keyword)
      || definition.manifest.category.toLowerCase().includes(keyword));
  }, [nodes, query]);

  const width = 268;
  const height = 320;
  const left = Math.max(8, Math.min(state.screenX, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(state.screenY, window.innerHeight - height - 8));

  return (
    <>
      <div className="am-connect-backdrop" onMouseDown={onClose} onContextMenu={event => event.preventDefault()} />
      <div className="am-connect-menu" style={{ left, top, width }}>
        <div className="am-connect-search">
          <Icon name="search" size={13} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索节点…"
            aria-label="搜索可连接的节点"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "Enter" && filtered.length > 0) {
                event.preventDefault();
                onPick(filtered[0].manifest.type);
              }
            }}
          />
        </div>

        <div className="am-connect-list">
          {filtered.length === 0 && <div className="am-empty">没有可连接的节点</div>}
          {filtered.map(definition => (
            <button
              key={definition.manifest.type}
              type="button"
              className="am-connect-item"
              onClick={() => onPick(definition.manifest.type)}
            >
              <span className="am-palette-dot" style={{ background: definition.manifest.color ?? "#6b7280" }} />
              {definition.manifest.icon && <Icon name={definition.manifest.icon} size={13} />}
              <span className="am-connect-label">{definition.manifest.title}</span>
              <span className="am-connect-category">{definition.manifest.category}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

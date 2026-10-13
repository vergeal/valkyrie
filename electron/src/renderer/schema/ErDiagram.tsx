import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps
} from "reactflow";
import "reactflow/dist/style.css";
import { messageOf, schemaRelations, type ErTable } from "../api";
import type { ErTab, SessionState } from "../app/appTypes";
import { Icon } from "../ui/icons";

/** 卡片尺寸：布局按这个估高，和 CSS 里的行高保持一致 */
const CARD_WIDTH = 236;
const CARD_HEADER = 34;
const COLUMN_HEIGHT = 20;
const GAP_X = 120;
const GAP_Y = 40;
/** 卡片最多列几列，剩下的折成一行提示 */
const MAX_COLUMNS = 12;
/** 表特别多时少画几列，控制 DOM 体量（详情面板里能看全） */
function columnBudget(tableCount: number): number {
  if (tableCount > 200)
    return 5;

  if (tableCount > 80)
    return 8;

  return MAX_COLUMNS;
}
/** 列数的上下限：太少会排成一条竖线，太多会排成一条横线 */
const MIN_COLUMNS = 3;
const MAX_LAYOUT_COLUMNS = 24;

interface ErColumnView {
  name: string;
  type?: string;
  primary: boolean;
  foreign: boolean;
  comment?: string;
}

interface ErNodeData {
  name: string;
  schema?: string | null;
  columns: ErColumnView[];
  more: number;
  /** 搜索没命中：淡显但保留布局 */
  dim: boolean;
}

function cardHeight(count: number): number {
  return CARD_HEADER + count * COLUMN_HEIGHT + 8;
}

function cardRows(count: number, budget: number): { rows: number; more: number } {
  const rows = Math.min(count, budget);

  return { rows, more: Math.max(0, count - rows) };
}

function ErTableCard({ data }: NodeProps<ErNodeData>) {
  return (
    <div className={`er-card${data.dim ? " is-dim" : ""}`}>
      <Handle type="target" position={Position.Left} className="er-handle" />
      <div className="er-card-head">
        <Icon name="table" size={12} />
        <span className="er-card-name" title={data.schema ? `${data.schema}.${data.name}` : data.name}>{data.name}</span>
        {data.schema && <span className="er-card-schema">{data.schema}</span>}
      </div>
      <div className="er-card-body">
        {data.columns.map(column => (
          <div className={`er-card-col${column.primary ? " is-pk" : ""}`} key={column.name}>
            <span className="er-col-key">{column.primary ? "PK" : column.foreign ? "FK" : ""}</span>
            <span className="er-col-name" title={column.comment ? `${column.name}（${column.comment}）` : column.name}>
              {column.name}
            </span>
            <span className="er-col-type">{column.type ?? ""}</span>
          </div>
        ))}
        {data.more > 0 && <div className="er-card-more">… 还有 {data.more} 列</div>}
      </div>
      <Handle type="source" position={Position.Right} className="er-handle" />
    </div>
  );
}

const NODE_TYPES = { erTable: ErTableCard };

/** 外键关系图（无向）：用来把有关系的表排在一起 */
function neighbourMap(tables: ErTable[]): Map<string, Set<string>> {
  const names = new Set(tables.map(table => table.name));
  const neighbours = new Map<string, Set<string>>(tables.map(table => [table.name, new Set<string>()]));

  for (const table of tables) {
    for (const key of table.foreignKeys) {
      if (!names.has(key.refTable))
        continue;

      neighbours.get(table.name)?.add(key.refTable);
      neighbours.get(key.refTable)?.add(table.name);
    }
  }

  return neighbours;
}

/**
 * 排版：先按外键把有关系的表串成一组（组内按名字），再依次往下铺；
 * 一列超过 {@link MAX_COLUMN_HEIGHT} 就另起一列 —— 几百张表会排成多列网格，
 * 而不是一条几百屏高的竖线。
 */
function packLayout(tables: ErTable[], budget = MAX_COLUMNS): Map<string, { x: number; y: number }> {
  const byName = new Map(tables.map(table => [table.name, table]));
  const neighbours = neighbourMap(tables);
  const seen = new Set<string>();
  const ordered: ErTable[] = [];

  for (const table of [...tables].sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen.has(table.name))
      continue;

    const queue: ErTable[] = [table];

    seen.add(table.name);

    while (queue.length > 0) {
      const current = queue.shift() as ErTable;

      ordered.push(current);

      for (const next of [...(neighbours.get(current.name) ?? [])].sort()) {
        const node = byName.get(next);

        if (!node || seen.has(next))
          continue;

        seen.add(next);
        queue.push(node);
      }
    }
  }

  /*
   * 先算出「排几列看着舒服」：按卡片总高反推，让整张图大致 2:1，
   * 避免几百张表排成一条竖线或者一条横线。
   */
  const heightOf = (table: ErTable) => cardHeight(Math.min(table.columns.length, budget) + (table.columns.length > budget ? 1 : 0));
  const totalHeight = ordered.reduce((sum, table) => sum + heightOf(table) + GAP_Y, 0);
  const columns = Math.min(MAX_LAYOUT_COLUMNS, Math.max(MIN_COLUMNS, Math.round(Math.sqrt(tables.length * 1.8))));
  const columnHeight = Math.max(600, totalHeight / columns);

  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  let y = 0;

  for (const table of ordered) {
    const height = heightOf(table);

    if (y > 0 && y + height > columnHeight) {
      x += CARD_WIDTH + GAP_X;
      y = 0;
    }

    positions.set(table.name, { x, y });
    y += height + GAP_Y;
  }

  return positions;
}

export interface ErDiagramProps {
  tab: ErTab;
  session: SessionState | null;
  onStatus: (message: string) => void;
  onError: (message: string | null) => void;
}

/**
 * 已加载过的容器 → 图数据。
 * 切标签会让页面卸载，几百张表重新读一遍要几秒；这里缓存一份，切回来直接出图，
 * 想拿最新结构点「刷新」即可。
 */
const loaded = new Map<string, { tables: ErTable[]; truncated: boolean }>();

export function ErDiagram(props: ErDiagramProps) {
  return (
    <ReactFlowProvider>
      <ErCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ErCanvas({ tab, session, onStatus, onError }: ErDiagramProps) {
  const flow = useReactFlow();
  const cached = loaded.get(tab.node.id);
  const [tables, setTables] = useState<ErTable[]>(cached?.tables ?? []);
  const [truncated, setTruncated] = useState(Boolean(cached?.truncated));
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [relatedOnly, setRelatedOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Node<ErNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  /* 手动拖动过就不再被自动排版覆盖，直到点「重新布局」 */
  const layoutRef = useRef(true);

  const load = useCallback(async () => {
    if (!session) {
      onError("请先连接数据库，再打开 ER 图");
      return;
    }

    setLoading(true);

    try {
      const payload = await schemaRelations(session.sessionId, tab.node.id);
      const next = payload.tables ?? [];

      layoutRef.current = true;
      loaded.set(tab.node.id, { tables: next, truncated: Boolean(payload.truncated) });
      setTables(next);
      setTruncated(Boolean(payload.truncated));
      onStatus(`ER 图已加载：${next.length} 张表`);
    } catch (error) {
      onError(`${messageOf(error)}（对象树刷新过请重新打开 ER 图）`);
    } finally {
      setLoading(false);
    }
  }, [session, tab.node.id, onStatus, onError]);

  useEffect(() => {
    /* 已经有缓存就不再自动重读，避免切标签来回等几秒 */
    if (!loaded.has(tab.node.id))
      void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const needle = keyword.trim().toLowerCase();

  /* 可见表 + 关系（搜索只淡显，不影响布局；「只看有关系的表」才真的过滤） */
  const visible = useMemo(() => {
    const names = new Set(tables.map(table => table.name));
    const related = new Set<string>();

    for (const table of tables)
      for (const key of table.foreignKeys)
        if (names.has(key.refTable)) {
          related.add(table.name);
          related.add(key.refTable);
        }

    return {
      tables: relatedOnly ? tables.filter(table => related.has(table.name)) : tables,
      related
    };
  }, [tables, relatedOnly]);

  const relations = useMemo(() => {
    const names = new Set(visible.tables.map(table => table.name));
    const list: { id: string; source: string; target: string; name: string; columns: string[] }[] = [];

    for (const table of visible.tables)
      for (const key of table.foreignKeys)
        if (names.has(key.refTable))
          list.push({
            id: `${table.name}.${key.name}->${key.refTable}`,
            source: table.name,
            target: key.refTable,
            name: key.name,
            columns: key.columns
          });

    return list;
  }, [visible]);

  /* 表集合或过滤条件变化 → 重排一次（手动拖动后保持用户摆的位置） */
  useEffect(() => {
    const budget = columnBudget(visible.tables.length);
    const positions = packLayout(visible.tables, budget);
    const foreignOf = new Map(visible.tables.map(table => [
      table.name,
      new Set(table.foreignKeys.flatMap(key => key.columns))
    ]));

    setNodes(previous => {
      const previousPositions = new Map(previous.map(node => [node.id, node.position]));

      return visible.tables.map(table => {
        const primary = new Set(table.primaryKeys);
        const foreign = foreignOf.get(table.name) ?? new Set<string>();
        const columns = table.columns.map(column => ({
          name: column.name,
          type: column.type,
          primary: primary.has(column.name),
          foreign: foreign.has(column.name),
          comment: column.comment
        }));
        const shape = cardRows(columns.length, budget);
        const position = layoutRef.current
          ? positions.get(table.name) ?? { x: 0, y: 0 }
          : previousPositions.get(table.name) ?? positions.get(table.name) ?? { x: 0, y: 0 };

        return {
          id: table.name,
          type: "erTable",
          position,
          data: {
            name: table.name,
            schema: table.schema,
            columns: columns.slice(0, shape.rows),
            more: shape.more,
            dim: Boolean(needle) && !table.name.toLowerCase().includes(needle)
          },
          style: { width: CARD_WIDTH },
          selected: table.name === selected
        };
      });
    });

    setEdges(relations.map(relation => ({
      id: relation.id,
      source: relation.source,
      target: relation.target,
      type: "smoothstep",
      style: { strokeWidth: 1.6 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 }
    })));
  }, [visible, relations, needle, selected]);

  /* 布局重排后取景一次 */
  useEffect(() => {
    if (nodes.length === 0 || !layoutRef.current)
      return;

    const timer = window.setTimeout(() => void flow.fitView({ padding: 0.18 }), 60);

    return () => window.clearTimeout(timer);
  }, [nodes.length, flow, tables, relatedOnly]);

  const selectedTable = tables.find(table => table.name === selected) ?? null;

  /** 选中表在图上被引用 / 引用的关系 */
  const selectedRelations = useMemo(() => {
    if (!selectedTable)
      return { out: [] as { label: string; refTable: string; columns: string }[], incoming: [] as string[] };

    const out = selectedTable.foreignKeys.map(key => ({
      label: key.name || "外键",
      refTable: key.refTable,
      columns: `${key.columns.join(", ")} → ${key.refColumns.join(", ")}`
    }));
    const incoming = tables
      .filter(table => table.foreignKeys.some(key => key.refTable === selectedTable.name))
      .map(table => table.name);

    return { out, incoming };
  }, [selectedTable, tables]);

  return (
    <div className="er-wrap">
      <div className="er-toolbar">
        <span className="er-title">
          <Icon name="er" size={13} />
          {tab.node.label}
        </span>
        <span className="toolbar-text">
          共 {tables.length} 张表 · 检测到 {relations.length} 条外键关系
          {truncated ? `（表太多，只画了前 ${tables.length} 张）` : ""}
        </span>
        <span className="tbtn-push" aria-hidden="true" />
        <label className="er-toggle">
          <input type="checkbox" checked={relatedOnly} onChange={event => setRelatedOnly(event.target.checked)} />
          只看有关系的表
        </label>
        <span className="toolbar-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={keyword}
            placeholder="搜索表名…"
            aria-label="搜索表名"
            onChange={event => setKeyword(event.target.value)}
          />
        </span>
        <button
          type="button"
          className="tbtn"
          title="把手动拖过的卡片重新排好"
          onClick={() => {
            layoutRef.current = true;
            setNodes(previous => {
              const positions = packLayout(visible.tables, columnBudget(visible.tables.length));

              return previous.map(node => ({ ...node, position: positions.get(node.id) ?? node.position }));
            });
            window.setTimeout(() => void flow.fitView({ padding: 0.18 }), 60);
          }}
        >
          <Icon name="alignLeft" size={14} />重新布局
        </button>
        <button type="button" className="tbtn" onClick={() => void flow.fitView({ padding: 0.18 })}>
          <Icon name="locate" />适应视图
        </button>
        <button type="button" className="tbtn" disabled={loading} onClick={() => void load()}>
          <Icon name="refresh" />{loading ? "加载中…" : "刷新"}
        </button>
      </div>

      <div className="er-main">
        <div className="er-canvas">
          {loading && <div className="er-hint">正在读取表结构…（大库可能要几秒）</div>}

          {tables.length === 0 && !loading && <div className="er-empty">这个库 / 模式下还没有表</div>}

          {tables.length > 0 && relations.length === 0 && !loading && (
            <div className="er-hint">没有检测到外键关系，只显示了表结构</div>
          )}

          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            fitView
            minZoom={0.1}
            maxZoom={2}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodesChange={(changes: NodeChange[]) => {
              /* 允许拖动卡片：拖过就转到手动布局，不再被自动排版覆盖 */
              if (changes.some(change => change.type === "position" && change.dragging))
                layoutRef.current = false;

              setNodes(previous => applyNodeChanges(changes, previous));
            }}
            onNodeClick={(_event, node) => setSelected(node.id)}
            onPaneClick={() => setSelected(null)}
            onNodeDoubleClick={(_event, node) => setSelected(node.id)}
          >
            <Background gap={18} size={1.2} />
            <MiniMap pannable zoomable />
            <Controls />
          </ReactFlow>
        </div>

        {selectedTable && (
          <aside className="er-side">
            <div className="er-side-head">
              <span className="er-side-title">{selectedTable.name}</span>
              <button type="button" className="er-side-close" aria-label="关闭详情" onClick={() => setSelected(null)}>
                <Icon name="close" size={12} />
              </button>
            </div>
            {selectedTable.schema && <div className="er-side-sub">{selectedTable.schema}</div>}

            <div className="er-side-section">字段 {selectedTable.columns.length}</div>
            <div className="er-side-list">
              {selectedTable.columns.map(column => (
                <div className="er-side-row" key={column.name}>
                  <span className="er-side-key">
                    {selectedTable.primaryKeys.includes(column.name)
                      ? "PK"
                      : selectedTable.foreignKeys.some(key => key.columns.includes(column.name)) ? "FK" : ""}
                  </span>
                  <span className="er-side-name" title={column.comment ?? column.name}>{column.name}</span>
                  <span className="er-side-type">{column.type ?? ""}</span>
                </div>
              ))}
            </div>

            <div className="er-side-section">外键（指向）{selectedRelations.out.length}</div>
            <div className="er-side-list">
              {selectedRelations.out.length === 0 && <div className="er-side-empty">无</div>}
              {selectedRelations.out.map(item => (
                <div className="er-side-row" key={`${item.label}-${item.refTable}`}>
                  <button type="button" className="er-side-link" onClick={() => setSelected(item.refTable)}>
                    {item.refTable}
                  </button>
                  <span className="er-side-type">{item.columns}</span>
                </div>
              ))}
            </div>

            <div className="er-side-section">被引用 {selectedRelations.incoming.length}</div>
            <div className="er-side-list">
              {selectedRelations.incoming.length === 0 && <div className="er-side-empty">无</div>}
              {selectedRelations.incoming.map(name => (
                <div className="er-side-row" key={name}>
                  <button type="button" className="er-side-link" onClick={() => setSelected(name)}>{name}</button>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

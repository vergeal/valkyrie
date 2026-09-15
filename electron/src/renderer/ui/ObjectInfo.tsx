import type { ProductMeta, SchemaNode, TableColumn, TableIndex } from "../api";
import { formatByteSize } from "../app/format";
import { Icon } from "./icons";

interface ObjectInfoProps {
  node: SchemaNode | null;
  connectionName: string | null;
  product: ProductMeta | null;
  columns: TableColumn[];
  indexes: TableIndex[];
  onOpenData: (node: SchemaNode) => void;
  onDesign: (node: SchemaNode) => void;
}

function formatTime(value?: number): string {
  if (!value)
    return "-";

  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ObjectInfo(props: ObjectInfoProps) {
  const { node, connectionName, product, columns, indexes, onOpenData, onDesign } = props;

  if (!node)
    return <div className="props"><div className="empty">选中对象后展示详细信息</div></div>;

  const isTable = node.kind === "TABLE" && Boolean(node.table);
  const primary = columns.filter(column => column.primary).map(column => column.name);

  return (
    <div className="props">
      <div className="prop-group">
        <div className="prop-group-title"><Icon name={isTable ? "table" : "database"} />{node.label}</div>
        <div className="prop-row"><span className="prop-key">类型</span><span className="prop-val">{isTable ? "数据表" : node.kind}</span></div>
        {node.catalog && <div className="prop-row"><span className="prop-key">数据库</span><span className="prop-val mono">{node.catalog}</span></div>}
        {node.schema && <div className="prop-row"><span className="prop-key">模式</span><span className="prop-val mono">{node.schema}</span></div>}
        {node.table?.engine && <div className="prop-row"><span className="prop-key">引擎</span><span className="prop-val">{node.table.engine}</span></div>}
        {node.table?.rows != null && <div className="prop-row"><span className="prop-key">行数</span><span className="prop-val">{node.table.rows.toLocaleString()}</span></div>}
        {node.table?.size != null && <div className="prop-row"><span className="prop-key">数据大小</span><span className="prop-val">{formatByteSize(node.table.size)}</span></div>}
        {isTable && <div className="prop-row"><span className="prop-key">创建时间</span><span className="prop-val">{formatTime(node.table?.createTime)}</span></div>}
        {isTable && <div className="prop-row"><span className="prop-key">更新时间</span><span className="prop-val">{formatTime(node.table?.updateTime)}</span></div>}
        {node.table?.comment && <div className="prop-row"><span className="prop-key">注释</span><span className="prop-val">{node.table.comment}</span></div>}
      </div>

      {isTable && (
        <div className="prop-group">
          <div className="prop-group-title"><Icon name="columns" />结构</div>
          <div className="prop-row"><span className="prop-key">字段</span><span className="prop-val">{columns.length || "-"}</span></div>
          <div className="prop-row"><span className="prop-key">主键</span><span className="prop-val mono">{primary.join(", ") || "-"}</span></div>
          <div className="prop-row"><span className="prop-key">索引</span><span className="prop-val">{indexes.length || "-"}</span></div>
          <div className="prop-row"><span className="prop-key">可空列</span><span className="prop-val">{columns.filter(column => !column.notNull).length || "-"}</span></div>
        </div>
      )}

      {isTable && indexes.length > 0 && (
        <div className="prop-group">
          <div className="prop-group-title"><Icon name="list" />索引</div>
          {indexes.map(index => (
            <div className="prop-row" key={index.name}>
              <span className="prop-key mono">{index.name}</span>
              <span className="prop-val mono">{index.columnsText || "-"}</span>
            </div>
          ))}
        </div>
      )}

      {isTable && (
        <div className="prop-group">
          <div className="prop-group-title"><Icon name="terminal" />操作</div>
          <div className="prop-actions">
            <button type="button" className="mini-btn" onClick={() => onOpenData(node)}>打开数据</button>
            <button type="button" className="mini-btn" onClick={() => onDesign(node)}>设计表</button>
          </div>
        </div>
      )}

      <div className="prop-group">
        <div className="prop-group-title"><Icon name="info" />连接</div>
        <div className="prop-row"><span className="prop-key">连接名</span><span className="prop-val">{connectionName ?? "-"}</span></div>
        <div className="prop-row"><span className="prop-key">产品</span><span className="prop-val">{product?.productName ?? "-"}</span></div>
        <div className="prop-row"><span className="prop-key">版本</span><span className="prop-val">{product?.version ?? "-"}</span></div>
      </div>
    </div>
  );
}

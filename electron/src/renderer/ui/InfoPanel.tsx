import type { ProductMeta, SchemaNode, TableColumn, TableIndex } from "../api";
import { ObjectInfo } from "./ObjectInfo";

/** 右侧「对象信息」面板：选中对象的结构 / 索引，来源于 schema 域。 */
export function InfoPanel(props: {
  node: SchemaNode | null;
  connectionName: string | null;
  product: ProductMeta | null;
  columns: TableColumn[];
  indexes: TableIndex[];
  onOpenData: (node: SchemaNode) => void;
  onDesign: (node: SchemaNode) => void;
}) {
  const { node, connectionName, product, columns, indexes, onOpenData, onDesign } = props;

  return (
    <aside className="info">
      <div className="side-head">
        <span className="side-title">对象信息</span>
      </div>
      <ObjectInfo
        node={node}
        connectionName={connectionName}
        product={product}
        columns={columns}
        indexes={indexes}
        onOpenData={onOpenData}
        onDesign={onDesign}
      />
    </aside>
  );
}

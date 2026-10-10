import type { QueryResultPayload } from "../api";
import { ResultGrid } from "./ResultGrid";

/** 执行计划面板：只展示原始计划表格；分析结论放到右侧「执行计划分析」面板。 */
export function PlanPane(props: { plan: QueryResultPayload | null }) {
  const { plan } = props;
  const columns = plan?.columns ?? [];
  const rows = plan?.rows ?? [];

  return (
    <div className="grid-host">
      <ResultGrid columns={columns} rows={rows} />
    </div>
  );
}

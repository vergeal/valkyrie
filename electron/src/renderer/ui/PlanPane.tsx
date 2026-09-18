import { useMemo } from "react";
import type { QueryResultPayload } from "../api";
import { analyzePlan, type PlanLevel } from "../query/planAnalysis";
import { ResultGrid } from "./ResultGrid";
import { Icon } from "./icons";

const LEVEL_ICON: Record<PlanLevel, string> = {
  info: "info",
  warn: "alert",
  risk: "fail"
};

/**
 * 执行计划面板：原始计划表格与计划分析同处一个面板，分析作为表格下方的附加区域。
 * 分析与建议按数据库类型启发式生成，不改变计划本身。
 */
export function PlanPane(props: {
  plan: QueryResultPayload | null;
  sql?: string;
  dbType?: string;
  onCopy: (text: string) => void;
}) {
  const { plan, sql, dbType, onCopy } = props;
  const analysis = useMemo(() => analyzePlan(plan, sql ?? "", dbType), [plan, sql, dbType]);
  const columns = plan?.columns ?? [];
  const rows = plan?.rows ?? [];

  return (
    <div className="grid-host">
      <ResultGrid columns={columns} rows={rows} />

      <div className="plan-analysis">
        <div className="plan-section-title">执行计划分析</div>
        <div className="plan-summary">
          <Icon name="zap" size={13} />
          <span>{analysis.summary}</span>
        </div>

        {analysis.findings.length > 0 && (
          <ul className="plan-findings">
            {analysis.findings.map((finding, index) => (
              <li key={`${finding.title}-${index}`} className={`plan-finding is-${finding.level}`}>
                <Icon name={LEVEL_ICON[finding.level]} size={13} />
                <div className="plan-finding-text">
                  <span className="plan-finding-title">{finding.title}</span>
                  {finding.detail && <span className="plan-finding-detail">{finding.detail}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}

        {analysis.suggestions.length > 0 && (
          <div className="plan-suggestions">
            <div className="plan-section-title">SQL 建议</div>
            {analysis.suggestions.map((suggestion, index) => (
              <div key={`${suggestion.title}-${index}`} className="plan-suggestion">
                <div className="plan-suggestion-head">
                  <span className="plan-suggestion-title">{suggestion.title}</span>
                  {suggestion.sql && (
                    <button
                      type="button"
                      className="mini-btn"
                      title="复制建议 SQL"
                      onClick={() => suggestion.sql && onCopy(suggestion.sql)}
                    >
                      <Icon name="copy" size={12} />复制 SQL
                    </button>
                  )}
                </div>
                {suggestion.detail && <div className="plan-suggestion-detail">{suggestion.detail}</div>}
                {suggestion.sql && <code className="plan-suggestion-sql">{suggestion.sql}</code>}
              </div>
            ))}
          </div>
        )}

        {analysis.findings.length === 0 && analysis.suggestions.length === 0 && (
          <div className="empty">未识别到可分析的计划步骤</div>
        )}
      </div>
    </div>
  );
}
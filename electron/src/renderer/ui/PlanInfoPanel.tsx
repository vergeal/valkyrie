import { useMemo } from "react";
import type { QueryResultPayload } from "../api";
import { analyzePlan, type PlanLevel } from "../query/planAnalysis";
import { Icon } from "./icons";

const LEVEL_ICON: Record<PlanLevel, string> = {
  info: "info",
  warn: "alert",
  risk: "fail"
};

/** 右侧「执行计划分析」面板：仅在执行计划 tab 显示，替代对象信息。 */
export function PlanInfoPanel(props: {
  plan: QueryResultPayload | null;
  sql?: string;
  dbType?: string;
  onCopy: (text: string) => void;
}) {
  const { plan, sql, dbType, onCopy } = props;
  const analysis = useMemo(() => analyzePlan(plan, sql ?? "", dbType), [plan, sql, dbType]);
  const empty = analysis.findings.length === 0 && analysis.suggestions.length === 0;

  return (
    <aside className="info">
      <div className="side-head">
        <span className="side-title">执行计划分析</span>
      </div>

      <div className="plan-info">
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

        {empty && <div className="empty">未识别到可分析的计划步骤</div>}
      </div>
    </aside>
  );
}

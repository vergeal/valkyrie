import type { SchemaNode } from "../api";
import type { SessionState, WorkTab } from "../app/appTypes";
import { connectionOfTab } from "../tabs/tabHelpers";
import { connectionOfNode } from "../schema/schemaHelpers";

/** 连接名 → 会话：多连接并存时按名字取，取不到退回当前活动会话 */
export function sessionByName(
  name: string | undefined,
  openSessions: Record<string, SessionState>,
  activeSession: SessionState | null
): SessionState | null {
  if (name && openSessions[name])
    return openSessions[name];

  return activeSession;
}

/** 节点（或标签）对应的会话 */
export function sessionOfNode(
  node: SchemaNode | null | undefined,
  tab: WorkTab | null | undefined,
  treeRoot: SchemaNode,
  treeChildren: Record<string, SchemaNode[]>,
  openSessions: Record<string, SessionState>,
  activeSession: SessionState | null
): SessionState | null {
  return sessionByName(connectionOfNode(node, treeRoot, treeChildren) ?? connectionOfTab(tab), openSessions, activeSession);
}

/** 标签对应的会话（控制台执行、取消、执行计划都按标签所属连接取） */
export function sessionOfTab(
  tab: WorkTab | null | undefined,
  openSessions: Record<string, SessionState>,
  activeSession: SessionState | null
): SessionState | null {
  return sessionByName(connectionOfTab(tab), openSessions, activeSession);
}

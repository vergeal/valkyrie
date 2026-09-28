import type { LogLevel } from "../sdk";

export type RunStatus = "running" | "success" | "failed" | "cancelled";
export type RunNodeStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface RunNodeState {
  nodeId: string;
  type: string;
  title: string;
  status: RunNodeStatus;
  startedAt?: number;
  finishedAt?: number;
  outputs?: Record<string, unknown>;
  error?: string;
}

export interface RunLog {
  id: number;
  time: number;
  level: LogLevel;
  nodeId?: string;
  message: string;
}

export interface RunRecord {
  id: string;
  workflowName: string;
  trigger: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  nodes: Record<string, RunNodeState>;
  logs: RunLog[];
  error?: string;
}

export function createRunRecord(id: string, workflowName: string, trigger: string): RunRecord {
  return {
    id,
    workflowName,
    trigger,
    startedAt: Date.now(),
    status: "running",
    nodes: {},
    logs: []
  };
}

import type {
  ExecInputs,
  ExecResult,
  Executor,
  FlowHooks,
  NodeContext,
  NodeDefinition,
  NodeServices,
  VariableStore,
  WorkflowGraph,
  WorkflowGraphNode
} from "../sdk";
import { NodeRegistry } from "./registry";
import { edgeTargets, findTrigger, indexGraph, type GraphIndex } from "./graph";
import { readErrorPolicy } from "./commonConfig";
import { createRunRecord, type RunRecord, type RunStatus } from "./run";

class MemoryVariables implements VariableStore {
  private values = new Map<string, unknown>();

  get(name: string): unknown {
    return this.values.get(name);
  }

  set(name: string, value: unknown): void {
    this.values.set(name, value);
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }
}

export interface RunOptions {
  workflowName: string;
  trigger?: string;
  params?: Record<string, unknown>;
  signal: AbortSignal;
  onUpdate?: (run: RunRecord) => void;
}

interface ErrorHandler {
  token: number;
  nodeId: string;
  handle: string;
}

let runSequence = 0;

function nextRunId(): string {
  runSequence += 1;
  return `run-${Date.now().toString(36)}-${runSequence}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function configDefaults(definition: NodeDefinition): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  for (const field of definition.manifest.config) {
    if (field.default !== undefined)
      config[field.key] = field.default;
  }

  return config;
}

function normalizeNext(result: ExecResult | void, definition: NodeDefinition): string[] {
  if (result && result.next === null)
    return [];

  if (result && Array.isArray(result.next))
    return result.next;

  if (result && typeof result.next === "string")
    return [result.next];

  const first = definition.manifest.outputs.find(port => port.kind === "exec");
  return first ? [first.id] : [];
}

/**
 * 工作流执行引擎。核心只做通用事情：exec 遍历、数据求值、变量、错误、重试、取消、运行记录。
 * 任何节点语义都通过 registry 查到的 executor 完成，引擎里没有节点类型的 switch。
 *
 * 遍历是「递归 + 并行」：一个节点的每个 exec 出口若连到多个后继，这些后继会并行执行
 * （例如「开始」同时连多个节点）。线性链路自然就是顺序的。
 */
export class WorkflowEngine {
  constructor(private registry: NodeRegistry, private services: NodeServices) {}

  async run(graph: WorkflowGraph, options: RunOptions): Promise<RunRecord> {
    const run = createRunRecord(nextRunId(), options.workflowName, options.trigger ?? "手动");
    const emit = () => options.onUpdate?.(run);
    const finish = (status: RunStatus) => {
      run.status = status;
      run.finishedAt = Date.now();
      emit();
    };

    const index: GraphIndex = indexGraph(graph, this.registry);
    const trigger = findTrigger(graph, this.registry);

    if (!trigger) {
      run.error = "缺少触发器节点，工作流无法运行";
      finish("failed");
      return run;
    }

    const variables = new MemoryVariables();

    for (const [key, value] of Object.entries(options.params ?? {}))
      variables.set(key, value);

    const outputs = new Map<string, Record<string, unknown>>();
    /* 控制流节点注册的错误处理出口（try/catch 之类），后进先出 */
    const errorHandlers: ErrorHandler[] = [];
    let logSequence = 0;
    let tokenSequence = 0;

    const log = (level: "debug" | "info" | "warn" | "error", message: string, nodeId?: string) => {
      logSequence += 1;
      run.logs.push({ id: logSequence, time: Date.now(), level, nodeId, message });
      this.services.logger.log(level, message);
      emit();
    };

    const makeContext = (nodeId: string): NodeContext => {
      const flow: FlowHooks = {
        pushErrorHandler: (handle: string) => {
          tokenSequence += 1;
          errorHandlers.push({ token: tokenSequence, nodeId, handle });
          return tokenSequence;
        },
        popErrorHandler: (token: number) => {
          const at = errorHandlers.findIndex(handler => handler.token === token);

          if (at >= 0)
            errorHandlers.splice(at, 1);
        },
        variables,
        sleep: (ms, signal) => sleep(ms, signal)
      };

      return {
        runId: run.id,
        graph,
        nodeId,
        signal: options.signal,
        services: this.services,
        logger: { log: (level, message) => log(level, message, nodeId) },
        flow
      };
    };

    const resolveInputs = async (node: WorkflowGraphNode, evaluating: Set<string>): Promise<ExecInputs> => {
      const definition = this.registry.get(node.type);

      if (!definition)
        return {};

      const inputs: ExecInputs = {};

      for (const port of definition.manifest.inputs) {
        if (port.kind !== "data")
          continue;

        const incoming = index.dataIncoming.get(`${node.id}:${port.id}`);

        if (!incoming)
          continue;

        inputs[port.id] = await resolveOutput(incoming.nodeId, incoming.handle, evaluating);
      }

      return inputs;
    };

    const resolveOutput = async (sourceId: string, handle: string, evaluating: Set<string>): Promise<unknown> => {
      const cached = outputs.get(sourceId);

      if (cached && handle in cached)
        return cached[handle];

      const source = index.nodes.get(sourceId);
      const definition = source ? this.registry.get(source.type) : undefined;

      if (!source || !definition?.manifest.pure || !definition.execute || evaluating.has(sourceId))
        return undefined;

      evaluating.add(sourceId);

      const result = await this.invoke(definition, makeContext(sourceId), await resolveInputs(source, evaluating), source.config);

      outputs.set(sourceId, result?.outputs ?? {});
      evaluating.delete(sourceId);

      return outputs.get(sourceId)?.[handle];
    };

    const executeNode = async (node: WorkflowGraphNode): Promise<ExecResult | void> => {
      const definition = this.registry.get(node.type);

      if (!definition?.execute)
        return {};

      const config = { ...configDefaults(definition), ...node.config };
      const policy = readErrorPolicy(config);
      const inputs = await resolveInputs(node, new Set());
      let attempt = 0;

      for (;;) {
        try {
          return await this.invoke(definition, makeContext(node.id), inputs, config);
        } catch (error) {
          if (attempt < policy.retryCount && !options.signal.aborted) {
            attempt += 1;
            log("warn", `第 ${attempt} 次重试：${messageOf(error)}`, node.id);
            await sleep(policy.retryDelay, options.signal);
            continue;
          }

          throw error;
        }
      }
    };

    /* 执行一个出口连到的所有后继（并行） */
    const runNext = async (nodeId: string, definition: NodeDefinition, result: ExecResult | void): Promise<void> => {
      const targets = new Set<string>();

      for (const handle of normalizeNext(result, definition))
        for (const target of edgeTargets(index, nodeId, handle))
          targets.add(target);

      await Promise.all([...targets].map(target => runFrom(target)));
    };

    const runFrom = async (nodeId: string): Promise<void> => {
      const node = index.nodes.get(nodeId);
      const definition = node ? this.registry.get(node.type) : undefined;

      /* 工作流已取消：后面的节点不再执行，但要记一笔，避免看起来「什么都没发生」 */
      if (options.signal.aborted) {
        if (node && definition) {
          run.nodes[nodeId] = { nodeId, type: node.type, title: definition.manifest.title, status: "skipped" };
          log("warn", `工作流已停止，跳过「${definition.manifest.title}」`, nodeId);
        }

        return;
      }

      if (!node || !definition) {
        log("error", `节点不存在或类型未注册：${nodeId}`);
        return;
      }

      run.nodes[nodeId] = {
        nodeId,
        type: node.type,
        title: definition.manifest.title,
        status: "running",
        startedAt: Date.now()
      };
      emit();

      let result: ExecResult | void;

      try {
        result = await executeNode(node);
      } catch (error) {
        const message = messageOf(error);

        run.nodes[nodeId] = { ...run.nodes[nodeId], status: "failed", finishedAt: Date.now(), error: message };
        log("error", message, nodeId);

        /* 有控制流错误处理出口就转过去，否则按节点的出错策略处理 */
        const handler = errorHandlers.pop();

        if (handler) {
          variables.set("error", message);

          for (const target of edgeTargets(index, handler.nodeId, handler.handle))
            await runFrom(target);

          return;
        }

        const config = { ...configDefaults(definition), ...node.config };

        if (readErrorPolicy(config).onError === "continue") {
          await runNext(nodeId, definition, undefined);
          return;
        }

        throw error;
      }

      outputs.set(nodeId, result?.outputs ?? {});
      run.nodes[nodeId] = {
        ...run.nodes[nodeId],
        status: "success",
        finishedAt: Date.now(),
        outputs: result?.outputs
      };
      emit();

      await runNext(nodeId, definition, result);
    };

    try {
      await runFrom(trigger.id);
      finish(options.signal.aborted ? "cancelled" : "success");
    } catch (error) {
      run.error = messageOf(error);
      finish("failed");
    }

    return run;
  }

  private async invoke(
    definition: NodeDefinition,
    ctx: NodeContext,
    inputs: ExecInputs,
    config: Record<string, unknown>
  ): Promise<ExecResult | void> {
    const executor = definition.execute as Executor | undefined;

    if (!executor)
      return {};

    return executor({ ctx, inputs, config });
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Node
} from "reactflow";
import "reactflow/dist/style.css";
import { listWorkflows, loadWorkflow, saveWorkflow, showMenu, showMessage, type SavedConnection } from "../../api";
import type { AutomationTab } from "../../app/appTypes";
import { Icon } from "../../ui/icons";
import { nextEdgeId, NodeRegistry, ProviderRegistry, WorkflowEngine } from "../core";
import { BUILTIN_NODES } from "../nodes";
import { createElectronServices } from "../host/electronHost";
import type { ConfigOption, WorkflowGraph } from "../sdk";
import { AutomationContext } from "./context";
import {
  AUTOMATION_DND_TYPE,
  AUTOMATION_NODE_TYPE,
  createFlowNode,
  toFlowEdges,
  toFlowNodes,
  toGraph,
  type AutomationNodeData
} from "./flowAdapter";
import { AutomationNodeView } from "./NodeView";
import { Inspector } from "./Inspector";
import { Palette } from "./Palette";
import { RunPanel } from "./RunPanel";
import { graphSignature } from "../core";
import type { RunRecord } from "../core";
import "./automation.css";

const NODE_TYPES = { [AUTOMATION_NODE_TYPE]: AutomationNodeView };

export interface AutomationEditorProps {
  tab: AutomationTab;
  connections: SavedConnection[];
  onChange: (patch: Partial<AutomationTab>) => void;
  onStatus: (message: string) => void;
  onError: (message: string | null) => void;
}

export function AutomationEditor(props: AutomationEditorProps) {
  return (
    <ReactFlowProvider>
      <AutomationCanvas {...props} />
    </ReactFlowProvider>
  );
}

function AutomationCanvas({ tab, connections, onChange, onStatus, onError }: AutomationEditorProps) {
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;

  const runtime = useMemo(() => {
    const registry = new NodeRegistry();
    registry.registerAll(BUILTIN_NODES);

    const providers = new ProviderRegistry();
    providers.register("connections", () => connectionsRef.current.map(connection => ({
      label: connection.name,
      value: connection.name,
      logo: connection.type
    })));

    const services = createElectronServices({ getConnections: () => connectionsRef.current });
    const engine = new WorkflowEngine(registry, services);

    return { registry, providers, engine };
  }, []);

  const [options, setOptions] = useState<Record<string, ConfigOption[]>>({});

  useEffect(() => {
    let alive = true;

    Promise.all(runtime.providers.ids().map(async id => [id, await runtime.providers.resolve(id)] as const))
      .then(entries => {
        if (alive)
          setOptions(Object.fromEntries(entries));
      });

    return () => {
      alive = false;
    };
  }, [runtime, connections]);

  const [nodes, setNodes, onNodesChange] = useNodesState<AutomationNodeData>(toFlowNodes(tab.graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(tab.graph));
  const [name, setName] = useState(tab.file ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [running, setRunning] = useState(false);
  const flow = useReactFlow<AutomationNodeData>();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dirtyRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setConfigValue = useCallback((nodeId: string, key: string, value: unknown) => {
    setNodes(previous => previous.map(node => node.id === nodeId
      ? { ...node, data: { ...node.data, config: { ...node.data.config, [key]: value } } }
      : node));
  }, [setNodes]);

  const addNode = useCallback((nodeType: string, position?: { x: number; y: number }) => {
    let target = position;

    if (!target) {
      const rect = wrapperRef.current?.getBoundingClientRect();
      const center = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };

      target = flow.screenToFlowPosition(center);
      target = { x: target.x - 100 + Math.random() * 48, y: target.y - 40 + Math.random() * 48 };
    }

    setNodes(previous => [...previous, createFlowNode(nodeType, target as { x: number; y: number })]);
  }, [flow, setNodes]);

  const onConnect = useCallback((connection: Connection) => {
    setEdges(previous => addEdge({
      ...connection,
      id: nextEdgeId(),
      type: "smoothstep",
      animated: true,
      style: { strokeWidth: 2 }
    }, previous));
  }, [setEdges]);

  const deleteNode = useCallback((nodeId: string) => {
    setNodes(previous => previous.filter(node => node.id !== nodeId));
    setEdges(previous => previous.filter(edge => edge.source !== nodeId && edge.target !== nodeId));
    setSelectedId(null);
  }, [setNodes, setEdges]);

  const confirmDiscard = useCallback(async () => {
    if (!dirtyRef.current)
      return true;

    const answer = await showMessage({
      type: "warning",
      title: "未保存的工作流",
      message: "当前工作流还没保存，继续将丢失改动。",
      buttons: ["继续", "取消"]
    });

    return answer === 0;
  }, []);

  const currentGraph = useCallback(
    () => toGraph(flow.getNodes(), flow.getEdges(), flow.getViewport()),
    [flow]
  );

  const handleNew = useCallback(async () => {
    if (!(await confirmDiscard()))
      return;

    setNodes([]);
    setEdges([]);
    setName("");
    onChangeRef.current({ file: undefined, savedSignature: "", graph: { version: 1, nodes: [], edges: [] } });
    setRun(null);
  }, [confirmDiscard, setNodes, setEdges]);

  const handleOpen = useCallback(async () => {
    if (!(await confirmDiscard()))
      return;

    const files = await listWorkflows();

    if (files.length === 0) {
      onStatus("还没有已保存的工作流");
      return;
    }

    const picked = await showMenu(files.map(file => ({ id: file.name, label: file.name })));

    if (!picked)
      return;

    const loaded = await loadWorkflow(picked);

    if (!loaded) {
      onError("工作流读取失败");
      return;
    }

    const graph = loaded.graph ?? { version: 1, nodes: [], edges: [] };

    setNodes(toFlowNodes(graph));
    setEdges(toFlowEdges(graph));
    setName(loaded.name);
    onChangeRef.current({ file: loaded.name, savedSignature: graphSignature(graph), title: loaded.name, graph });

    if (graph.viewport)
      flow.setViewport(graph.viewport);
    else
      window.setTimeout(() => flow.fitView({ padding: 0.2 }), 30);

    onStatus(`已打开工作流「${loaded.name}」`);
  }, [confirmDiscard, flow, onStatus, onError, setNodes, setEdges]);

  const handleSave = useCallback(async () => {
    const target = name.trim() || tab.title.trim();

    if (!target) {
      onError("请先填写工作流名称");
      return;
    }

    const graph = currentGraph();
    const result = await saveWorkflow(target, graph);

    if (!result.ok) {
      onError(result.error ?? "工作流保存失败");
      return;
    }

    const savedName = result.name ?? target;

    setName(savedName);
    onChangeRef.current({ file: savedName, savedSignature: graphSignature(graph), title: savedName, graph });
    onStatus(`工作流「${savedName}」已保存`);
  }, [name, tab.title, currentGraph, onStatus, onError]);

  const handleRun = useCallback(async () => {
    if (abortRef.current)
      return;

    const controller = new AbortController();
    abortRef.current = controller;
    setRun(null);
    setRunning(true);
    onStatus("工作流执行中…");

    const graph = currentGraph();
    const record = await runtime.engine.run(graph, {
      workflowName: name.trim() || tab.title,
      trigger: "手动",
      signal: controller.signal,
      onUpdate: current => setRun({ ...current })
    });

    abortRef.current = null;
    setRunning(false);
    setRun({ ...record });
    onStatus(record.status === "success" ? "工作流执行完成" : record.status === "cancelled" ? "工作流已停止" : "工作流执行失败");
  }, [runtime, currentGraph, name, tab.title, onStatus]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => onChangeRef.current({ graph: currentGraph() }), 400);
    return () => window.clearTimeout(timer);
  }, [nodes, edges, currentGraph]);

  const latestRef = useRef({ nodes, edges });
  latestRef.current = { nodes, edges };

  useEffect(() => () => {
    onChangeRef.current({ graph: toGraph(latestRef.current.nodes, latestRef.current.edges, flow.getViewport()) });
    abortRef.current?.abort();
  }, [flow]);

  const dirty = tab.savedSignature != null
    && tab.savedSignature !== graphSignature(toGraph(nodes, edges, undefined));
  dirtyRef.current = dirty;

  const selected = nodes.find(node => node.id === selectedId) ?? null;

  return (
    <AutomationContext.Provider value={{ registry: runtime.registry, options, setConfigValue }}>
      <div className="am-editor">
        <div className="am-toolbar">
          <button type="button" className="tbtn" onClick={() => void handleNew()}>
            <Icon name="plus" />新建
          </button>
          <button type="button" className="tbtn" onClick={() => void handleOpen()}>
            <Icon name="folderOpen" />打开
          </button>
          <button type="button" className="tbtn" onClick={() => void handleSave()}>
            <Icon name="save" />保存
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
          <button type="button" className="tbtn is-primary" disabled={running} onClick={() => void handleRun()}>
            <Icon name="play" />运行
          </button>
          <button type="button" className="tbtn is-danger" disabled={!running} onClick={handleStop}>
            <Icon name="stop" />停止
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
          <span className="am-name-wrap">
            <Icon name="workflow" size={13} />
            <input
              className="am-name"
              value={name}
              placeholder="工作流名称"
              aria-label="工作流名称"
              onChange={event => setName(event.target.value)}
            />
          </span>
          {dirty && <span className="am-dirty">未保存</span>}
          <span className="tbtn-push" aria-hidden="true" />
          <span className="toolbar-text">共 {nodes.length} 个节点 · {edges.length} 条连线</span>
        </div>

        <div className="am-body">
          <Palette onAdd={nodeType => addNode(nodeType)} />

          <div
            className="am-canvas"
            ref={wrapperRef}
            onDrop={event => {
              event.preventDefault();
              const nodeType = event.dataTransfer.getData(AUTOMATION_DND_TYPE);

              if (nodeType)
                addNode(nodeType, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
            }}
            onDragOver={event => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onSelectionChange={({ nodes: selectedNodes }) => setSelectedId(selectedNodes[0]?.id ?? null)}
              onEdgeDoubleClick={(event, edge) => {
                event.preventDefault();
                setEdges(previous => previous.filter(item => item.id !== edge.id));
              }}
              defaultViewport={tab.graph.viewport}
              fitView={!tab.graph.viewport}
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.2}
              maxZoom={1.8}
              deleteKeyCode={["Backspace", "Delete"]}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={18} size={1.4} />
              <MiniMap pannable zoomable />
              <Controls />
            </ReactFlow>
          </div>

          <div className="am-side">
            <Inspector node={selected} onDelete={deleteNode} />
            <RunPanel run={run} />
          </div>
        </div>
      </div>
    </AutomationContext.Provider>
  );
}

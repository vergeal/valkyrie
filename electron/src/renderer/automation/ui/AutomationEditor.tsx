import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  addEdge,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  ConnectionLineType,
  SelectionMode,
  type Node,
  type NodeChange,
  type NodePositionChange,
  type XYPosition
} from "reactflow";
import "reactflow/dist/style.css";
import {
  invoke, listWorkflows, loadWorkflow, onShortcut, saveWorkflow, showMenu, showMessage,
  type SavedConnection, type ScriptFile
} from "../../api";
import type { AutomationTab } from "../../app/appTypes";
import { Icon } from "../../ui/icons";
import { popupNativeMenu } from "../../ui/Menu";
import { ACCEL, IS_MAC, KEY } from "../../keys";
import { nextEdgeId, NodeRegistry, ProviderRegistry, WorkflowEngine } from "../core";
import { BUILTIN_NODES } from "../nodes";
import { createElectronServices } from "../host/electronHost";
import type { ConfigOption, NodeDefinition, PortDefinition, WorkflowGraph, WorkspaceService } from "../sdk";
import { AutomationContext } from "./context";
import {
  AUTOMATION_DND_TYPE,
  AUTOMATION_NODE_TYPE,
  createFlowEdge,
  createFlowNode,
  toFlowEdges,
  toFlowNodes,
  toGraph,
  type AutomationNodeData
} from "./flowAdapter";
import { compatibleNodes, matchPort, portOf, type HandleType } from "./connectCompat";
import { AutomationNodeView } from "./NodeView";
import { Inspector } from "./Inspector";
import { Palette } from "./Palette";
import { RunPanel } from "./RunPanel";
import { ConnectMenu, type ConnectMenuState } from "./ConnectMenu";
import { boundingRect, snapRect, type AlignGuide, type AlignRect } from "./snapAlign";
import { clipOf, pasteClip, type GraphClip } from "./nodeClipboard";
import { cloneEdges, cloneNodes, useGraphHistory, type GraphSnapshot } from "./useGraphHistory";
import { WorkflowManager } from "./WorkflowManager";
import { graphSignature, resolveNodeContext } from "../core";
import type { RunRecord } from "../core";
import "./automation.css";

const NODE_TYPES = { [AUTOMATION_NODE_TYPE]: AutomationNodeView };

/** 拖动中的位置变化：位置一定已经算出来了 */
type MovingChange = NodePositionChange & { position: XYPosition };

/** 卡片对齐磁吸的吸附距离（屏幕像素），落到 flow 坐标时再除以缩放 */
const SNAP_DISTANCE = 6;

/** 量不到渲染尺寸时的兜底（与 .am-node 的最小宽度一致） */
const FALLBACK_SIZE = { w: 240, h: 80 };

export interface AutomationEditorProps {
  tab: AutomationTab;
  connections: SavedConnection[];
  workspace: WorkspaceService;
  onChange: (patch: Partial<AutomationTab>) => void;
  onStatus: (message: string) => void;
  onError: (message: string | null) => void;
  /** 把「叫停本次运行」交给外面的标签域：标签被关掉时由它触发 */
  registerStop: (stop: () => void) => void;
  /** 卡片拖动对齐磁吸（选项里的开关，默认关） */
  snapEnabled: boolean;
  /** 弹输入框 / 确认框（工作流管理、另存为用） */
  askText: (title: string, value?: string) => Promise<string | null>;
  askConfirm: (message: string, title?: string, danger?: boolean) => Promise<boolean>;
}

export function AutomationEditor(props: AutomationEditorProps) {
  return (
    <ReactFlowProvider>
      <AutomationCanvas {...props} />
    </ReactFlowProvider>
  );
}

function AutomationCanvas(props: AutomationEditorProps) {
  const {
    tab, connections, workspace, onChange, onStatus, onError, registerStop, snapEnabled, askText, askConfirm
  } = props;
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

    const services = createElectronServices({ getConnections: () => connectionsRef.current, workspace });
    const engine = new WorkflowEngine(registry, services);

    return { registry, providers, engine };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const [nodes, setNodes] = useNodesState<AutomationNodeData>(toFlowNodes(tab.graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toFlowEdges(tab.graph));
  const [name, setName] = useState(tab.file ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [running, setRunning] = useState(false);
  const [connectMenu, setConnectMenu] = useState<{
    state: ConnectMenuState;
    nodes: NodeDefinition[];
    sourceNodeId: string;
    sourceHandle: string | null;
    handleType: HandleType;
    port: PortDefinition;
  } | null>(null);
  const flow = useReactFlow<AutomationNodeData>();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dirtyRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const dragRef = useRef<{ nodeId: string; handleId: string | null; handleType: HandleType } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const connectedRef = useRef(false);
  const registerStopRef = useRef(registerStop);
  registerStopRef.current = registerStop;
  /* 对齐磁吸：拖动开始时量一遍卡片尺寸，拖动过程中出辅助线 */
  const dragSizesRef = useRef(new Map<string, { w: number; h: number }>());
  const [guides, setGuides] = useState<AlignGuide[]>([]);
  const guideKeyRef = useRef("");
  /* 撤销 / 重做：整图快照栈；复制缓冲只在画布内部用 */
  const history = useGraphHistory();
  const clipRef = useRef<GraphClip | null>(null);
  const [clipCount, setClipCount] = useState(0);
  const dragSnapshotRef = useRef<GraphSnapshot | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);

  const measureSizes = useCallback((ids: string[]) => {
    const zoom = flow.getZoom() || 1;
    const sizes = new Map<string, { w: number; h: number }>();

    for (const id of ids) {
      const rect = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect();

      sizes.set(id, rect ? { w: rect.width / zoom, h: rect.height / zoom } : FALLBACK_SIZE);
    }

    return sizes;
  }, [flow]);

  const showGuides = useCallback((next: AlignGuide[]) => {
    const key = next.map(guide => `${guide.vertical ? "v" : "h"}|${guide.at}|${guide.from}|${guide.to}`).join(";");

    if (key === guideKeyRef.current)
      return;

    guideKeyRef.current = key;
    setGuides(next);
  }, []);

  /* 辅助线的 flow 坐标 → .am-canvas 内的像素位置（线宽固定 1px，不跟着缩放变粗） */
  const guideStyle = useCallback((guide: AlignGuide): CSSProperties => {
    const origin = wrapperRef.current?.getBoundingClientRect();
    const from = flow.flowToScreenPosition(guide.vertical
      ? { x: guide.at, y: guide.from }
      : { x: guide.from, y: guide.at });
    const to = flow.flowToScreenPosition(guide.vertical
      ? { x: guide.at, y: guide.to }
      : { x: guide.to, y: guide.at });
    const left = from.x - (origin?.left ?? 0);
    const top = from.y - (origin?.top ?? 0);

    return guide.vertical
      ? { left, top, height: to.y - from.y }
      : { top, left, width: to.x - from.x };
  }, [flow]);

  /* ------------------------------ 撤销 / 重做 / 复制粘贴 ------------------------------ */

  const snapshot = useCallback((): GraphSnapshot => ({
    nodes: cloneNodes(nodesRef.current),
    edges: cloneEdges(edgesRef.current)
  }), []);

  /** 改动前压一份快照；mergeKey 相同且间隔很短时合并成一步（连续输入用） */
  const remember = useCallback((mergeKey?: string) => {
    history.remember(snapshot(), mergeKey);
  }, [history, snapshot]);

  const applySnapshot = useCallback((next: GraphSnapshot) => {
    setSelectedId(null);
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [setNodes, setEdges]);

  const undo = useCallback(() => {
    const previous = history.undo(snapshot());

    if (previous)
      applySnapshot(previous);
  }, [history, snapshot, applySnapshot]);

  const redo = useCallback(() => {
    const next = history.redo(snapshot());

    if (next)
      applySnapshot(next);
  }, [history, snapshot, applySnapshot]);

  const copySelection = useCallback(() => {
    const clip = clipOf(nodesRef.current, edgesRef.current);

    if (!clip) {
      onStatus("没有选中卡片，先点选或框选再复制");
      return false;
    }

    clipRef.current = clip;
    setClipCount(clip.nodes.length);
    onStatus(`已复制 ${clip.nodes.length} 个卡片`);

    return true;
  }, [onStatus]);

  const pasteSelection = useCallback(() => {
    const clip = clipRef.current;

    if (!clip) {
      onStatus("剪贴板里还没有卡片");
      return;
    }

    remember();

    const pasted = pasteClip(clip);

    setNodes(previous => [...previous.map(node => ({ ...node, selected: false })), ...pasted.nodes]);
    setEdges(previous => [...previous, ...pasted.edges]);
    setSelectedId(pasted.nodes[0]?.id ?? null);
    onStatus(`已粘贴 ${pasted.nodes.length} 个卡片`);
  }, [remember, setNodes, setEdges, onStatus]);

  const deleteSelection = useCallback(() => {
    const ids = new Set(nodesRef.current.filter(node => node.selected).map(node => node.id));
    const orphanEdges = edgesRef.current.filter(edge => edge.selected).length;

    if (ids.size === 0 && orphanEdges === 0)
      return;

    remember();
    setNodes(previous => previous.filter(node => !ids.has(node.id)));
    setEdges(previous => previous.filter(edge =>
      !edge.selected && !ids.has(edge.source) && !ids.has(edge.target)));
    setSelectedId(null);
    onStatus(ids.size > 0 ? `已删除 ${ids.size} 个卡片` : `已删除 ${orphanEdges} 条连线`);
  }, [remember, setNodes, setEdges, onStatus]);

  const cutSelection = useCallback(() => {
    if (copySelection())
      deleteSelection();
  }, [copySelection, deleteSelection]);

  const duplicateSelection = useCallback(() => {
    if (copySelection())
      pasteSelection();
  }, [copySelection, pasteSelection]);

  const selectAll = useCallback(() => {
    setNodes(previous => previous.map(node => ({ ...node, selected: true })));
    setEdges(previous => previous.map(edge => ({ ...edge, selected: true })));
  }, [setNodes, setEdges]);

  const setConfigValue = useCallback((nodeId: string, key: string, value: unknown) => {
    /* 同一个字段连续输入合并成一步撤销 */
    remember(`config:${nodeId}:${key}`);
    setNodes(previous => previous.map(node => node.id === nodeId
      ? { ...node, data: { ...node.data, config: { ...node.data.config, [key]: value } } }
      : node));
  }, [remember, setNodes]);

  /*
   * 卡片拖动：先按「和其它卡片的边 / 中线对齐」把位置吸过去，再交给 reactflow 落到状态里。
   * reactflow 每次拖动都是从「按下时的位置 + 指针位移」算的，所以吸附不会累积偏移。
   */
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const moving = changes.filter((change): change is MovingChange =>
      change.type === "position" && change.dragging === true && change.position != null);

    /* 删除键由画布直接发删除变更，先记一步快照，撤销才回得来 */
    if (changes.some(change => change.type === "remove"))
      remember();

    if (!snapEnabled) {
      showGuides([]);
      setNodes(previous => applyNodeChanges(changes, previous));
      return;
    }

    if (moving.length === 0) {
      if (changes.some(change => change.type === "position" && !change.dragging))
        showGuides([]);

      setNodes(previous => applyNodeChanges(changes, previous));
      return;
    }

    const sizeOf = (id: string) => dragSizesRef.current.get(id) ?? FALLBACK_SIZE;
    const movingIds = new Set(moving.map(change => change.id));
    const rectOf = (id: string, position: { x: number; y: number }): AlignRect =>
      ({ x: position.x, y: position.y, ...sizeOf(id) });

    const box = boundingRect(moving.map(change => rectOf(change.id, change.position)));
    const others = nodesRef.current
      .filter(node => !movingIds.has(node.id))
      .map(node => rectOf(node.id, node.position));
    const snap = snapRect(box, others, SNAP_DISTANCE / (flow.getZoom() || 1));

    showGuides(snap.guides);

    setNodes(previous => applyNodeChanges(changes.map(change => {
      if (change.type !== "position" || !change.position || !movingIds.has(change.id))
        return change;

      return {
        ...change,
        position: {
          x: change.position.x + snap.dx,
          y: change.position.y + snap.dy
        }
      };
    }), previous));
  }, [flow, remember, showGuides, setNodes, snapEnabled]);

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

    remember();
    setNodes(previous => [...previous, createFlowNode(nodeType, target as { x: number; y: number })]);
  }, [flow, remember, setNodes]);

  const onConnect = useCallback((connection: Connection) => {
    remember();
    connectedRef.current = true;
    setEdges(previous => addEdge({
      ...connection,
      id: nextEdgeId(),
      type: "default",
      animated: true,
      style: { strokeWidth: 3 }
    }, previous));
  }, [remember, setEdges]);

  const onConnectStart = useCallback((_event: unknown, params: { nodeId?: string | null; handleId?: string | null; handleType?: string | null } | null) => {
    connectedRef.current = false;
    const point = _event as { clientX?: number; clientY?: number } | null;

    dragStartRef.current = point && typeof point.clientX === "number"
      ? { x: point.clientX, y: point.clientY ?? 0 }
      : null;
    dragRef.current = params?.nodeId
      ? { nodeId: params.nodeId, handleId: params.handleId ?? null, handleType: params.handleType === "target" ? "target" : "source" }
      : null;
  }, []);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    const drag = dragRef.current;
    const start = dragStartRef.current;

    dragRef.current = null;
    dragStartRef.current = null;

    if (connectedRef.current || !drag)
      return;

    const point = "clientX" in event ? { x: event.clientX, y: event.clientY } : { x: 0, y: 0 };

    /* 只是点了一下引脚没有拖动：不弹菜单 */
    if (start && Math.hypot(point.x - start.x, point.y - start.y) < 4)
      return;

    const node = nodesRef.current.find(item => item.id === drag.nodeId);
    const port = portOf(runtime.registry, node?.data.nodeType ?? "", drag.handleId);

    if (!port)
      return;

    const candidates = compatibleNodes(runtime.registry, port, drag.handleType);

    if (candidates.length === 0)
      return;

    const flowPoint = flow.screenToFlowPosition(point);

    setConnectMenu({
      state: { screenX: point.x, screenY: point.y, flowX: flowPoint.x, flowY: flowPoint.y },
      nodes: candidates,
      sourceNodeId: drag.nodeId,
      sourceHandle: drag.handleId,
      handleType: drag.handleType,
      port
    });
  }, [runtime, flow]);

  const pickConnectNode = useCallback((nodeType: string) => {
    const menu = connectMenu;

    if (!menu)
      return;

    const definition = runtime.registry.get(nodeType);
    const port = menu.port;

    setConnectMenu(null);

    if (!definition || !port)
      return;

    const target = matchPort(definition, port, menu.handleType);
    const node = createFlowNode(nodeType, { x: menu.state.flowX, y: menu.state.flowY - 30 });

    remember();
    setNodes(previous => [...previous, node]);

    if (target && menu.sourceHandle) {
      const edge = menu.handleType === "source"
        ? createFlowEdge(menu.sourceNodeId, menu.sourceHandle, node.id, target.id)
        : createFlowEdge(node.id, target.id, menu.sourceNodeId, menu.sourceHandle);

      setEdges(previous => addEdge(edge, previous));
    }
  }, [connectMenu, runtime, remember, setNodes, setEdges]);

  const deleteNode = useCallback((nodeId: string) => {
    remember();
    setNodes(previous => previous.filter(node => node.id !== nodeId));
    setEdges(previous => previous.filter(edge => edge.source !== nodeId && edge.target !== nodeId));
    setSelectedId(null);
  }, [remember, setNodes, setEdges]);

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

    history.reset();
    setNodes([]);
    setEdges([]);
    setName("");
    onChangeRef.current({ file: undefined, savedSignature: "", graph: { version: 1, nodes: [], edges: [] } });
    setRun(null);
  }, [confirmDiscard, history, setNodes, setEdges]);

  /** 打开指定工作流到画布（工具栏「打开」与工作流管理共用） */
  const openWorkflow = useCallback(async (target: string) => {
    const loaded = await loadWorkflow(target);

    if (!loaded) {
      onError("工作流读取失败");
      return;
    }

    const graph = loaded.graph ?? { version: 1, nodes: [], edges: [] };

    history.reset();
    setNodes(toFlowNodes(graph));
    setEdges(toFlowEdges(graph));
    setName(loaded.name);
    onChangeRef.current({ file: loaded.name, savedSignature: graphSignature(graph), title: loaded.name, graph });
    setSelectedId(null);

    if (graph.viewport)
      flow.setViewport(graph.viewport);
    else
      window.setTimeout(() => flow.fitView({ padding: 0.2 }), 30);

    onStatus(`已打开工作流「${loaded.name}」`);
  }, [history, flow, onStatus, onError, setNodes, setEdges]);

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

    await openWorkflow(picked);
  }, [confirmDiscard, openWorkflow, onStatus]);

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

  /** 另存为：问一个新名字再存，画布切到新文件 */
  const handleSaveAs = useCallback(async () => {
    const target = await askText("另存为工作流", name.trim() || tab.title.trim() || "未命名工作流");

    if (!target)
      return;

    const graph = currentGraph();
    const result = await saveWorkflow(target, graph);

    if (!result.ok) {
      onError(result.error ?? "工作流保存失败");
      return;
    }

    const savedName = result.name ?? target;

    setName(savedName);
    onChangeRef.current({ file: savedName, savedSignature: graphSignature(graph), title: savedName, graph });
    onStatus(`已另存为「${savedName}」`);
  }, [askText, name, tab.title, currentGraph, onStatus, onError]);

  /** 工作流管理里「新建」：存一份空工作流并切到它 */
  const createWorkflow = useCallback(async (target: string) => {
    const graph: WorkflowGraph = { version: 1, nodes: [], edges: [] };
    const result = await saveWorkflow(target, graph);

    if (!result.ok) {
      onError(result.error ?? "工作流创建失败");
      return;
    }

    const savedName = result.name ?? target;

    history.reset();
    setNodes([]);
    setEdges([]);
    setSelectedId(null);
    setName(savedName);
    onChangeRef.current({ file: savedName, savedSignature: graphSignature(graph), title: savedName, graph });
    onStatus(`已新建工作流「${savedName}」`);
  }, [history, setNodes, setEdges, onStatus, onError]);

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
  }, [flow]);

  /*
   * 工作流会自己打开查询页，活动标签被切走后本组件就会被卸载 —— 这时运行必须继续，
   * 所以卸载时不再中止，改成把「叫停」登记给标签域，只在标签被真正关掉时才停。
   */
  const stopRun = useCallback(() => abortRef.current?.abort(), []);

  useEffect(() => {
    registerStopRef.current(stopRun);
  }, [stopRun]);

  const dirty = tab.savedSignature != null
    && tab.savedSignature !== graphSignature(toGraph(nodes, edges, undefined));
  dirtyRef.current = dirty;

  const selected = nodes.find(node => node.id === selectedId) ?? null;
  const selectedCount = nodes.filter(node => node.selected).length;

  /* 卡片对齐：按当前选中节点的渲染尺寸对齐 / 等距分布 */
  function alignSelected(mode: "left" | "centerH" | "right" | "top" | "centerV" | "bottom" | "distributeH" | "distributeV") {
    const selectedNodes = flow.getNodes().filter(node => node.selected);

    if (selectedNodes.length < 2)
      return;

    const sizes = measureSizes(selectedNodes.map(node => node.id));
    const items = selectedNodes.map(node => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      ...(sizes.get(node.id) ?? FALLBACK_SIZE)
    }));

    const minX = Math.min(...items.map(item => item.x));
    const maxX = Math.max(...items.map(item => item.x + item.w));
    const minY = Math.min(...items.map(item => item.y));
    const maxY = Math.max(...items.map(item => item.y + item.h));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const positions = new Map<string, { x: number; y: number }>();

    if (mode === "distributeH" || mode === "distributeV") {
      const horizontal = mode === "distributeH";
      const sorted = [...items].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
      const span = horizontal ? maxX - minX : maxY - minY;
      const total = sorted.reduce((sum, item) => sum + (horizontal ? item.w : item.h), 0);
      const gap = (span - total) / (sorted.length - 1);
      let cursor = horizontal ? minX : minY;

      for (const item of sorted) {
        positions.set(item.id, horizontal
          ? { x: Math.round(cursor), y: Math.round(item.y) }
          : { x: Math.round(item.x), y: Math.round(cursor) });
        cursor += (horizontal ? item.w : item.h) + gap;
      }
    } else {
      for (const item of items) {
        let x = item.x;
        let y = item.y;

        if (mode === "left") x = minX;
        else if (mode === "centerH") x = centerX - item.w / 2;
        else if (mode === "right") x = maxX - item.w;
        else if (mode === "top") y = minY;
        else if (mode === "centerV") y = centerY - item.h / 2;
        else if (mode === "bottom") y = maxY - item.h;

        positions.set(item.id, { x: Math.round(x), y: Math.round(y) });
      }
    }

    remember();
    setNodes(previous => previous.map(node => {
      const position = positions.get(node.id);
      return position ? { ...node, position } : node;
    }));
  }

  /* 画布当前图：供内联控件 / 属性面板做设计期上下文推断（按上游过滤脚本） */
  const graph = useMemo(() => toGraph(nodes, edges, undefined), [nodes, edges]);
  const [scriptOptions, setScriptOptions] = useState<Record<string, ConfigOption[]>>({});

  /* 需要脚本下拉的节点 → 它们上游推断出的连接/库/模式 */
  const scriptTargets = useMemo(() => nodes
    .filter(node => runtime.registry.get(node.data.nodeType)?.manifest.config.some(field => field.optionsSource === "scripts"))
    .map(node => ({ id: node.id, ctx: resolveNodeContext(graph, runtime.registry, node.id) })),
    [nodes, graph, runtime.registry]);

  /* 只在「节点 + 上下文」变化时重新拉脚本，避免拖动节点频繁请求 */
  const scriptKey = scriptTargets.map(item => `${item.id}|${item.ctx.connection ?? ""}|${item.ctx.schema ?? item.ctx.catalog ?? ""}`).join(";");

  useEffect(() => {
    let alive = true;

    Promise.all(scriptTargets.map(async item => {
      if (!item.ctx.connection)
        return [item.id, [] as ConfigOption[]] as const;

      try {
        const payload = await invoke<{ files: ScriptFile[] }>("queryFiles.list", { connection: item.ctx.connection });
        const scope = item.ctx.schema ?? item.ctx.catalog;
        const files = payload.files ?? [];
        const matched = scope ? files.filter(file => file.scope.toLowerCase() === scope.toLowerCase()) : files;

        return [item.id, matched.map(file => ({
          label: `${file.scope} / ${file.name}`,
          value: JSON.stringify({ connection: item.ctx.connection, scope: file.scope, name: file.name })
        }))] as const;
      } catch {
        return [item.id, [] as ConfigOption[]] as const;
      }
    })).then(entries => {
      if (alive)
        setScriptOptions(Object.fromEntries(entries));
    });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptKey]);

  /* ------------------------------ 画布快捷键与右键菜单 ------------------------------ */

  const fitView = useCallback(() => void flow.fitView({ padding: 0.2 }), [flow]);

  /* 键位处理统一走 ref：窗口监听只注册一次，运行时取到的永远是最新回调 */
  const actionsRef = useRef({
    copy: copySelection, cut: cutSelection, paste: pasteSelection, duplicate: duplicateSelection,
    remove: deleteSelection, selectAll, undo, redo, fitView,
    save: () => void handleSave(), saveAs: () => void handleSaveAs()
  });
  actionsRef.current = {
    copy: copySelection, cut: cutSelection, paste: pasteSelection, duplicate: duplicateSelection,
    remove: deleteSelection, selectAll, undo, redo, fitView,
    save: () => void handleSave(), saveAs: () => void handleSaveAs()
  };

  /* 焦点在输入框 / 下拉 / 弹窗里：快捷键归它们，画布不抢 */
  const typingInField = () => {
    const focused = document.activeElement as HTMLElement | null;

    return Boolean(focused?.closest?.("input, textarea, select, [contenteditable=true], .editor"));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], .editor"))
        return;

      const actions = actionsRef.current;
      const key = event.key.toLowerCase();

      /* 无修饰键：删除选中卡片 / 连线（画布自带的删除键也走这里，好在能记撤销） */
      if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        if (key === "delete" || key === "backspace") {
          actions.remove();
          event.preventDefault();
          event.stopPropagation();
        }

        return;
      }

      if (event.altKey)
        return;

      let handled = true;

      if (key === "z")
        event.shiftKey ? actions.redo() : actions.undo();
      else if (key === "y")
        actions.redo();
      else if (key === "c")
        handled = actions.copy();
      else if (key === "x")
        actions.cut();
      else if (key === "v")
        actions.paste();
      else if (key === "d")
        actions.duplicate();
      else if (key === "a")
        actions.selectAll();
      else if (key === "s")
        event.shiftKey ? actions.saveAs() : actions.save();
      else if (key === "0")
        actions.fitView();
      else
        handled = false;

      if (handled) {
        /* 捕获阶段拦住：别再让应用级快捷键（脚本保存、结果表复制）跟着跑一遍 */
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  /* macOS 菜单栏把 ⌘C / ⌘X / ⌘Z / ⇧⌘Z / ⌘A 转发过来（原生菜单会先吃掉这些组合键） */
  useEffect(() => onShortcut(action => {
    if (typingInField())
      return;

    const actions = actionsRef.current;

    if (action === "copy")
      actions.copy();
    else if (action === "cut")
      actions.cut();
    else if (action === "paste")
      actions.paste();
    else if (action === "undo")
      actions.undo();
    else if (action === "redo")
      actions.redo();
    else if (action === "select-all")
      actions.selectAll();
  }), []);

  /** 画布右键：复制 / 剪切 / 粘贴 / 删除 / 全选 / 适应视图 */
  const openCanvasMenu = () => {
    const actions = actionsRef.current;
    const selected = nodesRef.current.filter(node => node.selected).length;

    void popupNativeMenu([
      { label: "复制", accelerator: ACCEL.copy, icon: "copy", disabled: selected === 0, action: () => actions.copy() },
      { label: "剪切", accelerator: ACCEL.cut, icon: "cut", disabled: selected === 0, action: () => actions.cut() },
      { label: "粘贴", accelerator: ACCEL.paste, icon: "paste", disabled: clipCount === 0, action: () => actions.paste() },
      { label: "创建副本", accelerator: ACCEL.duplicate, icon: "duplicate", disabled: selected === 0, action: () => actions.duplicate() },
      { label: "删除", accelerator: "Delete", icon: "trash", danger: true, disabled: selected === 0, action: () => actions.remove() },
      { separator: true },
      { label: "全选", accelerator: ACCEL.selectAll, action: () => actions.selectAll() },
      { label: "适应视图", accelerator: ACCEL.fitView, action: () => actions.fitView() },
      { separator: true },
      { label: "撤销", accelerator: ACCEL.undo, icon: "undo", disabled: !history.canUndo, action: () => actions.undo() },
      { label: "重做", accelerator: ACCEL.redo, icon: "redo", disabled: !history.canRedo, action: () => actions.redo() }
    ]);
  };

  return (
    <AutomationContext.Provider value={{ registry: runtime.registry, options, scriptOptions, run, setConfigValue }}>
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
          <button
            type="button"
            className="tbtn"
            title="工作流管理（新建 / 打开 / 重命名 / 复制 / 删除）"
            onClick={() => setManagerOpen(true)}
          >
            <Icon name="layers" />管理
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
          <button type="button" className="tbtn is-primary" disabled={running} onClick={() => void handleRun()}>
            <Icon name="play" />运行
          </button>
          <button type="button" className="tbtn is-danger" disabled={!running} onClick={handleStop}>
            <Icon name="stop" />停止
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
          <button
            type="button"
            className="tbtn"
            title={`撤销 ${KEY.undo}`}
            disabled={!history.canUndo}
            onClick={undo}
          >
            <Icon name="undo" size={14} />
          </button>
          <button
            type="button"
            className="tbtn"
            title={`重做 ${KEY.redo}`}
            disabled={!history.canRedo}
            onClick={redo}
          >
            <Icon name="redo" size={14} />
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
          <button
            type="button"
            className="tbtn"
            title={`复制选中卡片 ${KEY.copy}`}
            disabled={selectedCount === 0}
            onClick={copySelection}
          >
            <Icon name="copy" size={14} />
          </button>
          <button
            type="button"
            className="tbtn"
            title={`粘贴卡片 ${KEY.paste}`}
            disabled={clipCount === 0}
            onClick={pasteSelection}
          >
            <Icon name="paste" size={14} />
          </button>
          <button
            type="button"
            className="tbtn"
            title="删除选中卡片（Delete）"
            disabled={selectedCount === 0}
            onClick={deleteSelection}
          >
            <Icon name="trash" size={14} />
          </button>
          {selectedCount >= 2 && (
            <>
              <span className="tbtn-sep" aria-hidden="true" />
              <span className="toolbar-text">对齐 {selectedCount}</span>
              <button type="button" className="tbtn" title="左对齐" onClick={() => alignSelected("left")}><Icon name="alignLeft" size={14} /></button>
              <button type="button" className="tbtn" title="水平居中" onClick={() => alignSelected("centerH")}><Icon name="alignCenterH" size={14} /></button>
              <button type="button" className="tbtn" title="右对齐" onClick={() => alignSelected("right")}><Icon name="alignRight" size={14} /></button>
              <button type="button" className="tbtn" title="顶对齐" onClick={() => alignSelected("top")}><Icon name="alignTop" size={14} /></button>
              <button type="button" className="tbtn" title="垂直居中" onClick={() => alignSelected("centerV")}><Icon name="alignCenterV" size={14} /></button>
              <button type="button" className="tbtn" title="底对齐" onClick={() => alignSelected("bottom")}><Icon name="alignBottom" size={14} /></button>
              <button type="button" className="tbtn" title="水平等距" onClick={() => alignSelected("distributeH")}><Icon name="distributeH" size={14} /></button>
              <button type="button" className="tbtn" title="垂直等距" onClick={() => alignSelected("distributeV")}><Icon name="distributeV" size={14} /></button>
            </>
          )}
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
              onNodesChange={handleNodesChange}
              onNodeDragStart={() => {
                /* 拖动开始时量一遍当前渲染尺寸，磁吸按真实卡片大小算 */
                if (snapEnabled)
                  dragSizesRef.current = measureSizes(nodesRef.current.map(node => node.id));

                dragSnapshotRef.current = snapshot();
              }}
              onNodeDragStop={() => {
                /* 一次拖动只记一步撤销 */
                if (dragSnapshotRef.current) {
                  history.remember(dragSnapshotRef.current);
                  dragSnapshotRef.current = null;
                }

                showGuides([]);
              }}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectStart={onConnectStart}
              onConnectEnd={onConnectEnd}
              /* 右键：节点上先把它选中再弹菜单，空白处直接弹 */
              onNodeContextMenu={(event, node) => {
                event.preventDefault();

                if (!node.selected)
                  setNodes(previous => previous.map(item =>
                    item.id === node.id ? { ...item, selected: true } : { ...item, selected: false }));

                openCanvasMenu();
              }}
              onPaneContextMenu={event => {
                event.preventDefault();
                openCanvasMenu();
              }}
              onSelectionChange={({ nodes: selectedNodes }) => setSelectedId(selectedNodes[0]?.id ?? null)}
              onEdgeDoubleClick={(event, edge) => {
                event.preventDefault();
                setEdges(previous => previous.filter(item => item.id !== edge.id));
              }}
              connectionLineType={ConnectionLineType.Bezier}
              connectionLineStyle={{ strokeWidth: 3 }}
              defaultEdgeOptions={{ type: "default", style: { strokeWidth: 3 } }}
              defaultViewport={tab.graph.viewport}
              fitView={!tab.graph.viewport}
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.2}
              maxZoom={1.8}
              deleteKeyCode={["Backspace", "Delete"]}
              proOptions={{ hideAttribution: true }}
              /* 空白处左键拖 = 框选；中键或 Cmd/Ctrl + 左键拖 = 平移 */
              selectionOnDrag
              panOnDrag={[1]}
              panActivationKeyCode={IS_MAC ? "Meta" : "Control"}
              selectionMode={SelectionMode.Full}
            >
              <Background gap={18} size={1.4} />
              <MiniMap pannable zoomable />
              <Controls />
            </ReactFlow>

            {/* 磁吸辅助线：按屏幕坐标铺在画布上，不参与命中 */}
            {guides.map((guide, index) => (
              <div
                key={`${guide.vertical ? "v" : "h"}-${index}`}
                className={`am-guide${guide.vertical ? " is-vertical" : " is-horizontal"}`}
                style={guideStyle(guide)}
              />
            ))}

            {connectMenu && (
              <ConnectMenu
                nodes={connectMenu.nodes}
                state={connectMenu.state}
                onPick={pickConnectNode}
                onClose={() => setConnectMenu(null)}
              />
            )}
          </div>

          <div className="am-side">
            <Inspector node={selected} onDelete={deleteNode} />
            <RunPanel run={run} />
          </div>
        </div>
      </div>

      {managerOpen && (
        <WorkflowManager
          current={name.trim() || tab.title}
          onClose={() => setManagerOpen(false)}
          onOpen={async target => {
            if (await confirmDiscard())
              await openWorkflow(target);
          }}
          onCreate={createWorkflow}
          onRenamed={(from, to) => {
            if ((name.trim() || tab.title) !== from)
              return;

            setName(to);
            onChangeRef.current({ file: to, title: to });
          }}
          onDeleted={target => {
            if ((name.trim() || tab.title) !== target)
              return;

            setName("");
            onChangeRef.current({ file: undefined, savedSignature: "" });
          }}
          onStatus={onStatus}
          onError={onError}
          askText={askText}
          askConfirm={askConfirm}
        />
      )}
    </AutomationContext.Provider>
  );
}

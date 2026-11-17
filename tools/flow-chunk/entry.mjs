// lib/client.flow.js 的入口：只导出画布需要的那几样，别把整个 @xyflow/react 都拖进来。
export {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  useNodesState,
  useEdgesState
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";

/**
 * 自动布局（省略坐标的节点用）：dagre 分层布局，返回 {id: {x, y}}（左上角坐标）。
 * nodes: [{id, w, h}]，edges: [{source, target}]；rankdir 默认 LR（左→右，与画布列一致）。
 */
export function layoutWithDagre(nodes, edges, options) {
  const g = new dagre.graphlib.Graph();
  const opts = options || {};
  g.setGraph({ rankdir: opts.rankdir || "LR", nodesep: opts.nodesep || 32, ranksep: opts.ranksep || 64, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes || []) g.setNode(String(node.id), { width: node.w || 200, height: node.h || 100 });
  for (const edge of edges || []) {
    if (g.hasNode(String(edge.source)) && g.hasNode(String(edge.target))) g.setEdge(String(edge.source), String(edge.target));
  }
  dagre.layout(g);
  const out = {};
  for (const id of g.nodes()) {
    const n = g.node(id);
    out[id] = { x: Math.round(n.x - n.width / 2), y: Math.round(n.y - n.height / 2) };
  }
  return out;
}

export { default as FLOW_CSS } from "@xyflow/react/dist/style.css";

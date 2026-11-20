// 重新规划 R2 之后，新画布（React Flow）是唯一的画布。画布页的测试以前跑在「经典舞台」上（测试环境没有按需 chunk，会自动降级到它），
// 现在必须显式提供一个假的 React Flow 库，让画布进入 ready 状态，再从传给 React Flow 的 nodes 里取出每张卡的元素来断言。
//
// 用法（保持原测试的结构，只换两处）：
//   const loaded = flowLoadPlugin(shim);                         // 代替 loadPlugin({ react: shim })
//   const canvas = await flowMount(mount, api, { t, projectId });  // 代替 mount(api.WbCanvasPage, {...})
//   canvas.tree      // = [画布页自己的树, ...每个画布节点的卡片元素]，collect / texts 直接用
//   canvas.rerender()// 重渲染并返回新的 tree
//   canvas.flow()    // 最近一次传给 ReactFlow 的 props（nodes / edges / onConnect …）
import { loadPlugin, render } from "./harness.mjs";

let lastCapture = null;

export function fakeFlowLib(capture) {
  return {
    ReactFlow: function ReactFlow(props) { capture.props = props; return { type: "div", props: { className: "rf", children: props.children } }; },
    Background: function () { return null; },
    Controls: function () { return null; },
    MiniMap: function () { return null; },
    Handle: function () { return null; },
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    applyNodeChanges: (changes, nodes) => nodes,
    layoutWithDagre: () => ({}),
    FLOW_CSS: ""
  };
}

/** 与 loadPlugin({ react }) 相同，但 requireAsync 给出假的 React Flow 库。返回值多一个 flowCapture。 */
export function flowLoadPlugin(shim, options) {
  const capture = { props: null };
  lastCapture = capture;
  const loaded = loadPlugin(Object.assign({ react: shim, requireAsync: () => Promise.resolve(fakeFlowLib(capture)) }, options || {}));
  loaded.flowCapture = capture;
  return loaded;
}

/** 挂载画布页并等它进入 ready，返回带「合并树」的包装。 */
export async function flowMount(mount, api, props, loaded) {
  const view = mount(api.WbCanvasPage, props);
  await view.settle(10);
  view.rerender();
  const capture = loaded && loaded.flowCapture ? loaded.flowCapture : lastCapture;
  const wrapper = {
    view,
    flow: () => (capture ? capture.props : null),
    get tree() {
      const flow = capture ? capture.props : null;
      // 节点卡片在真环境里由 React Flow 渲染；假库不渲染，所以这里用 harness 的 render 把函数组件（WbBtn / WbChip 等）展开成宿主元素，
      // 断言才能像以前在经典舞台上那样看到 button / span。带 hooks 的组件展开会抛——那种卡片保留原样。
      const expand = (el) => { try { return render(el); } catch (error) { return el; } };
      const els = flow && Array.isArray(flow.nodes) ? flow.nodes.map((node) => (node && node.data ? node.data.el : null)).filter(Boolean).map(expand) : [];
      return [view.tree].concat(els);
    },
    rerender() { view.rerender(); return wrapper.tree; },
    settle: (n) => view.settle(n)
  };
  return wrapper;
}

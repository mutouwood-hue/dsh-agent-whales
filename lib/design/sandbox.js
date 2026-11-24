/**
 * 沙箱 iframe 内的运行时 bootstrap（设计方案 §6.1 / §6.4，P0 结论见文档 §15）。
 *
 * 这份代码**以文本形式**注入 `srcdoc` 的沙箱 iframe（`sandbox="allow-scripts"`，无 `allow-same-origin`），
 * 所以：不同 ES 模块、不 import 任何东西、只用 ES2019 语法。
 *
 * 协议（P0 实测后的口径）：
 *   · 父 → 子：`init` / `render` / `renderBatch` / `pick-mode` / `measure`，全部带 `nonce`
 *   · 子 → 父：`booted` / `ready` / `rendered` / `pick` / `measured` / `error` / `navigate`，原样带回 `nonce`
 *   · **父页面校验 `event.origin === "null"` + nonce**，不用 `event.source`（实测不稳定）
 *
 * 三个 P0 踩过的坑（改动前先读）：
 *   1. `react/jsx-runtime` 必须暴露**原始函数**（不能箭头包装）—— sucrase 产物是 `_jsxruntime.jsx.call(void 0, ...)`，
 *      组件包是命名导入 `import { jsx, jsxs } from "react/jsx-runtime"`，两种都要能取到。
 *   2. `@cds` 对象要标 `__esModule` 且 `default` 指回自身，否则 sucrase 的 `_interopRequireDefault` 会包成 `{default: obj}`。
 *   3. `react/jsx-dev-runtime` 不需要（编译走 `production: true`）。
 */

/** 沙箱里允许 `require` 的模块名（其余一律抛错，这些是编译产物能写出来的）。 */
const RUNTIME_MODULES = ["react", "react/jsx-runtime", "react-dom", "react-dom/client"];

/**
 * 生成 iframe 的 bootstrap 源码。返回纯字符串，父页面拼进 `srcdoc`。
 * @param {{ csp: string, title?: string }} options
 */
export function sandboxBootstrap(options) {
	const opts = options || {};
	const csp = String(opts.csp || "default-src 'none'");
	const title = String(opts.title || "whales-design-sandbox");
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${title}</title>
<style>
html,body{margin:0;padding:0;background:#fff}
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#18181b}
#root{padding:0}
.wds-error{border:1px solid #dc2626;background:#fef2f2;color:#991b1b;border-radius:8px;padding:10px 12px;margin:8px;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.wds-pick *{cursor:crosshair !important}
.wds-pick-hover{outline:2px solid #2563eb !important;outline-offset:1px !important}
.wds-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#9ca3af;font-size:12px}
</style>
</head><body><div id="root"></div>
<script>${SANDBOX_RUNTIME_SOURCE}</script>
</body></html>`;
}

/** 沙箱运行时主体（作为字符串常量，避免被外层打包工具二次处理）。 */
const SANDBOX_RUNTIME_SOURCE = String.raw`
(function () {
  "use strict";
  var parentWin = window.parent;
  var nonce = "";
  var rootEl = document.getElementById("root");
  var state = {
    pack: null,
    packTable: null,
    components: {},   // name -> 编译产物导出的组件
    compiled: {},     // name -> 编译产物源码（需要时懒加载）
    mounts: {},       // mountId -> { root, options }
    consoleErrors: [],
    pickMode: false,
    pickTarget: null
  };

  function report(msg) {
    msg.nonce = nonce;
    try { parentWin.postMessage(msg, "*"); } catch (error) { /* 父页面不可达时只能静默 */ }
  }

  window.onerror = function (message, source, line, column) {
    report({ type: "error", phase: "onerror", message: String(message), line: line, column: column });
    return false;
  };
  window.addEventListener("unhandledrejection", function (event) {
    report({ type: "error", phase: "unhandledrejection", message: String(event.reason && event.reason.message || event.reason) });
  });
  var origError = console.error;
  console.error = function () {
    var parts = Array.prototype.slice.call(arguments).map(function (value) { return String(value); });
    state.consoleErrors.push(parts.join(" "));
    if (state.consoleErrors.length > 30) state.consoleErrors.shift();
    try { origError.apply(console, arguments); } catch (error) { /* 忽略 */ }
  };

  // ── 模块映射（P0 三条坑都在这里）────────────────────────────────────────
  function makeRequire(spec) {
    if (spec === "@cds") {
      if (!state.packTable) throw new Error("当前组件包没有 raw 导出：不能 import @cds");
      return state.packTable;
    }
    if (spec.indexOf("@project/") === 0) {
      var name = spec.slice("@project/".length);
      if (!state.components[name]) throw new Error("沙箱：@project/" + name + " 还没加载");
      return { __esModule: true, default: state.components[name] };
    }
    if (window.__whalesRequire) return window.__whalesRequire(spec);
    throw new Error("沙箱：没有运行时，无法加载模块 " + spec);
  }

  function defineCommonJs(code, name) {
    var module = { exports: {} };
    var fn = new Function("module", "exports", "require", code + "\n//# sourceURL=whales-design/" + String(name || "module") + ".js");
    fn(module, module.exports, makeRequire);
    return module.exports;
  }

  function exportOf(moduleExports, name) {
    // 必须是函数（组件）——拿到 React 元素对象会在 createElement 时报 React #31
    const candidates = [
      moduleExports && moduleExports.default,
      moduleExports && moduleExports[name],
      moduleExports
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "function") return candidate;
      // forwardRef / memo 结果是对象但有 $typeof，也是合法组件类型
      if (candidate && typeof candidate === "object" && candidate.$typeof) return candidate;
    }
    return null;
  }

  // ── 组件包：CommonJS，导出 { components, raw, rootClass(-ish) } ──────────
  function installPack(code) {
    var exported = defineCommonJs(code, "pack");
    state.pack = exported;
    // 包的形状两种都见得到：module.exports = { components, raw }（内置/本地 esbuild 产物），
    // 或 esbuild 加了 __esModule 后的 { default: {…}, … }。**先认自己身上的 raw**，再退回 default。
    var ns = exported;
    if (!(ns && ns.raw) && exported && exported.default && typeof exported.default === "object") {
      ns = Object.assign({}, exported.default, exported);
    }
    var rawNs = ns && ns.raw ? ns.raw : null;
    if (rawNs) {
      // 摊平成普通对象：sucrase 的 import { X } from "@cds" 会走 _interopRequireDefault，
      // 没有 __esModule 就被包成 {default: obj}，_cds.X 取不到。
      var table = {};
      Object.keys(rawNs).forEach(function (key) { table[key] = rawNs[key]; });
      table.__esModule = true;
      table.default = table;
      state.packTable = table;
    }
    return { rawCount: rawNs ? Object.keys(rawNs).length : 0 };
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────
  function ensureComponent(entry) {
    // entry: { name, code }  —— 编译产物已经是 CommonJS 形态
    if (state.components[entry.name]) return state.components[entry.name];
    var exported = defineCommonJs(entry.code, entry.name);
    var component = exportOf(exported, entry.name);
    if (typeof component !== "function") throw new Error("组件 " + entry.name + " 没有 export default 一个函数（或组件）");
    state.components[entry.name] = component;
    if (exported && exported.jsxTable) state.jsxTable = state.jsxTable || {};
    return component;
  }

  // 错误边界：渲染出错显示红框，不白屏
  function ErrorBox(props) {
    var React = window.__whalesRuntime.React;
    var bound = React.createElement("div", { className: "wds-error" }, props.message);
    return bound;
  }

  function renderInto(container, Component, props, label) {
    var runtime = window.__whalesRuntime;
    var React = runtime.React;
    var host = document.createElement("div");
    container.innerHTML = "";
    container.appendChild(host);
    var failed = null;
    // 错误边界：必须是**组件类型**（函数），不能把已创建的元素当类型传——
    // 那样会直接抛 React error #31（objects are not valid as a React child）。
    // 用类组件写边界，children 走 props（element 只作为 children 参与渲染，永远不当类型）。
    var Class = React.Component;
    function Boundary(p) { Class.call(this, p); this.state = { err: null }; }
    Boundary.prototype = Object.create(Class.prototype);
    Boundary.prototype.constructor = Boundary;
    Boundary.getDerivedStateFromError = function (error) { failed = error; return { err: error }; };
    Boundary.prototype.render = function () {
      if (this.state.err) return React.createElement("div", { className: "wds-error" }, "渲染出错：" + String(this.state.err && this.state.err.message || this.state.err));
      return this.props.children;
    };
    var element = null;
    try {
      element = React.createElement(Component, props || {});
    } catch (error) {
      failed = error;
    }
    try {
      var root = runtime.createRoot(host);
      root.render(failed
        ? React.createElement("div", { className: "wds-error" }, "渲染出错：" + String(failed && failed.message || failed))
        : React.createElement(Boundary, null, element));
      state.mounts[label] = { root: root, host: host };
    } catch (error) {
      failed = error;
      container.innerHTML = "";
      var box = document.createElement("div");
      box.className = "wds-error";
      box.textContent = "渲染出错：" + String(error && error.message || error);
      container.appendChild(box);
    }
    return { failed: failed };
  }

  function collectDomSummary(container) {
    var text = (container.textContent || "").replace(/\s+/g, " ").trim();
    var el = container.querySelector("*");
    var box = el ? el.getBoundingClientRect() : { width: 0, height: 0 };
    var tags = {};
    var all = container.querySelectorAll("*");
    for (var i = 0; i < all.length; i += 1) {
      var key = all[i].tagName.toLowerCase();
      tags[key] = (tags[key] || 0) + 1;
    }
    var sources = container.querySelectorAll("[data-wsrc]");
    var wsrcSeen = [];
    for (var j = 0; j < sources.length && wsrcSeen.length < 60; j += 1) wsrcSeen.push(sources[j].getAttribute("data-wsrc"));
    return {
      textLength: text.length,
      textSample: text.slice(0, 240),
      nodeCount: all.length,
      tags: tags,
      width: Math.round(box.width || 0),
      height: Math.round(box.height || 0),
      scrollHeight: Math.round(container.scrollHeight || 0),
      empty: text.length === 0,
      wsrcCount: sources.length,
      wsrc: wsrcSeen,
      buttons: container.querySelectorAll("button").length,
      inputs: container.querySelectorAll("input,textarea,select").length,
      tables: container.querySelectorAll("table").length
    };
  }

  function doRender(msg) {
    var started = performance.now();
    try {
      if (!window.__whalesRuntime) throw new Error("运行时还没就绪（缺 init）");
      if (msg.packChanged && msg.packCode) installPack(msg.packCode);
      if (Array.isArray(msg.dependencies)) msg.dependencies.forEach(function (dep) { ensureComponent(dep); });
      var Component = ensureComponent({ name: msg.name, code: msg.code });
      var slot = msg.mountId && msg.mountId !== "main" ? null : rootEl;
      if (msg.mountId && msg.mountId !== "main") {
        var mountHost = document.getElementById(msg.mountId) || (function () {
          var el = document.createElement("div");
          el.id = msg.mountId;
          document.body.appendChild(el);
          return el;
        })();
        slot = mountHost;
      }
      // 画板约定 Board({ navigate })（设计方案 §6.2）：注入 navigate 后，沙箱里点「下一步」就发 navigate 消息让父页面切预览。
      var props = msg.props || {};
      if (msg.isBoard) {
        props = Object.assign({}, props, {
          navigate: function (target) {
            report({ type: "navigate", runId: msg.runId, to: String(target || "").slice(0, 40) });
          }
        });
      }
      var result = renderInto(slot, Component, props, msg.mountId || "main");
      // 两帧后量 DOM（React 提交 + 布局稳定）
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var summary = collectDomSummary(slot);
          report(Object.assign({
            type: "rendered",
            runId: msg.runId,
            mountId: msg.mountId || "main",
            ok: !result.failed && !summary.empty,
            ms: Math.round(performance.now() - started),
            error: result.failed ? String(result.failed && result.failed.message || result.failed) : "",
            consoleErrors: state.consoleErrors.slice(-8)
          }, summary));
        });
      });
    } catch (error) {
      report({
        type: "rendered",
        runId: msg.runId,
        mountId: msg.mountId || "main",
        ok: false,
        ms: Math.round(performance.now() - started),
        error: String(error && error.message || error),
        stack: String(error && error.stack || "").slice(0, 600),
        consoleErrors: state.consoleErrors.slice(-8)
      });
    }
  }

  // ── 点选（评论钉 / P3 直接改）─────────────────────────────────────────
  //
  // 两级定位（P0 审计结论）：data-wsrc 只注入到**原生 DOM 元素**上；大写组件的 DOM
  // 由组件自己产出（CDS 里 274/282 个组件不 ...props 透传），所以点到一个没有 data-wsrc 的
  // 节点时，要**向上找最近的带 data-wsrc 的祖先**，再用「祖先内的 DOM 路径 + 祖先的 tag 序列」
  // 让父页面用静态表反推。父页面拿不到 DOM，所以这里把路径本身算好传出去。
  function domPathOf(el, root) {
    var path = [];
    var node = el;
    while (node && node !== root) {
      var parent = node.parentElement;
      if (!parent) break;
      var index = 0;
      for (var i = 0; i < parent.children.length; i += 1) {
        if (parent.children[i] === node) { index = i; break; }
        index = i + 1;
      }
      path.unshift({ tag: node.tagName.toLowerCase(), index: index });
      node = parent;
    }
    return path;
  }

  function pickOf(target) {
    var el = target;
    var anchor = null;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute("data-wsrc")) { anchor = el; break; }
      el = el.parentElement;
    }
    if (!anchor) {
      // 完全没有 data-wsrc（整个树都是组件产出的）：只能给「点击位置在页面里的层级路径」，
      // 父页面无法据此定位源码，如实回报「这颗子树没有源码锚点」。
      return {
        wsrc: "",
        anchored: false,
        tag: target && target.tagName ? target.tagName.toLowerCase() : "",
        text: target ? String(target.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) : "",
        hint: "这个位置所在的组件没有给 DOM 打源码锚点（组件内部结构），只能按「整块」提评论"
      };
    }
    var same = document.querySelectorAll('[data-wsrc="' + anchor.getAttribute("data-wsrc") + '"]');
    var nth = 0;
    for (var i = 0; i < same.length; i += 1) { if (same[i] === anchor) { nth = i; break; } }
    var box = anchor.getBoundingClientRect();
    // 从锚点往下到点击处的路径：父页面用它 + 静态表判断点的是锚点本身还是它内部某层
    var inner = target && target !== anchor ? domPathOf(target, anchor) : [];
    return {
      wsrc: anchor.getAttribute("data-wsrc"),
      anchored: true,
      tag: anchor.tagName.toLowerCase(),
      // 点的是锚点内部更深的一层时，把内层路径也带上（tag 序列可用于「组件级」定位）
      innerPath: inner,
      clickedTag: target && target.tagName ? target.tagName.toLowerCase() : "",
      nth: nth,
      count: same.length,
      text: (anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
      rect: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }
    };
  }

  function setPickMode(on) {
    state.pickMode = Boolean(on);
    document.body.classList.toggle("wds-pick", state.pickMode);
    if (!state.pickMode && state.pickTarget) {
      state.pickTarget.classList.remove("wds-pick-hover");
      state.pickTarget = null;
    }
  }

  document.addEventListener("mousemove", function (event) {
    if (!state.pickMode) return;
    var found = null;
    var node = event.target;
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute("data-wsrc")) { found = node; break; }
      node = node.parentElement;
    }
    if (found !== state.pickTarget) {
      if (state.pickTarget) state.pickTarget.classList.remove("wds-pick-hover");
      state.pickTarget = found;
      if (found) found.classList.add("wds-pick-hover");
    }
  }, true);

  document.addEventListener("click", function (event) {
    if (!state.pickMode) return;
    var hit = pickOf(event.target);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    report({ type: "pick", runId: state.currentRunId, pick: hit });
  }, true);

  // ── 消息分发 ────────────────────────────────────────────────────────────
  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.type === "init") nonce = String(data.nonce || "");
    if (data.type === "render" || data.type === "renderBatch") nonce = String(data.nonce || "");
    if (data.type === "pick-mode" || data.type === "measure") nonce = String(data.nonce || "");
    try {
      if (data.type === "init") {
        var t0 = performance.now();
        if (data.runtime) new Function(data.runtime + "\n//# sourceURL=whales-design/runtime.js")();
        var runtimeMs = Math.round(performance.now() - t0);
        if (data.styles) {
          var style = document.createElement("style");
          style.id = "whales-design-styles";
          style.textContent = String(data.styles);
          document.head.appendChild(style);
        }
        if (data.extraCss) {
          var extra = document.createElement("style");
          extra.id = "whales-design-extra";
          extra.textContent = String(data.extraCss);
          document.head.appendChild(extra);
        }
        var packInfo = data.packCode ? installPack(data.packCode) : { rawCount: 0 };
        report({
          type: "ready",
          info: {
            runtimeMs: runtimeMs,
            packMs: 0,
            rawCount: packInfo.rawCount,
            hasRuntime: Boolean(window.__whalesRuntime),
            jsxRuntimeOk: Boolean(window.__whalesRequire && typeof window.__whalesRequire("react/jsx-runtime").jsx === "function"),
            stylesApplied: Boolean(document.getElementById("whales-design-styles")),
            security: securityProbe()
          }
        });
        return;
      }
      if (data.type === "render") { state.currentRunId = data.runId; doRender(data); return; }
      if (data.type === "pick-mode") { setPickMode(data.enabled); report({ type: "pick-mode-ack", enabled: Boolean(data.enabled) }); return; }
      if (data.type === "measure") {
        var mount = state.mounts[data.mountId || "main"];
        var container = mount ? mount.host : rootEl;
        report({ type: "measured", runId: data.runId, mountId: data.mountId || "main", summary: collectDomSummary(container) });
        return;
      }
      if (data.type === "mounted") { return; }
    } catch (error) {
      report({ type: "error", phase: data.type, message: String(error && error.message || error), stack: String(error && error.stack || "").slice(0, 400) });
    }
  });

  function securityProbe() {
    var probe = {};
    try { probe.parentIsSelf = window.parent === window; } catch (error) { probe.parentIsSelf = "blocked"; }
    try { probe.parentTokenReadable = typeof parentWin.__whalesToken !== "undefined"; } catch (error) { probe.parentTokenReadable = "blocked"; }
    try { probe.parentDocReadable = Boolean(parentWin.document); } catch (error) { probe.parentDocReadable = "blocked"; }
    try { probe.parentStorageReadable = Boolean(parentWin.localStorage); } catch (error) { probe.parentStorageReadable = "blocked"; }
    return probe;
  }

  parentWin.postMessage({ type: "booted" }, "*");
})();
`;

/** 沙箱 CSP（P0 验证可用；`unsafe-eval` 必需）。 */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** 直接给出完整的 srcdoc（父页面塞给 iframe）。 */
export function sandboxSrcdoc(options) {
	return sandboxBootstrap(Object.assign({ csp: SANDBOX_CSP }, options || {}));
}

/** 供测试用：导出的原始运行时源码。 */
export function sandboxRuntimeSource() {
	return SANDBOX_RUNTIME_SOURCE;
}

export { RUNTIME_MODULES };

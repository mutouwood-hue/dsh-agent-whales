/* dsh-agent-whales · client.design.js —— 由 tools/flow-chunk/build-design.mjs 生成，勿手改。
 * 组件工坊：组件 / 画板节点的沙箱预览与在线画布登记。只在画布上出现这两种节点时按需加载。 */
window.__ModuleLoader__.load({ id: "dsh-agent-whales", chunk: "client.design.js", factory: function (require) {
var module = { exports: {} }; var exports = module.exports;
var Re=Object.create;var Y=Object.defineProperty;var Ie=Object.getOwnPropertyDescriptor;var Ne=Object.getOwnPropertyNames;var je=Object.getPrototypeOf,Te=Object.prototype.hasOwnProperty;var _e=(t,e)=>{for(var n in e)Y(t,n,{get:e[n],enumerable:!0})},ye=(t,e,n,a)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of Ne(e))!Te.call(t,i)&&i!==n&&Y(t,i,{get:()=>e[i],enumerable:!(a=Ie(e,i))||a.enumerable});return t};var Ae=(t,e,n)=>(n=t!=null?Re(je(t)):{},ye(e||!t||!t.__esModule?Y(n,"default",{value:t,enumerable:!0}):n,t)),Me=t=>ye(Y({},"__esModule",{value:!0}),t);var $e={};_e($e,{DESIGN_CSS:()=>Je,DesignArtboardNode:()=>ve,DesignChatPreview:()=>We,DesignComponentNode:()=>we,SANDBOX_CSP:()=>K,createSandboxHost:()=>oe,designNodeTypes:()=>Fe,invalidateEntity:()=>ue,loadCompiled:()=>re,loadEntity:()=>F,loadPackText:()=>ae,loadRuntimeText:()=>ne,openSourceEditor:()=>ze,sandboxSrcdoc:()=>Q,useDesignLive:()=>Ue});module.exports=Me($e);var r=Ae(require("react"),1);function Pe(t){let e=t||{},n=String(e.csp||"default-src 'none'"),a=Be(String(e.title||"whales-design-sandbox"));return`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${n}">
<title>${a}</title>
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
<script>${Oe}<\/script>
</body></html>`}var Oe=String.raw`
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
      // components[name] 现在是 { component, code }（见 ensureComponent 的缓存改造）
      return { __esModule: true, default: state.components[name].component };
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
      // forwardRef / memo 结果是对象但带 $$typeof，也是合法组件类型
      if (candidate && typeof candidate === "object" && candidate.$$typeof) return candidate;
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
    // 缓存要按「名字 + 代码」判（P2 审计 I3）：只按名字判会让编辑器里改完源码后仍然渲染旧组件。
    // 代码变了就重新求值（同一个名字的新旧两份不会互相污染，旧的自然被替换）。
    var cached = state.components[entry.name];
    if (cached && cached.code === entry.code) return cached.component;
    var exported = defineCommonJs(entry.code, entry.name);
    var component = exportOf(exported, entry.name);
    if (component === null) throw new Error("组件 " + entry.name + " 没有 export default 一个 React 组件");
    state.components[entry.name] = {
      component: component,
      code: entry.code,
      projectCss: typeof exported.__whalesProjectCss === "string" ? exported.__whalesProjectCss : "",
      css: typeof exported.css === "string" ? exported.css : ""
    };
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
      var styles = document.getElementById("whales-design-module-styles");
      if (!styles) {
        styles = document.createElement("style");
        styles.id = "whales-design-module-styles";
        document.head.appendChild(styles);
      }
      var entries = (msg.dependencies || []).map(function (dep) { return state.components[dep.name]; });
      entries.push(state.components[msg.name]);
      var projectStyles = entries.map(function (entry) { return entry.projectCss; }).filter(Boolean);
      var ownStyles = entries.map(function (entry) { return entry.css; }).filter(Boolean);
      styles.textContent = Array.from(new Set(projectStyles)).concat(ownStyles).join("\n");
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
`,K="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";function Q(t){return Pe(Object.assign({csp:K},t||{}))}function Be(t){let e={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"};return String(t).replace(/[&<>"]/g,n=>e[n])}var{useCallback:te,useEffect:X,useMemo:Le,useRef:le,useState:j}=r,L="/agent-whales/api",De=`var t=require("react/jsx-runtime"),d=(...e)=>e.filter(Boolean).join(" ");var i={default:"border-transparent bg-primary text-primary-foreground shadow",secondary:"border-transparent bg-secondary text-secondary-foreground",outline:"text-foreground",destructive:"border-transparent bg-destructive text-destructive-foreground shadow"},c={info:"bg-background text-foreground",success:"border-emerald-500/50 text-emerald-700 bg-emerald-50",warning:"border-amber-500/50 text-amber-800 bg-amber-50",error:"border-destructive/50 text-destructive bg-red-50"},o="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",x="text-sm font-medium leading-none";var m={default:"bg-primary text-primary-foreground shadow hover:bg-primary/90",primary:"bg-primary text-primary-foreground shadow hover:bg-primary/90",secondary:"bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",outline:"border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",ghost:"hover:bg-accent hover:text-accent-foreground",destructive:"bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"},g="rounded-lg border bg-background text-foreground shadow-sm",h=({className:e,children:r,header:a,footer:l,...n})=>(0,t.jsxs)("div",{className:d(g,e),...n,children:[a?(0,t.jsx)("div",{className:"flex flex-col gap-1 p-5 pb-2",children:a}):null,(0,t.jsx)("div",{className:"p-5",children:r}),l?(0,t.jsx)("div",{className:"flex items-center p-5 pt-0",children:l}):null]}),u={Button:({variant:e="default",className:r,children:a,...l})=>(0,t.jsx)("button",{type:"button",className:d("inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors",m[e]||m.default,r),...l,children:a}),Input:({className:e,...r})=>(0,t.jsx)("input",{className:d(o,e),...r}),Textarea:({className:e,rows:r=3,...a})=>(0,t.jsx)("textarea",{rows:r,className:d(o,"min-h-[72px] h-auto py-2",e),...a}),Select:({options:e,className:r,...a})=>{let l=(Array.isArray(e)?e:[]).map(n=>{let s=n&&n.value!==void 0?n.value:n,f=n&&n.label!==void 0?n.label:String(s);return{value:String(s),text:String(f)}});return(0,t.jsx)("select",{className:d(o,r),...a,children:l.map(n=>(0,t.jsx)("option",{value:n.value,children:n.text},n.value))})},Label:({className:e,children:r,...a})=>(0,t.jsx)("label",{className:d(x,e),...a,children:r}),Badge:({variant:e="default",className:r,children:a,...l})=>(0,t.jsx)("span",{className:d("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",i[e]||i.default,r),...l,children:a}),Card:h,CardHeader:({className:e,children:r})=>(0,t.jsx)("div",{className:d("flex flex-col gap-1 p-5 pb-2",e),children:r}),CardTitle:({className:e,children:r})=>(0,t.jsx)("div",{className:d("text-lg font-semibold leading-none tracking-tight",e),children:r}),CardDescription:({className:e,children:r})=>(0,t.jsx)("div",{className:d("text-sm text-muted-foreground",e),children:r}),CardContent:({className:e,children:r})=>(0,t.jsx)("div",{className:d("p-5",e),children:r}),Separator:({className:e})=>(0,t.jsx)("hr",{className:d("my-2 border-border",e)}),Alert:({tone:e="info",title:r,children:a,className:l})=>(0,t.jsxs)("div",{role:"alert",className:d("relative w-full rounded-lg border p-4 text-sm",c[e]||c.info,l),children:[r?(0,t.jsx)("div",{className:"mb-1 font-medium",children:r}):null,a?(0,t.jsx)("div",{children:a}):null]}),Table:({columns:e,rows:r,rowKey:a})=>(0,t.jsx)("div",{className:"w-full overflow-auto rounded-lg border",children:(0,t.jsxs)("table",{className:"w-full caption-bottom text-sm",children:[(0,t.jsx)("thead",{children:(0,t.jsx)("tr",{className:"border-b bg-muted/50",children:(e||[]).map(l=>(0,t.jsx)("th",{className:"h-10 px-3 text-left align-middle font-medium text-muted-foreground",children:l.header},l.key))})}),(0,t.jsx)("tbody",{children:(r||[]).map((l,n)=>(0,t.jsx)("tr",{className:"border-b transition-colors hover:bg-muted/50",children:(e||[]).map(s=>(0,t.jsx)("td",{className:"p-3 align-middle",children:typeof s.render=="function"?s.render(l):String(l[s.key]===void 0?"":l[s.key])},s.key))},typeof a=="function"?a(l,n):n))})]})}),Tabs:({items:e,value:r,onChange:a})=>(0,t.jsxs)("div",{className:"flex flex-col gap-3",children:[(0,t.jsx)("div",{className:"flex gap-1 border-b",children:(e||[]).map(l=>(0,t.jsx)("button",{type:"button",onClick:()=>{typeof a=="function"&&a(l.key)},className:d("px-3 py-2 text-sm font-medium",l.key===r?"border-b-2 border-primary text-foreground":"text-muted-foreground hover:text-foreground"),children:l.label},l.key))}),(0,t.jsx)("div",{children:(e||[]).filter(l=>l.key===r).map(l=>(0,t.jsx)("div",{children:l.content},l.key))})]}),Switch:({checked:e,onChange:r,className:a})=>(0,t.jsx)("button",{type:"button",role:"switch","aria-checked":!!e,onClick:()=>{typeof r=="function"&&r(!e)},className:d("relative inline-flex h-5 w-9 items-center rounded-full transition-colors",e?"bg-primary":"bg-input",a),children:(0,t.jsx)("span",{className:d("block size-4 rounded-full bg-background shadow transition-transform",e?"translate-x-4":"translate-x-0.5")})}),Checkbox:({checked:e,onChange:r,className:a,...l})=>(0,t.jsx)("input",{type:"checkbox",checked:!!e,onChange:n=>{typeof r=="function"&&r(n.target.checked)},className:d("size-4 rounded border-input accent-primary",a),...l}),EmptyState:({title:e="\\u8FD8\\u6CA1\\u6709\\u6570\\u636E",hint:r,className:a})=>(0,t.jsxs)("div",{className:d("flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-8 text-center",a),children:[(0,t.jsx)("div",{className:"text-sm font-medium text-foreground",children:e}),r?(0,t.jsx)("div",{className:"text-xs text-muted-foreground",children:r}):null]}),Progress:({value:e=0,className:r})=>(0,t.jsx)("div",{className:d("h-2 w-full overflow-hidden rounded-full bg-muted",r),children:(0,t.jsx)("div",{className:"h-full bg-primary transition-all",style:{width:Math.max(0,Math.min(100,Number(e)||0))+"%"}})}),Avatar:({name:e="",className:r})=>(0,t.jsx)("span",{className:d("inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground",r),children:String(e).trim().slice(0,1)||"?"}),Title:({level:e=2,className:r,children:a})=>(0,t.jsx)("h"+(Number(e)>=1&&Number(e)<=6?e:2),{className:d("font-semibold tracking-tight",r),children:a}),Text:({tone:e="default",className:r,children:a})=>(0,t.jsx)("p",{className:d("text-sm leading-7",e==="muted"?"text-muted-foreground":"text-foreground",r),children:a}),Stack:({gap:e=3,className:r,children:a})=>(0,t.jsx)("div",{className:d("flex flex-col",e===1?"gap-1":e===2?"gap-2":e===4?"gap-4":"gap-3",r),children:a}),Row:({gap:e=2,className:r,children:a})=>(0,t.jsx)("div",{className:d("flex flex-row items-center",e===1?"gap-1":e===3?"gap-3":e===4?"gap-4":"gap-2",r),children:a})};module.exports=u;
`,He=`*, ::before, ::after {
  --tw-border-spacing-x: 0;
  --tw-border-spacing-y: 0;
  --tw-translate-x: 0;
  --tw-translate-y: 0;
  --tw-rotate: 0;
  --tw-skew-x: 0;
  --tw-skew-y: 0;
  --tw-scale-x: 1;
  --tw-scale-y: 1;
  --tw-pan-x:  ;
  --tw-pan-y:  ;
  --tw-pinch-zoom:  ;
  --tw-scroll-snap-strictness: proximity;
  --tw-gradient-from-position:  ;
  --tw-gradient-via-position:  ;
  --tw-gradient-to-position:  ;
  --tw-ordinal:  ;
  --tw-slashed-zero:  ;
  --tw-numeric-figure:  ;
  --tw-numeric-spacing:  ;
  --tw-numeric-fraction:  ;
  --tw-ring-inset:  ;
  --tw-ring-offset-width: 0px;
  --tw-ring-offset-color: #fff;
  --tw-ring-color: rgb(59 130 246 / 0.5);
  --tw-ring-offset-shadow: 0 0 #0000;
  --tw-ring-shadow: 0 0 #0000;
  --tw-shadow: 0 0 #0000;
  --tw-shadow-colored: 0 0 #0000;
  --tw-blur:  ;
  --tw-brightness:  ;
  --tw-contrast:  ;
  --tw-grayscale:  ;
  --tw-hue-rotate:  ;
  --tw-invert:  ;
  --tw-saturate:  ;
  --tw-sepia:  ;
  --tw-drop-shadow:  ;
  --tw-backdrop-blur:  ;
  --tw-backdrop-brightness:  ;
  --tw-backdrop-contrast:  ;
  --tw-backdrop-grayscale:  ;
  --tw-backdrop-hue-rotate:  ;
  --tw-backdrop-invert:  ;
  --tw-backdrop-opacity:  ;
  --tw-backdrop-saturate:  ;
  --tw-backdrop-sepia:  ;
  --tw-contain-size:  ;
  --tw-contain-layout:  ;
  --tw-contain-paint:  ;
  --tw-contain-style:  ;
}

::backdrop {
  --tw-border-spacing-x: 0;
  --tw-border-spacing-y: 0;
  --tw-translate-x: 0;
  --tw-translate-y: 0;
  --tw-rotate: 0;
  --tw-skew-x: 0;
  --tw-skew-y: 0;
  --tw-scale-x: 1;
  --tw-scale-y: 1;
  --tw-pan-x:  ;
  --tw-pan-y:  ;
  --tw-pinch-zoom:  ;
  --tw-scroll-snap-strictness: proximity;
  --tw-gradient-from-position:  ;
  --tw-gradient-via-position:  ;
  --tw-gradient-to-position:  ;
  --tw-ordinal:  ;
  --tw-slashed-zero:  ;
  --tw-numeric-figure:  ;
  --tw-numeric-spacing:  ;
  --tw-numeric-fraction:  ;
  --tw-ring-inset:  ;
  --tw-ring-offset-width: 0px;
  --tw-ring-offset-color: #fff;
  --tw-ring-color: rgb(59 130 246 / 0.5);
  --tw-ring-offset-shadow: 0 0 #0000;
  --tw-ring-shadow: 0 0 #0000;
  --tw-shadow: 0 0 #0000;
  --tw-shadow-colored: 0 0 #0000;
  --tw-blur:  ;
  --tw-brightness:  ;
  --tw-contrast:  ;
  --tw-grayscale:  ;
  --tw-hue-rotate:  ;
  --tw-invert:  ;
  --tw-saturate:  ;
  --tw-sepia:  ;
  --tw-drop-shadow:  ;
  --tw-backdrop-blur:  ;
  --tw-backdrop-brightness:  ;
  --tw-backdrop-contrast:  ;
  --tw-backdrop-grayscale:  ;
  --tw-backdrop-hue-rotate:  ;
  --tw-backdrop-invert:  ;
  --tw-backdrop-opacity:  ;
  --tw-backdrop-saturate:  ;
  --tw-backdrop-sepia:  ;
  --tw-contain-size:  ;
  --tw-contain-layout:  ;
  --tw-contain-paint:  ;
  --tw-contain-style:  ;
}/*
! tailwindcss v3.4.19 | MIT License | https://tailwindcss.com
*//*
1. Prevent padding and border from affecting element width. (https://github.com/mozdevs/cssremedy/issues/4)
2. Allow adding a border to an element by just adding a border-width. (https://github.com/tailwindcss/tailwindcss/pull/116)
*/

*,
::before,
::after {
  box-sizing: border-box; /* 1 */
  border-width: 0; /* 2 */
  border-style: solid; /* 2 */
  border-color: #e5e7eb; /* 2 */
}

::before,
::after {
  --tw-content: '';
}

/*
1. Use a consistent sensible line-height in all browsers.
2. Prevent adjustments of font size after orientation changes in iOS.
3. Use a more readable tab size.
4. Use the user's configured \`sans\` font-family by default.
5. Use the user's configured \`sans\` font-feature-settings by default.
6. Use the user's configured \`sans\` font-variation-settings by default.
7. Disable tap highlights on iOS
*/

html,
:host {
  line-height: 1.5; /* 1 */
  -webkit-text-size-adjust: 100%; /* 2 */
  -moz-tab-size: 4; /* 3 */
  tab-size: 4; /* 3 */
  font-family: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"; /* 4 */
  font-feature-settings: normal; /* 5 */
  font-variation-settings: normal; /* 6 */
  -webkit-tap-highlight-color: transparent; /* 7 */
}

/*
1. Remove the margin in all browsers.
2. Inherit line-height from \`html\` so users can set them as a class directly on the \`html\` element.
*/

body {
  margin: 0; /* 1 */
  line-height: inherit; /* 2 */
}

/*
1. Add the correct height in Firefox.
2. Correct the inheritance of border color in Firefox. (https://bugzilla.mozilla.org/show_bug.cgi?id=190655)
3. Ensure horizontal rules are visible by default.
*/

hr {
  height: 0; /* 1 */
  color: inherit; /* 2 */
  border-top-width: 1px; /* 3 */
}

/*
Add the correct text decoration in Chrome, Edge, and Safari.
*/

abbr:where([title]) {
  text-decoration: underline dotted;
}

/*
Remove the default font size and weight for headings.
*/

h1,
h2,
h3,
h4,
h5,
h6 {
  font-size: inherit;
  font-weight: inherit;
}

/*
Reset links to optimize for opt-in styling instead of opt-out.
*/

a {
  color: inherit;
  text-decoration: inherit;
}

/*
Add the correct font weight in Edge and Safari.
*/

b,
strong {
  font-weight: bolder;
}

/*
1. Use the user's configured \`mono\` font-family by default.
2. Use the user's configured \`mono\` font-feature-settings by default.
3. Use the user's configured \`mono\` font-variation-settings by default.
4. Correct the odd \`em\` font sizing in all browsers.
*/

code,
kbd,
samp,
pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; /* 1 */
  font-feature-settings: normal; /* 2 */
  font-variation-settings: normal; /* 3 */
  font-size: 1em; /* 4 */
}

/*
Add the correct font size in all browsers.
*/

small {
  font-size: 80%;
}

/*
Prevent \`sub\` and \`sup\` elements from affecting the line height in all browsers.
*/

sub,
sup {
  font-size: 75%;
  line-height: 0;
  position: relative;
  vertical-align: baseline;
}

sub {
  bottom: -0.25em;
}

sup {
  top: -0.5em;
}

/*
1. Remove text indentation from table contents in Chrome and Safari. (https://bugs.chromium.org/p/chromium/issues/detail?id=999088, https://bugs.webkit.org/show_bug.cgi?id=201297)
2. Correct table border color inheritance in all Chrome and Safari. (https://bugs.chromium.org/p/chromium/issues/detail?id=935729, https://bugs.webkit.org/show_bug.cgi?id=195016)
3. Remove gaps between table borders by default.
*/

table {
  text-indent: 0; /* 1 */
  border-color: inherit; /* 2 */
  border-collapse: collapse; /* 3 */
}

/*
1. Change the font styles in all browsers.
2. Remove the margin in Firefox and Safari.
3. Remove default padding in all browsers.
*/

button,
input,
optgroup,
select,
textarea {
  font-family: inherit; /* 1 */
  font-feature-settings: inherit; /* 1 */
  font-variation-settings: inherit; /* 1 */
  font-size: 100%; /* 1 */
  font-weight: inherit; /* 1 */
  line-height: inherit; /* 1 */
  letter-spacing: inherit; /* 1 */
  color: inherit; /* 1 */
  margin: 0; /* 2 */
  padding: 0; /* 3 */
}

/*
Remove the inheritance of text transform in Edge and Firefox.
*/

button,
select {
  text-transform: none;
}

/*
1. Correct the inability to style clickable types in iOS and Safari.
2. Remove default button styles.
*/

button,
input:where([type='button']),
input:where([type='reset']),
input:where([type='submit']) {
  -webkit-appearance: button; /* 1 */
  background-color: transparent; /* 2 */
  background-image: none; /* 2 */
}

/*
Use the modern Firefox focus style for all focusable elements.
*/

:-moz-focusring {
  outline: auto;
}

/*
Remove the additional \`:invalid\` styles in Firefox. (https://github.com/mozilla/gecko-dev/blob/2f9eacd9d3d995c937b4251a5557d95d494c9be1/layout/style/res/forms.css#L728-L737)
*/

:-moz-ui-invalid {
  box-shadow: none;
}

/*
Add the correct vertical alignment in Chrome and Firefox.
*/

progress {
  vertical-align: baseline;
}

/*
Correct the cursor style of increment and decrement buttons in Safari.
*/

::-webkit-inner-spin-button,
::-webkit-outer-spin-button {
  height: auto;
}

/*
1. Correct the odd appearance in Chrome and Safari.
2. Correct the outline style in Safari.
*/

[type='search'] {
  -webkit-appearance: textfield; /* 1 */
  outline-offset: -2px; /* 2 */
}

/*
Remove the inner padding in Chrome and Safari on macOS.
*/

::-webkit-search-decoration {
  -webkit-appearance: none;
}

/*
1. Correct the inability to style clickable types in iOS and Safari.
2. Change font properties to \`inherit\` in Safari.
*/

::-webkit-file-upload-button {
  -webkit-appearance: button; /* 1 */
  font: inherit; /* 2 */
}

/*
Add the correct display in Chrome and Safari.
*/

summary {
  display: list-item;
}

/*
Removes the default spacing and border for appropriate elements.
*/

blockquote,
dl,
dd,
h1,
h2,
h3,
h4,
h5,
h6,
hr,
figure,
p,
pre {
  margin: 0;
}

fieldset {
  margin: 0;
  padding: 0;
}

legend {
  padding: 0;
}

ol,
ul,
menu {
  list-style: none;
  margin: 0;
  padding: 0;
}

/*
Reset default styling for dialogs.
*/
dialog {
  padding: 0;
}

/*
Prevent resizing textareas horizontally by default.
*/

textarea {
  resize: vertical;
}

/*
1. Reset the default placeholder opacity in Firefox. (https://github.com/tailwindlabs/tailwindcss/issues/3300)
2. Set the default placeholder color to the user's configured gray 400 color.
*/

input::placeholder,
textarea::placeholder {
  opacity: 1; /* 1 */
  color: #9ca3af; /* 2 */
}

/*
Set the default cursor for buttons.
*/

button,
[role="button"] {
  cursor: pointer;
}

/*
Make sure disabled buttons don't get the pointer cursor.
*/
:disabled {
  cursor: default;
}

/*
1. Make replaced elements \`display: block\` by default. (https://github.com/mozdevs/cssremedy/issues/14)
2. Add \`vertical-align: middle\` to align replaced elements more sensibly by default. (https://github.com/jensimmons/cssremedy/issues/14#issuecomment-634934210)
   This can trigger a poorly considered lint error in some tools but is included by design.
*/

img,
svg,
video,
canvas,
audio,
iframe,
embed,
object {
  display: block; /* 1 */
  vertical-align: middle; /* 2 */
}

/*
Constrain images and videos to the parent width and preserve their intrinsic aspect ratio. (https://github.com/mozdevs/cssremedy/issues/14)
*/

img,
video {
  max-width: 100%;
  height: auto;
}

/* Make elements with the HTML hidden attribute stay hidden by default */
[hidden]:where(:not([hidden="until-found"])) {
  display: none;
}
	:root {
		--background: 0 0% 100%;
		--foreground: 240 10% 3.9%;
		--card: 0 0% 100%;
		--card-foreground: 240 10% 3.9%;
		--primary: 240 5.9% 10%;
		--primary-foreground: 0 0% 98%;
		--secondary: 240 4.8% 95.9%;
		--secondary-foreground: 240 5.9% 10%;
		--muted: 240 4.8% 95.9%;
		--muted-foreground: 240 3.8% 46.1%;
		--accent: 240 4.8% 95.9%;
		--accent-foreground: 240 5.9% 10%;
		--destructive: 0 84.2% 60.2%;
		--destructive-foreground: 0 0% 98%;
		--border: 240 5.9% 90%;
		--input: 240 5.9% 90%;
		--ring: 240 10% 3.9%;
		--radius: 0.5rem;
	}
	* {
  border-color: hsl(var(--border));
}
	body {
  background-color: hsl(var(--background));
  color: hsl(var(--foreground)); font-family: "Inter", "Noto Sans SC", system-ui, -apple-system, sans-serif;
}
.relative {
  position: relative;
}
.mx-auto {
  margin-left: auto;
  margin-right: auto;
}
.my-2 {
  margin-top: 0.5rem;
  margin-bottom: 0.5rem;
}
.mb-1 {
  margin-bottom: 0.25rem;
}
.mt-1 {
  margin-top: 0.25rem;
}
.block {
  display: block;
}
.inline-block {
  display: inline-block;
}
.flex {
  display: flex;
}
.inline-flex {
  display: inline-flex;
}
.table {
  display: table;
}
.grid {
  display: grid;
}
.size-4 {
  width: 1rem;
  height: 1rem;
}
.size-8 {
  width: 2rem;
  height: 2rem;
}
.h-10 {
  height: 2.5rem;
}
.h-12 {
  height: 3rem;
}
.h-2 {
  height: 0.5rem;
}
.h-2\\.5 {
  height: 0.625rem;
}
.h-4 {
  height: 1rem;
}
.h-5 {
  height: 1.25rem;
}
.h-9 {
  height: 2.25rem;
}
.h-auto {
  height: auto;
}
.h-full {
  height: 100%;
}
.h-px {
  height: 1px;
}
.min-h-\\[72px\\] {
  min-height: 72px;
}
.min-h-full {
  min-height: 100%;
}
.w-16 {
  width: 4rem;
}
.w-4 {
  width: 1rem;
}
.w-48 {
  width: 12rem;
}
.w-9 {
  width: 2.25rem;
}
.w-full {
  width: 100%;
}
.max-w-lg {
  max-width: 32rem;
}
.shrink-0 {
  flex-shrink: 0;
}
.caption-bottom {
  caption-side: bottom;
}
.translate-x-0 {
  --tw-translate-x: 0px;
  transform: translate(var(--tw-translate-x), var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y));
}
.translate-x-0\\.5 {
  --tw-translate-x: 0.125rem;
  transform: translate(var(--tw-translate-x), var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y));
}
.translate-x-4 {
  --tw-translate-x: 1rem;
  transform: translate(var(--tw-translate-x), var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y));
}
.grid-cols-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.flex-row {
  flex-direction: row;
}
.flex-col {
  flex-direction: column;
}
.items-center {
  align-items: center;
}
.justify-end {
  justify-content: flex-end;
}
.justify-center {
  justify-content: center;
}
.justify-between {
  justify-content: space-between;
}
.gap-1 {
  gap: 0.25rem;
}
.gap-1\\.5 {
  gap: 0.375rem;
}
.gap-2 {
  gap: 0.5rem;
}
.gap-3 {
  gap: 0.75rem;
}
.gap-4 {
  gap: 1rem;
}
.gap-6 {
  gap: 1.5rem;
}
.space-y-1\\.5 > :not([hidden]) ~ :not([hidden]) {
  --tw-space-y-reverse: 0;
  margin-top: calc(0.375rem * calc(1 - var(--tw-space-y-reverse)));
  margin-bottom: calc(0.375rem * var(--tw-space-y-reverse));
}
.overflow-auto {
  overflow: auto;
}
.overflow-hidden {
  overflow: hidden;
}
.whitespace-nowrap {
  white-space: nowrap;
}
.rounded {
  border-radius: 0.25rem;
}
.rounded-full {
  border-radius: 9999px;
}
.rounded-lg {
  border-radius: var(--radius);
}
.rounded-md {
  border-radius: calc(var(--radius) - 2px);
}
.rounded-sm {
  border-radius: calc(var(--radius) - 4px);
}
.rounded-xl {
  border-radius: 0.75rem;
}
.border {
  border-width: 1px;
}
.border-2 {
  border-width: 2px;
}
.border-b {
  border-bottom-width: 1px;
}
.border-b-2 {
  border-bottom-width: 2px;
}
.border-r {
  border-right-width: 1px;
}
.border-dashed {
  border-style: dashed;
}
.border-amber-500\\/50 {
  border-color: rgb(245 158 11 / 0.5);
}
.border-border {
  border-color: hsl(var(--border));
}
.border-destructive\\/50 {
  border-color: hsl(var(--destructive) / 0.5);
}
.border-emerald-500\\/50 {
  border-color: rgb(16 185 129 / 0.5);
}
.border-input {
  border-color: hsl(var(--input));
}
.border-primary {
  border-color: hsl(var(--primary));
}
.border-transparent {
  border-color: transparent;
}
.bg-accent {
  background-color: hsl(var(--accent));
}
.bg-amber-50 {
  --tw-bg-opacity: 1;
  background-color: rgb(255 251 235 / var(--tw-bg-opacity, 1));
}
.bg-background {
  background-color: hsl(var(--background));
}
.bg-border {
  background-color: hsl(var(--border));
}
.bg-card {
  background-color: hsl(var(--card));
}
.bg-destructive {
  background-color: hsl(var(--destructive));
}
.bg-emerald-50 {
  --tw-bg-opacity: 1;
  background-color: rgb(236 253 245 / var(--tw-bg-opacity, 1));
}
.bg-input {
  background-color: hsl(var(--input));
}
.bg-muted {
  background-color: hsl(var(--muted));
}
.bg-muted\\/40 {
  background-color: hsl(var(--muted) / 0.4);
}
.bg-muted\\/50 {
  background-color: hsl(var(--muted) / 0.5);
}
.bg-primary {
  background-color: hsl(var(--primary));
}
.bg-red-50 {
  --tw-bg-opacity: 1;
  background-color: rgb(254 242 242 / var(--tw-bg-opacity, 1));
}
.bg-secondary {
  background-color: hsl(var(--secondary));
}
.bg-transparent {
  background-color: transparent;
}
.p-1 {
  padding: 0.25rem;
}
.p-2 {
  padding: 0.5rem;
}
.p-3 {
  padding: 0.75rem;
}
.p-4 {
  padding: 1rem;
}
.p-5 {
  padding: 1.25rem;
}
.p-6 {
  padding: 1.5rem;
}
.p-8 {
  padding: 2rem;
}
.px-2\\.5 {
  padding-left: 0.625rem;
  padding-right: 0.625rem;
}
.px-3 {
  padding-left: 0.75rem;
  padding-right: 0.75rem;
}
.px-4 {
  padding-left: 1rem;
  padding-right: 1rem;
}
.py-0\\.5 {
  padding-top: 0.125rem;
  padding-bottom: 0.125rem;
}
.py-1 {
  padding-top: 0.25rem;
  padding-bottom: 0.25rem;
}
.py-2 {
  padding-top: 0.5rem;
  padding-bottom: 0.5rem;
}
.py-3 {
  padding-top: 0.75rem;
  padding-bottom: 0.75rem;
}
.py-6 {
  padding-top: 1.5rem;
  padding-bottom: 1.5rem;
}
.pb-2 {
  padding-bottom: 0.5rem;
}
.pt-0 {
  padding-top: 0px;
}
.text-left {
  text-align: left;
}
.text-center {
  text-align: center;
}
.align-middle {
  vertical-align: middle;
}
.text-2xl {
  font-size: 1.5rem;
  line-height: 2rem;
}
.text-3xl {
  font-size: 1.875rem;
  line-height: 2.25rem;
}
.text-\\[10px\\] {
  font-size: 10px;
}
.text-base {
  font-size: 1rem;
  line-height: 1.5rem;
}
.text-lg {
  font-size: 1.125rem;
  line-height: 1.75rem;
}
.text-sm {
  font-size: 0.875rem;
  line-height: 1.25rem;
}
.text-xs {
  font-size: 0.75rem;
  line-height: 1rem;
}
.font-bold {
  font-weight: 700;
}
.font-medium {
  font-weight: 500;
}
.font-semibold {
  font-weight: 600;
}
.leading-7 {
  line-height: 1.75rem;
}
.leading-none {
  line-height: 1;
}
.tracking-tight {
  letter-spacing: -0.025em;
}
.text-accent-foreground {
  color: hsl(var(--accent-foreground));
}
.text-amber-800 {
  --tw-text-opacity: 1;
  color: rgb(146 64 14 / var(--tw-text-opacity, 1));
}
.text-card-foreground {
  color: hsl(var(--card-foreground));
}
.text-destructive {
  color: hsl(var(--destructive));
}
.text-destructive-foreground {
  color: hsl(var(--destructive-foreground));
}
.text-emerald-700 {
  --tw-text-opacity: 1;
  color: rgb(4 120 87 / var(--tw-text-opacity, 1));
}
.text-foreground {
  color: hsl(var(--foreground));
}
.text-muted-foreground {
  color: hsl(var(--muted-foreground));
}
.text-primary-foreground {
  color: hsl(var(--primary-foreground));
}
.text-secondary-foreground {
  color: hsl(var(--secondary-foreground));
}
.antialiased {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.accent-primary {
  accent-color: hsl(var(--primary));
}
.opacity-90 {
  opacity: 0.9;
}
.shadow {
  --tw-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  --tw-shadow-colored: 0 1px 3px 0 var(--tw-shadow-color), 0 1px 2px -1px var(--tw-shadow-color);
  box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow);
}
.shadow-lg {
  --tw-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  --tw-shadow-colored: 0 10px 15px -3px var(--tw-shadow-color), 0 4px 6px -4px var(--tw-shadow-color);
  box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow);
}
.shadow-sm {
  --tw-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --tw-shadow-colored: 0 1px 2px 0 var(--tw-shadow-color);
  box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow);
}
.outline {
  outline-style: solid;
}
.filter {
  filter: var(--tw-blur) var(--tw-brightness) var(--tw-contrast) var(--tw-grayscale) var(--tw-hue-rotate) var(--tw-invert) var(--tw-saturate) var(--tw-sepia) var(--tw-drop-shadow);
}
.transition-all {
  transition-property: all;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}
.transition-colors {
  transition-property: color, background-color, border-color, text-decoration-color, fill, stroke;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}
.transition-transform {
  transition-property: transform;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}

/* shadcn/ui \xB7 new-york \xB7 zinc\uFF08\u6D45\u8272\uFF09\u3002\u53EA\u5728\u539F\u578B iframe \u91CC\u751F\u6548\uFF0C\u4E0D\u4F1A\u6C61\u67D3 DSH \u9875\u9762\u3002 */

.placeholder\\:text-muted-foreground::placeholder {
  color: hsl(var(--muted-foreground));
}

.last\\:border-0:last-child {
  border-width: 0px;
}

.hover\\:bg-accent:hover {
  background-color: hsl(var(--accent));
}

.hover\\:bg-destructive\\/90:hover {
  background-color: hsl(var(--destructive) / 0.9);
}

.hover\\:bg-muted\\/50:hover {
  background-color: hsl(var(--muted) / 0.5);
}

.hover\\:bg-primary\\/90:hover {
  background-color: hsl(var(--primary) / 0.9);
}

.hover\\:bg-secondary\\/80:hover {
  background-color: hsl(var(--secondary) / 0.8);
}

.hover\\:text-accent-foreground:hover {
  color: hsl(var(--accent-foreground));
}

.hover\\:text-foreground:hover {
  color: hsl(var(--foreground));
}

.focus-visible\\:outline-none:focus-visible {
  outline: 2px solid transparent;
  outline-offset: 2px;
}

.focus-visible\\:ring-1:focus-visible {
  --tw-ring-offset-shadow: var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);
  --tw-ring-shadow: var(--tw-ring-inset) 0 0 0 calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color);
  box-shadow: var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow, 0 0 #0000);
}

.focus-visible\\:ring-ring:focus-visible {
  --tw-ring-color: hsl(var(--ring));
}
`,Z=new Map,ee=new Map;function ne(){let t="runtime";if(Z.has(t))return Z.get(t);let e=fetch(L+"/design/runtime.js").then(n=>{if(!n.ok)throw new Error("\u8FD0\u884C\u65F6\u4E0B\u8F7D\u5931\u8D25 "+n.status);return n.text()});return Z.set(t,e),e.catch(()=>Z.delete(t)),e}function ae(t){let e=typeof t=="string"&&t!==""?t:"shadcn";if(ee.has(e))return ee.get(e);let n=L+"/component-packs/"+encodeURIComponent(e),a=(async()=>{if(e==="shadcn")return{bundle:De,styles:He,api:null,builtin:!0};let[i,h]=await Promise.all([fetch(n+"/bundle.js").then(u=>u.ok?u.text():""),fetch(n+"/styles.css").then(u=>u.ok?u.text():"",()=>"")]),s=null;try{s=await(await fetch(L+"/design/pack-api?packId="+encodeURIComponent(e))).json()}catch{s=null}return{bundle:i,styles:h,api:s,builtin:!1}})();return ee.set(e,a),a.catch(()=>ee.delete(e)),a}var be=0;function de(){be+=1;let t=new Uint8Array(16);if(typeof crypto!="undefined"&&typeof crypto.getRandomValues=="function")crypto.getRandomValues(t);else for(let e=0;e<t.length;e+=1)t[e]=Math.floor(Math.random()*256);return Array.from(t,e=>e.toString(16).padStart(2,"0")).join("")+"-"+be}function oe(t,e){let n=e||{},a="",i=!1,h=[],s=null,u=!1,l=y=>{if(y.origin!=="null")return;let o=y.data||{};if(o.type==="booted"){u=!0;return}if(o.nonce===a){if(o.type==="ready"){i=!0;let m=h.splice(0);for(let w of m)w(o.info||{});return}if(o.type==="rendered"){if(s!==null){let m=s;s=null,m(o)}return}if(o.type==="pick"){typeof n.onPick=="function"&&n.onPick(o.pick);return}if(o.type==="navigate"){typeof n.onNavigate=="function"&&n.onNavigate(o.to);return}o.type==="error"&&typeof n.onError=="function"&&n.onError(o)}};window.addEventListener("message",l),t.setAttribute("sandbox","allow-scripts"),t.setAttribute("srcdoc",Q({csp:K,title:n.title||"whales-design"}));function f(y){if(a=de(),!u){let o=Date.now();return new Promise(m=>{let w=()=>{if(u||Date.now()-o>6e3){m();return}setTimeout(w,60)};w()}).then(()=>p(y))}return p(y)}function p(y){return new Promise(o=>{h.push(o),t.contentWindow.postMessage({type:"init",nonce:a,runtime:y.runtime,styles:y.styles,packCode:y.bundle},"*"),setTimeout(()=>{i||o({timeout:!0})},8e3)})}function k(y){if(!i)return Promise.resolve({ok:!1,error:"\u6C99\u7BB1\u8FD8\u6CA1\u5C31\u7EEA"});let o=de();return a=o,new Promise(m=>{s=m,t.contentWindow.postMessage({type:"render",nonce:o,runId:y.runId||"run-"+Date.now(),mountId:y.mountId||"main",name:y.name,code:y.code,props:y.props||{},dependencies:y.dependencies||[],isBoard:y.isBoard===!0},"*"),setTimeout(()=>{s===m&&(s=null,m({ok:!1,error:"\u6E32\u67D3\u8D85\u65F6\uFF088 \u79D2\uFF09"}))},8e3)})}function S(y){if(!i)return;let o=de();a=o,t.contentWindow.postMessage({type:"pick-mode",nonce:o,enabled:!!y},"*")}return{init:f,render:k,setPickMode:S,destroy:function(){window.removeEventListener("message",l)},isReady:function(){return i}}}var $=new Map,qe=20*1e3;function F(t,e,n,a){let i=t+"|"+e+"|"+n+"|"+(typeof a=="string"?a:""),h=$.get(i);if(h!==void 0&&Date.now()-h.at<qe)return h.pending;let s="?projectId="+encodeURIComponent(t)+"&kind="+e+"&id="+encodeURIComponent(n),u=typeof a=="string"&&a!==""?{"x-whales-token":a}:{},l=fetch(L+"/design/source"+s,{headers:u}).then(f=>f.ok?f.json():null).then(f=>!f||f.code!==200?null:f.data);return $.set(i,{at:Date.now(),pending:l}),l.catch(()=>{let f=$.get(i);f!==void 0&&f.pending===l&&$.delete(i)}),l}function ue(t,e,n){for(let a of Array.from($.keys()))a.indexOf(t+"|"+e+"|"+n+"|")===0&&$.delete(a)}async function re(t,e,n,a,i){let h=await F(t,e,n,i);if(h===null)return null;let s=[],u=h.meta&&Array.isArray(h.meta.imports)?h.meta.imports:[];if(a<4)for(let l of u){let f=await re(t,"component",l,a+1,i);f!==null&&s.push(f)}return{name:n,code:h.compiledCode||"",deps:s,meta:h.meta,source:h.source}}var H={card:{background:"var(--daw-surface, #fff)",border:"1px solid var(--daw-border, #dce2ee)",borderRadius:12,boxShadow:"0 6px 18px rgba(0,0,0,.06)",overflow:"hidden"},head:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:12,cursor:"grab",whiteSpace:"nowrap"},tag:{fontSize:10,padding:"2px 6px",borderRadius:999,background:"var(--daw-accent-bg, #f9effa)",color:"var(--daw-accent, #c05bd0)",fontWeight:600},muted:{color:"var(--daw-text-muted, #8a93a6)"}},xe={mobile:390,desktop:1024};function pe(t){let{projectId:e,kind:n,id:a,title:i,packId:h,entry:s,width:u,scale:l,maxHeight:f,exampleIndex:p,onReport:k,onNavigate:S,sourceHash:y,token:o,mode:m,onChanged:w,snapshot:c,interactive:R}=t,g=le(null),d=le(null),[b,_]=j({status:"loading",error:"",info:null}),I=m==="edit"||m==="annotate"?m:"view",[x,P]=j(null),[A,W]=j(""),[se,E]=j(""),[C,U]=j(null),[M,V]=j(""),[ie,q]=j(""),[ke,Ee]=j(0),me=xe[u==="mobile"?"mobile":"desktop"];X(()=>{let v=d.current;v!==null&&typeof v.setPickMode=="function"&&v.setPickMode(I!=="view"),P(null),U(null),E(""),q("")},[I,b.status]);let Ce=te(async()=>{if(x===null)return;let v=String(A||"").trim();if(v!==""){E("\u63D0\u4EA4\u4E2D\u2026");try{let O=await(await fetch(L+"/design/comments?projectId="+encodeURIComponent(e),{method:"POST",headers:{"content-type":"application/json","x-whales-token":o||""},body:JSON.stringify({target:(n==="artboard"?"board:":"comp:")+a,wsrc:x.wsrc,line:x.line,column:x.column,tag:x.tag,nth:x.nth,count:x.count,body:v,sourceSnippet:x.sourceSnippet})})).json();O&&O.code===200?(E(O.data&&O.data.delivered==="sent"?"\u5DF2\u63D0\u4EA4\uFF0C\u5DF2\u53D1\u7ED9 agent":"\u5DF2\u63D0\u4EA4\uFF08agent \u672A\u5728\u7EBF\uFF0C\u5B83\u4E0B\u6B21\u8BFB comments \u80FD\u770B\u5230\uFF09"),P(null),W("")):E("\u5931\u8D25\uFF1A"+String(O&&O.msg||"\u672A\u77E5\u9519\u8BEF"))}catch(N){E("\u5931\u8D25\uFF1A"+String(N&&N.message||N))}}},[x,A,e,n,a,o]),fe=te(async v=>{if(x===null||!x.wsrc){q("\u8FD9\u4E2A\u5143\u7D20\u6CA1\u6709\u6E90\u7801\u951A\u70B9\uFF0C\u8BF7\u7528\u6807\u6CE8\u8BA9 AI \u6539");return}q("\u4FDD\u5B58\u4E2D\u2026");try{let O=await(await fetch(L+"/design/edit?projectId="+encodeURIComponent(e),{method:"POST",headers:{"content-type":"application/json","x-whales-token":o||""},body:JSON.stringify(Object.assign({kind:n,name:n==="component"?a:void 0,artboardId:n==="artboard"?a:void 0,wsrc:x.wsrc},v))})).json();O&&O.code===200?(q("\u5DF2\u4FDD\u5B58\u5E76\u91CD\u65B0\u6E32\u67D3"),ue(e,n,a),Ee(B=>B+1),typeof w=="function"&&w()):q("\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(O&&O.msg||"\u672A\u77E5\u9519\u8BEF"))}catch(N){q("\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(N&&N.message||N))}},[x,e,n,a,o,w]);X(()=>{let v=!0,N=g.current;if(!N)return;let O=oe(N,{title:i,onError:()=>{},onNavigate:S,onPick:B=>{!v||!B||F(e,n,a,o).then(J=>{if(!v)return;let D=(J&&Array.isArray(J.jsxTable)?J.jsxTable:[]).filter(T=>T&&T.wsrc===B.wsrc)[0],z={wsrc:B.wsrc||"",line:D?D.line:0,column:D?D.column:0,tag:B.tag||D&&D.tag||"",nth:B.nth||0,count:B.count||1,text:B.text||"",sourceSnippet:D&&D.snippet||""};if(P(z),E(""),q(""),I==="edit"){if(V(z.text||""),U(null),!z.wsrc){q("\u8FD9\u4E2A\u5143\u7D20\u6CA1\u6709\u6E90\u7801\u951A\u70B9\uFF0C\u8BF7\u7528\u6807\u6CE8\u8BA9 AI \u6539");return}fetch(L+"/design/classes?projectId="+encodeURIComponent(e)+"&kind="+n+"&id="+encodeURIComponent(a)+"&wsrc="+encodeURIComponent(z.wsrc),{headers:{"x-whales-token":o||""}}).then(T=>T.json()).then(T=>{v&&U(T&&T.code===200?T.data:{error:T&&T.msg||"\u8BFB\u53D6\u5143\u7D20\u5931\u8D25"})}).catch(T=>{v&&q(String(T&&T.message||T))})}},()=>{})}});return d.current=O,(async()=>{try{let[B,J]=await Promise.all([ne(),ae(h)]),G=await O.init({runtime:B,styles:J.styles,bundle:J.bundle});if(!v)return;if(G&&G.timeout){_({status:"error",error:"\u6C99\u7BB1\u521D\u59CB\u5316\u8D85\u65F6",info:null});return}let D=c||await re(e,n,a,0,o);if(!v)return;if(D===null||D.code===""){_({status:"error",error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269\uFF08\u6E90\u7801\u53EF\u80FD\u8FD8\u6CA1\u4FDD\u5B58\uFF09",info:G});return}let z=await O.render({name:a,code:D.code,props:s&&s.props||{},dependencies:(D.deps||[]).map(T=>({name:T.name,code:T.code})),isBoard:n==="artboard"});if(!v)return;_({status:z.ok?"ok":"error",error:z.error||"",info:z}),typeof k=="function"&&k(z)}catch(B){v&&_({status:"error",error:String(B&&B.message||B),info:null})}})(),()=>{v=!1,d.current&&d.current.destroy()}},[e,n,a,h,y,s&&s.key,p,ke,I,c]);let ce=l||1,ge=Math.max(120,b.info&&b.info.height||480),he=R?Math.min(f||640,Math.max(120,Math.ceil(ge*ce))):Math.min(f||640,Math.max(120,b.info&&b.info.height||260)),Se=R?Math.ceil(he/ce):ge,Xe=typeof L=="string"?L:"/agent-whales/api";return r.createElement("div",{style:{position:"relative",width:Math.ceil(me*(l||1)),height:he,overflow:"hidden",background:"#fff"}},r.createElement("iframe",{ref:g,title:i||a,style:{border:0,width:me,height:Se,transform:"scale("+ce+")",transformOrigin:"0 0",pointerEvents:R||I!=="view"?"auto":"none",display:"block"}}),b.status==="loading"?r.createElement("div",{style:{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#8a93a6",background:"rgba(255,255,255,.6)"}},"\u6C99\u7BB1\u6E32\u67D3\u4E2D\u2026"):null,b.status==="error"?r.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,border:"1px solid #dc2626",background:"#fef2f2",color:"#991b1b",borderRadius:8,padding:"6px 8px",fontSize:11,fontFamily:"ui-monospace, Consolas, monospace",maxHeight:120,overflow:"auto",whiteSpace:"pre-wrap"}},"\u6E32\u67D3\u51FA\u9519\uFF1A"+String(b.error).slice(0,400)):null,I!=="view"?r.createElement("div",{style:{position:"absolute",left:8,top:6,zIndex:2,font:"11px system-ui",padding:"3px 8px",borderRadius:999,background:"#2563eb",color:"#fff"}},I==="edit"?"\u76F4\u63A5\u6539\uFF1A\u70B9\u9009\u5143\u7D20":"\u6807\u6CE8\uFF1A\u70B9\u9009\u5143\u7D20"):null,x!==null&&I==="annotate"?r.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,zIndex:3,background:"#fff",border:"1px solid #2563eb",borderRadius:8,padding:"8px 10px",boxShadow:"0 8px 24px rgba(15,23,42,.18)",font:"12px system-ui"}},r.createElement("div",{style:{color:"#5b6577",marginBottom:4}},String(x.tag||"\u5143\u7D20")+(x.line?" \xB7 \u7B2C "+x.line+" \u884C":"")+(Number(x.count)>1?" \xB7 \u540C\u6B3E\u7B2C "+(Number(x.nth)+1)+" \u4E2A":"")),r.createElement("textarea",{autoFocus:!0,value:A,placeholder:"\u8FD9\u91CC\u8981\u600E\u4E48\u6539\uFF1F\uFF08\u4F8B\u5982\uFF1A\u6807\u9898\u592A\u5927 / \u6362\u4E2A\u989C\u8272\uFF09",onChange:v=>W(v.target.value),style:{width:"100%",boxSizing:"border-box",height:56,resize:"vertical",font:"12px system-ui",padding:6,borderRadius:6,border:"1px solid #dce2ee"}}),r.createElement("div",{style:{display:"flex",gap:6,marginTop:6,alignItems:"center"}},r.createElement("button",{type:"button",className:"daw-wb-btn",onClick:Ce,disabled:String(A||"").trim()===""},"\u63D0\u4EA4"),r.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"ghost",onClick:()=>{P(null),W(""),E("")}},"\u53D6\u6D88"),r.createElement("span",{style:{color:"#5b6577",marginLeft:"auto"}},se))):null,x!==null&&I==="edit"?r.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,zIndex:3,background:"#fff",border:"1px solid #2563eb",borderRadius:8,padding:"8px 10px",boxShadow:"0 8px 24px rgba(15,23,42,.18)",font:"12px system-ui",maxHeight:"80%",overflow:"auto"}},r.createElement("div",{style:{color:"#5b6577",marginBottom:4}},"\u76F4\u63A5\u6539 \xB7 "+(x.tag||"\u5143\u7D20")+(x.line?" \xB7 L"+x.line:"")),r.createElement("textarea",{value:M,onChange:v=>V(v.target.value),placeholder:"\u4FEE\u6539\u8FD9\u4E2A\u5143\u7D20\u7684\u6587\u5B57",style:{width:"100%",boxSizing:"border-box",height:42,resize:"vertical",font:"12px system-ui",padding:6,borderRadius:6,border:"1px solid #dce2ee"}}),r.createElement("div",{style:{display:"flex",gap:6,marginTop:6}},r.createElement("button",{type:"button",className:"daw-wb-btn",onClick:()=>fe({text:M})},"\u4FDD\u5B58\u6587\u5B57"),r.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"ghost",onClick:()=>{P(null),U(null),q("")}},"\u53D6\u6D88")),C&&C.error?r.createElement("div",{style:{color:"#b45309",marginTop:6}},C.error):null,C&&Array.isArray(C.classes)?C.classes.map(v=>r.createElement("label",{key:v.name,style:{display:"flex",alignItems:"center",gap:6,marginTop:6}},r.createElement("span",{style:{color:"#5b6577",minWidth:70}},v.family),r.createElement("select",{value:v.name,onChange:N=>fe({fromClass:v.name,toClass:N.target.value}),style:{font:"12px system-ui",padding:4,borderRadius:6,border:"1px solid #dce2ee",maxWidth:"100%"}},[v.name].concat(C.options&&C.options[v.name]||[]).map(N=>r.createElement("option",{key:N,value:N},N))))):null,r.createElement("div",{style:{color:"#5b6577",marginTop:6}},ie)):null)}function we(t){let e=t.data&&t.data.original||{},n=typeof e.name=="string"?e.name:"",a=typeof e.title=="string"?e.title:n,i=t.data&&t.data.projectId||t.projectId||"",h=Number.isFinite(e.examplesCount)?e.examplesCount:0,[s,u]=j(0),[l,f]=j("view"),[p,k]=j(null);X(()=>{let g=!0;return F(i,"component",n,t.data&&t.data.token||t.token).then(d=>{g&&k(d)},()=>{}),()=>{g=!1}},[i,n]);let S=p&&p.meta&&Array.isArray(p.meta.examples)?p.meta.examples:[],y=p&&p.meta&&p.meta.tweaksSpec&&typeof p.meta.tweaksSpec=="object"?p.meta.tweaksSpec:{},o=Object.keys(y),[m,w]=j({}),c={};for(let g of o){let d=y[g]||{};if(m[g]!==void 0){c[g]=m[g];continue}if(d.default!==void 0){c[g]=d.default;continue}c[g]=d.type==="number"?Number.isFinite(d.min)?d.min:0:""}let R={key:n+"-"+s+"-"+JSON.stringify(c),props:Object.assign({},S[s]||{},o.length>0?{__tweaks:c}:{})};return r.createElement("div",{style:H.card},r.createElement("div",{style:H.head,"data-design-head":"1"},r.createElement("span",{style:{fontWeight:600}},a||n),r.createElement("span",{style:H.tag},"AI \xB7 \u7EC4\u4EF6"),r.createElement("span",{style:H.muted},n),typeof e.onEdit=="function"?r.createElement("button",{type:"button",onClick:g=>{g.stopPropagation(),e.onEdit()},className:"daw-wb-btn","data-variant":"ghost"},e.labels&&e.labels.edit||"\u7F16\u8F91"):null,r.createElement("button",{type:"button",onClick:g=>{g.stopPropagation(),f(l==="annotate"?"view":"annotate")},className:"daw-wb-btn","data-variant":"ghost","data-on":String(l==="annotate")},l==="annotate"?"\u9000\u51FA\u6807\u6CE8":e.labels&&e.labels.annotate||"\u6807\u6CE8"),r.createElement("button",{type:"button",onClick:g=>{g.stopPropagation(),f(l==="edit"?"view":"edit")},className:"daw-wb-btn","data-variant":"ghost","data-on":String(l==="edit")},l==="edit"?"\u9000\u51FA\u76F4\u63A5\u6539":e.labels&&e.labels.editDirect||"\u76F4\u63A5\u6539"),h>1?r.createElement("span",{style:{display:"flex",gap:4,marginLeft:"auto"}},Array.from({length:Math.min(h,6)},(g,d)=>r.createElement("button",{key:d,onClick:b=>{b.stopPropagation(),u(d)},className:"daw-wb-btn","data-variant":"ghost","data-on":String(d===s)},"\u4F8B\u5B50 "+(d+1)))):null),o.length>0?r.createElement("div",{style:{display:"flex",flexWrap:"wrap",gap:8,padding:"6px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:11}},o.slice(0,8).map(g=>{let d=y[g]||{},b=c[g];if(d.type==="select"){let P=Array.isArray(d.options)?d.options:[];return r.createElement("label",{key:g,style:{display:"flex",alignItems:"center",gap:4}},r.createElement("span",{style:H.muted},g),r.createElement("select",{value:String(b),onChange:A=>w(W=>Object.assign({},W,{[g]:A.target.value})),className:"daw-wb-btn","data-variant":"ghost"},P.map(A=>r.createElement("option",{key:String(A),value:String(A)},String(A)))))}let _=Number.isFinite(d.min)?d.min:0,I=Number.isFinite(d.max)?d.max:64,x=Number.isFinite(d.step)?d.step:1;return r.createElement("label",{key:g,style:{display:"flex",alignItems:"center",gap:4}},r.createElement("span",{style:H.muted},g),r.createElement("input",{type:"range",min:_,max:I,step:x,value:Number(b)||_,onChange:P=>w(A=>Object.assign({},A,{[g]:Number(P.target.value)})),style:{width:80}}),r.createElement("span",null,String(b)))})):null,r.createElement(pe,{projectId:i,kind:"component",id:n,title:a,packId:e.packId,token:t.data&&t.data.token||t.token,entry:R,exampleIndex:s,sourceHash:e.sourceHash,width:"desktop",scale:t.scale||.42,maxHeight:t.maxHeight||360,mode:l,onChanged:e.onDesignChanged}))}function ve(t){let e=t.data&&t.data.original||{},n=typeof e.artboardId=="string"?e.artboardId:"",a=typeof e.title=="string"?e.title:n,i=t.data&&t.data.projectId||t.projectId||"",h=e.width==="mobile"?"mobile":"desktop",[s,u]=j([n]),[l,f]=j("view"),[p,k]=j(""),S=s[s.length-1]||n,y=te(c=>{if(typeof c!="string"||c==="")return;if((Array.isArray(e.links)?e.links:[]).indexOf(c)<0){k("\u8FD9\u4E2A\u753B\u677F\u6CA1\u6709\u8FDE\u5230\u300C"+c+"\u300D");return}F(i,"artboard",c,t.data&&t.data.token||t.token).then(g=>{if(g===null){k("\u753B\u677F\u300C"+c+"\u300D\u4E0D\u5B58\u5728");return}u(d=>d[d.length-1]===c?d:d.concat([c]))},()=>{})},[e.links,i]),o=te(()=>u(c=>c.length>1?c.slice(0,-1):c),[]),[m,w]=j(a);return X(()=>{let c=!0;if(S===n){w(a);return}return F(i,"artboard",S,t.data&&t.data.token||t.token).then(R=>{c&&w(R&&R.meta&&R.meta.title?R.meta.title:S)},()=>{}),()=>{c=!1}},[i,n,S,a]),r.createElement("div",{style:H.card},r.createElement("div",{style:H.head,"data-design-head":"1"},r.createElement("span",{style:{fontWeight:600}},m||S),r.createElement("span",{style:H.tag},"AI \xB7 \u753B\u677F"),r.createElement("span",{style:H.muted},h==="mobile"?"\u624B\u673A":"\u684C\u9762"),e.requirementId?r.createElement("span",{style:H.muted},"\xB7 \u9700\u6C42 "+String(e.requirementId).slice(0,12)):null,typeof e.onEdit=="function"?r.createElement("button",{type:"button",onClick:c=>{c.stopPropagation(),e.onEdit()},className:"daw-wb-btn","data-variant":"ghost"},e.labels&&e.labels.edit||"\u7F16\u8F91"):null,r.createElement("button",{type:"button",onClick:c=>{c.stopPropagation(),f(l==="annotate"?"view":"annotate")},className:"daw-wb-btn","data-variant":"ghost","data-on":String(l==="annotate")},l==="annotate"?"\u9000\u51FA\u6807\u6CE8":e.labels&&e.labels.annotate||"\u6807\u6CE8"),r.createElement("button",{type:"button",onClick:c=>{c.stopPropagation(),f(l==="edit"?"view":"edit")},className:"daw-wb-btn","data-variant":"ghost","data-on":String(l==="edit")},l==="edit"?"\u9000\u51FA\u76F4\u63A5\u6539":e.labels&&e.labels.editDirect||"\u76F4\u63A5\u6539"),p!==""?r.createElement("span",{style:{color:"#b45309",fontSize:11}},p):null,s.length>1?r.createElement("button",{onClick:c=>{c.stopPropagation(),o()},className:"daw-wb-btn","data-variant":"ghost",style:{marginLeft:"auto"},title:"\u56DE\u5230\u4E0A\u4E00\u4E2A\u753B\u677F"},"\u2190 \u8FD4\u56DE ("+(s.length-1)+")"):null),r.createElement(pe,{projectId:i,kind:"artboard",id:S,title:m,packId:e.packId,token:t.data&&t.data.token||t.token,entry:{key:S+"-0",props:{}},sourceHash:S===n?e.sourceHash:void 0,width:h,scale:t.scale||.42,maxHeight:t.maxHeight||420,onNavigate:y,interactive:!0,mode:l,onChanged:e.onDesignChanged}))}function We(t){let e=t.delivery,n=le(null),[a,i]=j(560),[h,s]=j([e.entryId]),u=e.boards.find(p=>p.id===h[h.length-1]),l=Le(()=>u&&{code:u.code,deps:u.dependencies.map(p=>({name:p,code:e.modules[p]}))},[u,e]);if(X(()=>{let p=n.current;if(!p)return;function k(){p.clientWidth>0&&i(p.clientWidth)}if(k(),typeof ResizeObserver=="undefined")return;let S=new ResizeObserver(k);return S.observe(p),()=>S.disconnect()},[]),!u)return null;let f=Math.min(1,a/xe[u.width==="mobile"?"mobile":"desktop"]);return r.createElement("div",{ref:n,style:{display:"grid",justifyItems:"center",minWidth:0,overflow:"hidden"}},h.length>1?r.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"ghost",onClick:()=>s(p=>p.slice(0,-1))},t.backLabel||"\u8FD4\u56DE\u4E0A\u4E00\u5C4F"):null,r.createElement(pe,{projectId:e.projectId,kind:"artboard",id:u.id,title:u.title,packId:e.packId,width:u.width,scale:f,maxHeight:640,interactive:!0,snapshot:l,onNavigate:p=>{p!==u.id&&u.links.includes(p)&&e.boards.some(k=>k.id===p)&&s(k=>[...k,p])}}))}function Ue(t,e,n){let a=n||{};X(()=>{if(typeof t!="string"||t===""||typeof e!="string"||e==="")return;let i=!0,h=null,s=document.createElement("div");s.style.cssText="position:fixed;left:-10000px;top:0;width:1024px;height:800px;overflow:hidden",document.body.appendChild(s);let u=document.createElement("iframe");u.style.cssText="width:1024px;height:800px;border:0",s.appendChild(u);let l=null,f=null;async function p(){return l!==null?l:(f!==null||(l=oe(u,{title:"whales-design-live"}),f=(async()=>{let[o,m]=await Promise.all([ne(),ae(a.packId)]);return l.init({runtime:o,styles:m.styles,bundle:m.bundle})})()),f)}async function k(o){let m=o.target||{},w=m.type==="artboard"?"artboard":"component",c=w==="artboard"?m.artboardId:m.name;try{await p();let R=await re(t,w,c,0,e);if(R===null||R.code===""){await S({requestId:o.requestId,ok:!1,error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269"});return}let g=await F(t,w,c,e),d=g&&g.meta&&Array.isArray(g.meta.examples)?g.meta.examples:[],b=await l.render({name:c,code:R.code,props:d[Number(o.exampleIndex)||0]||{},dependencies:(R.deps||[]).map(_=>({name:_.name,code:_.code}))});await S({requestId:o.requestId,ok:b.ok!==!1,error:b.error||"",consoleErrors:b.consoleErrors||[],ms:b.ms,width:b.width,height:b.height,nodeCount:b.nodeCount,textLength:b.textLength,textSample:b.textSample,empty:b.empty,buttons:b.buttons,inputs:b.inputs,tables:b.tables})}catch(R){await S({requestId:o.requestId,ok:!1,error:String(R&&R.message||R)})}}async function S(o){try{await fetch(L+"/design/live/result",{method:"POST",headers:{"content-type":"application/json","x-whales-token":e},body:JSON.stringify(o)})}catch{}}async function y(){if(i){try{let o=await fetch(L+"/design/live?projectId="+encodeURIComponent(t),{headers:{"x-whales-token":e}});if(o.ok){let m=await o.json(),w=m&&m.data&&Array.isArray(m.data.requests)?m.data.requests:[];for(let c of w)await k(c)}}catch{}i&&(h=setTimeout(y,4e3))}}return y(),()=>{i=!1,h&&clearTimeout(h),l&&l.destroy(),s.remove()}},[t,e,a.packId])}async function ze(t){let e=t&&t.data||{},n=t&&t.projectId?t.projectId:"",a=t.kind==="artboard"?"artboard":"component",i=a==="artboard"?e.artboardId:e.name,h=typeof t.token=="string"?t.token:"",[s,u,l]=await Promise.all([F(n,a,i,h),ne().catch(()=>""),ae(e.packId).catch(()=>({styles:"",bundle:""}))]),f=document.createElement("div");f.style.cssText="position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px";let p=document.createElement("div");p.style.cssText="width:min(1280px,97vw);height:min(860px,94vh);background:#fff;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.35)";let k=document.createElement("div");k.style.cssText="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #dce2ee;font:13px system-ui";let S=document.createElement("b");S.textContent=s&&s.meta&&s.meta.title||i;let y=document.createElement("span");y.style.color="#8a93a6",y.textContent=i+".tsx",k.append(S,y);let o=document.createElement("span");o.style.cssText="margin-left:12px;font:11px system-ui;color:#8a93a6",k.appendChild(o);let m=document.createElement("button");m.textContent="\u89E3\u9501\u8BA9 AI \u7EE7\u7EED\u6539",m.style.cssText="margin-left:auto;font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer;display:none",k.appendChild(m);let w=document.createElement("button");w.textContent="\u4FDD\u5B58",w.style.cssText="font:12px system-ui;padding:4px 12px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer",k.appendChild(w);let c=document.createElement("button");c.textContent="\u5173\u95ED",c.style.cssText="font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer",c.onclick=()=>f.remove(),k.appendChild(c);let R=document.createElement("div");R.style.cssText="flex:1;display:flex;min-height:0";let g=document.createElement("div");g.style.cssText="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid #dce2ee";let d=document.createElement("textarea");d.spellcheck=!1,d.value=s?s.source:"",d.style.cssText="flex:1;width:100%;border:0;outline:none;resize:none;padding:14px;font:12px/1.6 ui-monospace,Consolas,monospace;background:#fbfcfe;color:#1e2430;tab-size:2",g.appendChild(d);let b=document.createElement("div");b.style.cssText="width:min(560px,46%);display:flex;flex-direction:column;min-width:0;background:#f6f8fb";let _=document.createElement("iframe");_.setAttribute("sandbox","allow-scripts"),_.setAttribute("srcdoc",Q({title:"\u6E90\u7801\u9884\u89C8"})),_.style.cssText="flex:1;width:100%;border:0;background:#fff",b.appendChild(_),R.append(g,b);let I=document.createElement("div");I.style.cssText="display:none;padding:8px 12px;border-top:1px solid #fecaca;background:#fef2f2;color:#991b1b;font:11px/1.6 ui-monospace,Consolas,monospace;max-height:120px;overflow:auto;white-space:pre-wrap",p.append(k,R,I),f.appendChild(p),document.body.appendChild(f),f.addEventListener("click",E=>{E.target===f&&f.remove()});let x=null,P=s&&s.compiledCode||"";try{x=oe(_,{title:"\u6E90\u7801\u9884\u89C8"}),await x.init({runtime:u,styles:l.styles||"",bundle:l.bundle||""})}catch(E){o.textContent="\u6C99\u7BB1\u521D\u59CB\u5316\u5931\u8D25\uFF1A"+String(E&&E.message||E)}let A=null,W=0;async function se(E){let C=++W;w.disabled=!0,o.textContent="\u7F16\u8BD1\u4E2D\u2026";try{let M=await(await fetch(L+"/design/compile",{method:"POST",headers:{"content-type":"application/json","x-whales-token":h},body:JSON.stringify({projectId:n,kind:a,name:a==="component"?i:void 0,artboardId:a==="artboard"?i:void 0,source:E})})).json();if(C!==W)return;if(!M||M.code!==200||!M.data||M.data.compile&&M.data.compile.ok===!1){let V=M&&M.data&&M.data.compile&&M.data.compile.errors?M.data.compile.errors:[];I.style.display="block",I.textContent=V.length>0?V.map(ie=>ie.message).join(`
`):String(M&&M.msg||"\u7F16\u8BD1\u5931\u8D25"),o.textContent="\u7F16\u8BD1\u5931\u8D25",w.disabled=!1;return}I.style.display="none",P=M.data.compiled||P,o.textContent="\u7F16\u8BD1\u901A\u8FC7",w.disabled=!1,x!==null&&await x.render({name:i,code:P,props:s&&s.meta&&s.meta.examples&&s.meta.examples[0]||{},isBoard:a==="artboard"})}catch(U){if(C!==W)return;I.style.display="block",I.textContent="\u7F16\u8BD1\u8BF7\u6C42\u5931\u8D25\uFF1A"+String(U&&U.message||U),w.disabled=!1}}if(d.addEventListener("input",()=>{A&&clearTimeout(A),A=setTimeout(()=>se(d.value),500)}),w.onclick=async()=>{o.textContent="\u4FDD\u5B58\u4E2D\u2026";try{let C=await(await fetch(L+"/design/source",{method:"POST",headers:{"content-type":"application/json","x-whales-token":h},body:JSON.stringify({projectId:n,kind:a,name:a==="component"?i:void 0,artboardId:a==="artboard"?i:void 0,source:d.value})})).json();C&&C.code===200&&C.data&&C.data.written===!0?(o.textContent="\u5DF2\u4FDD\u5B58\uFF08agent \u4E4B\u540E\u4E0D\u80FD\u6539\u8FD9\u4E2A\u4E86\uFF09",ue(n,a,i),m.style.display=""):o.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(C&&C.msg||"\u672A\u77E5\u9519\u8BEF")}catch(E){o.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(E&&E.message||E)}},m.onclick=async()=>{o.textContent="\u89E3\u9501\u4E2D\u2026";try{let C=await(await fetch(L+"/design/unlock",{method:"POST",headers:{"content-type":"application/json","x-whales-token":h},body:JSON.stringify({projectId:n,kind:a,name:a==="component"?i:void 0,artboardId:a==="artboard"?i:void 0})})).json();o.textContent=C&&C.code===200&&C.data&&C.data.unlocked?"\u5DF2\u89E3\u9501\uFF0CAI \u53EF\u4EE5\u7EE7\u7EED\u6539":"\u89E3\u9501\u5931\u8D25\uFF1A"+String(C&&C.msg||""),m.style.display="none"}catch(E){o.textContent="\u89E3\u9501\u5931\u8D25\uFF1A"+String(E&&E.message||E)}},s&&s.userEdited===!0&&(m.style.display=""),P!==""&&x!==null)try{await x.render({name:i,code:P,props:s&&s.meta&&s.meta.examples&&s.meta.examples[0]||{},isBoard:a==="artboard"})}catch{}return{close:()=>f.remove()}}var Fe={component:we,artboard:ve},Je="";

return module.exports;
} });

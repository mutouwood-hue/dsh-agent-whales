/* dsh-agent-whales · client.design.js —— 由 tools/flow-chunk/build-design.mjs 生成，勿手改。
 * 组件工坊：组件 / 画板节点的沙箱预览与在线画布登记。只在画布上出现这两种节点时按需加载。 */
window.__ModuleLoader__.load({ id: "dsh-agent-whales", chunk: "client.design.js", factory: function (require) {
var module = { exports: {} }; var exports = module.exports;
var Oe=Object.create;var te=Object.defineProperty;var Be=Object.getOwnPropertyDescriptor;var De=Object.getOwnPropertyNames;var Le=Object.getPrototypeOf,He=Object.prototype.hasOwnProperty;var ze=(e,t)=>{for(var n in t)te(e,n,{get:t[n],enumerable:!0})},Ee=(e,t,n,a)=>{if(t&&typeof t=="object"||typeof t=="function")for(let c of De(t))!He.call(e,c)&&c!==n&&te(e,c,{get:()=>t[c],enumerable:!(a=Be(t,c))||a.enumerable});return e};var We=(e,t,n)=>(n=e!=null?Oe(Le(e)):{},Ee(t||!e||!e.__esModule?te(n,"default",{value:e,enumerable:!0}):n,e)),qe=e=>Ee(te({},"__esModule",{value:!0}),e);var et={};ze(et,{DESIGN_CSS:()=>Ze,DesignArtboardNode:()=>Ne,DesignChatPreview:()=>Ge,DesignComponentNode:()=>Ie,SANDBOX_CSP:()=>ne,createSandboxHost:()=>ce,designNodeTypes:()=>Qe,invalidateEntity:()=>pe,loadCompiled:()=>de,loadEntity:()=>G,loadPackText:()=>ie,loadRuntimeText:()=>se,openSourceEditor:()=>Ye,sandboxSrcdoc:()=>ae,useDesignLive:()=>Ke});module.exports=qe(et);var s=We(require("react"),1);function Ue(e){let t=e||{},n=String(t.csp||"default-src 'none'"),a=Se(String(t.title||"whales-design-sandbox"));return`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${n}">
<meta name="whales-boot-id" content="${Se(String(t.bootId||""))}">
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
<script>${Fe}<\/script>
</body></html>`}var Fe=String.raw`
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
      var renderElement = failed
        ? React.createElement("div", { className: "wds-error" }, "渲染出错：" + String(failed && failed.message || failed))
        : React.createElement(Boundary, null, element);
      if (runtime.ReactDOM && typeof runtime.ReactDOM.flushSync === "function") {
        runtime.ReactDOM.flushSync(function () { root.render(renderElement); });
      } else root.render(renderElement);
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

  var sizeObserver = null;
  function observeSize(container, runId) {
    if (sizeObserver) sizeObserver.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    var lastHeight = 0;
    sizeObserver = new ResizeObserver(function () {
      var host = container.firstElementChild;
      if (!host) return;
      var height = Math.ceil(Math.max(host.scrollHeight, host.getBoundingClientRect().height));
      if (height > 0 && height !== lastHeight) {
        lastHeight = height;
        report({ type: "resize", runId: runId, height: height });
      }
    });
    sizeObserver.observe(container.firstElementChild || container);
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
      observeSize(slot, msg.runId);
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

  parentWin.postMessage({ type: "booted", bootId: document.querySelector('meta[name="whales-boot-id"]').content }, "*");
})();
`,ne="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";function ae(e){return Ue(Object.assign({csp:ne},e||{}))}function Se(e){let t={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"};return String(e).replace(/[&<>"]/g,n=>t[n])}var{useCallback:me,useEffect:Q,useMemo:Je,useRef:K,useState:_}=s,H="/agent-whales/api",$e=`var t=require("react/jsx-runtime"),d=(...e)=>e.filter(Boolean).join(" ");var i={default:"border-transparent bg-primary text-primary-foreground shadow",secondary:"border-transparent bg-secondary text-secondary-foreground",outline:"text-foreground",destructive:"border-transparent bg-destructive text-destructive-foreground shadow"},c={info:"bg-background text-foreground",success:"border-emerald-500/50 text-emerald-700 bg-emerald-50",warning:"border-amber-500/50 text-amber-800 bg-amber-50",error:"border-destructive/50 text-destructive bg-red-50"},o="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",x="text-sm font-medium leading-none";var m={default:"bg-primary text-primary-foreground shadow hover:bg-primary/90",primary:"bg-primary text-primary-foreground shadow hover:bg-primary/90",secondary:"bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",outline:"border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",ghost:"hover:bg-accent hover:text-accent-foreground",destructive:"bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"},g="rounded-lg border bg-background text-foreground shadow-sm",h=({className:e,children:r,header:a,footer:l,...n})=>(0,t.jsxs)("div",{className:d(g,e),...n,children:[a?(0,t.jsx)("div",{className:"flex flex-col gap-1 p-5 pb-2",children:a}):null,(0,t.jsx)("div",{className:"p-5",children:r}),l?(0,t.jsx)("div",{className:"flex items-center p-5 pt-0",children:l}):null]}),u={Button:({variant:e="default",className:r,children:a,...l})=>(0,t.jsx)("button",{type:"button",className:d("inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors",m[e]||m.default,r),...l,children:a}),Input:({className:e,...r})=>(0,t.jsx)("input",{className:d(o,e),...r}),Textarea:({className:e,rows:r=3,...a})=>(0,t.jsx)("textarea",{rows:r,className:d(o,"min-h-[72px] h-auto py-2",e),...a}),Select:({options:e,className:r,...a})=>{let l=(Array.isArray(e)?e:[]).map(n=>{let s=n&&n.value!==void 0?n.value:n,f=n&&n.label!==void 0?n.label:String(s);return{value:String(s),text:String(f)}});return(0,t.jsx)("select",{className:d(o,r),...a,children:l.map(n=>(0,t.jsx)("option",{value:n.value,children:n.text},n.value))})},Label:({className:e,children:r,...a})=>(0,t.jsx)("label",{className:d(x,e),...a,children:r}),Badge:({variant:e="default",className:r,children:a,...l})=>(0,t.jsx)("span",{className:d("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",i[e]||i.default,r),...l,children:a}),Card:h,CardHeader:({className:e,children:r})=>(0,t.jsx)("div",{className:d("flex flex-col gap-1 p-5 pb-2",e),children:r}),CardTitle:({className:e,children:r})=>(0,t.jsx)("div",{className:d("text-lg font-semibold leading-none tracking-tight",e),children:r}),CardDescription:({className:e,children:r})=>(0,t.jsx)("div",{className:d("text-sm text-muted-foreground",e),children:r}),CardContent:({className:e,children:r})=>(0,t.jsx)("div",{className:d("p-5",e),children:r}),Separator:({className:e})=>(0,t.jsx)("hr",{className:d("my-2 border-border",e)}),Alert:({tone:e="info",title:r,children:a,className:l})=>(0,t.jsxs)("div",{role:"alert",className:d("relative w-full rounded-lg border p-4 text-sm",c[e]||c.info,l),children:[r?(0,t.jsx)("div",{className:"mb-1 font-medium",children:r}):null,a?(0,t.jsx)("div",{children:a}):null]}),Table:({columns:e,rows:r,rowKey:a})=>(0,t.jsx)("div",{className:"w-full overflow-auto rounded-lg border",children:(0,t.jsxs)("table",{className:"w-full caption-bottom text-sm",children:[(0,t.jsx)("thead",{children:(0,t.jsx)("tr",{className:"border-b bg-muted/50",children:(e||[]).map(l=>(0,t.jsx)("th",{className:"h-10 px-3 text-left align-middle font-medium text-muted-foreground",children:l.header},l.key))})}),(0,t.jsx)("tbody",{children:(r||[]).map((l,n)=>(0,t.jsx)("tr",{className:"border-b transition-colors hover:bg-muted/50",children:(e||[]).map(s=>(0,t.jsx)("td",{className:"p-3 align-middle",children:typeof s.render=="function"?s.render(l):String(l[s.key]===void 0?"":l[s.key])},s.key))},typeof a=="function"?a(l,n):n))})]})}),Tabs:({items:e,value:r,onChange:a})=>(0,t.jsxs)("div",{className:"flex flex-col gap-3",children:[(0,t.jsx)("div",{className:"flex gap-1 border-b",children:(e||[]).map(l=>(0,t.jsx)("button",{type:"button",onClick:()=>{typeof a=="function"&&a(l.key)},className:d("px-3 py-2 text-sm font-medium",l.key===r?"border-b-2 border-primary text-foreground":"text-muted-foreground hover:text-foreground"),children:l.label},l.key))}),(0,t.jsx)("div",{children:(e||[]).filter(l=>l.key===r).map(l=>(0,t.jsx)("div",{children:l.content},l.key))})]}),Switch:({checked:e,onChange:r,className:a})=>(0,t.jsx)("button",{type:"button",role:"switch","aria-checked":!!e,onClick:()=>{typeof r=="function"&&r(!e)},className:d("relative inline-flex h-5 w-9 items-center rounded-full transition-colors",e?"bg-primary":"bg-input",a),children:(0,t.jsx)("span",{className:d("block size-4 rounded-full bg-background shadow transition-transform",e?"translate-x-4":"translate-x-0.5")})}),Checkbox:({checked:e,onChange:r,className:a,...l})=>(0,t.jsx)("input",{type:"checkbox",checked:!!e,onChange:n=>{typeof r=="function"&&r(n.target.checked)},className:d("size-4 rounded border-input accent-primary",a),...l}),EmptyState:({title:e="\\u8FD8\\u6CA1\\u6709\\u6570\\u636E",hint:r,className:a})=>(0,t.jsxs)("div",{className:d("flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-8 text-center",a),children:[(0,t.jsx)("div",{className:"text-sm font-medium text-foreground",children:e}),r?(0,t.jsx)("div",{className:"text-xs text-muted-foreground",children:r}):null]}),Progress:({value:e=0,className:r})=>(0,t.jsx)("div",{className:d("h-2 w-full overflow-hidden rounded-full bg-muted",r),children:(0,t.jsx)("div",{className:"h-full bg-primary transition-all",style:{width:Math.max(0,Math.min(100,Number(e)||0))+"%"}})}),Avatar:({name:e="",className:r})=>(0,t.jsx)("span",{className:d("inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground",r),children:String(e).trim().slice(0,1)||"?"}),Title:({level:e=2,className:r,children:a})=>(0,t.jsx)("h"+(Number(e)>=1&&Number(e)<=6?e:2),{className:d("font-semibold tracking-tight",r),children:a}),Text:({tone:e="default",className:r,children:a})=>(0,t.jsx)("p",{className:d("text-sm leading-7",e==="muted"?"text-muted-foreground":"text-foreground",r),children:a}),Stack:({gap:e=3,className:r,children:a})=>(0,t.jsx)("div",{className:d("flex flex-col",e===1?"gap-1":e===2?"gap-2":e===4?"gap-4":"gap-3",r),children:a}),Row:({gap:e=2,className:r,children:a})=>(0,t.jsx)("div",{className:d("flex flex-row items-center",e===1?"gap-1":e===3?"gap-3":e===4?"gap-4":"gap-2",r),children:a})};module.exports=u;
`,Xe=`*, ::before, ::after {
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
`,re=new Map,oe=new Map;function se(){let e="runtime";if(re.has(e))return re.get(e);let t=fetch(H+"/design/runtime.js").then(n=>{if(!n.ok)throw new Error("\u8FD0\u884C\u65F6\u4E0B\u8F7D\u5931\u8D25 "+n.status);return n.text()});return re.set(e,t),t.catch(()=>re.delete(e)),t}function ie(e){let t=typeof e=="string"&&e!==""?e:"shadcn";if(oe.has(t))return oe.get(t);let n=H+"/component-packs/"+encodeURIComponent(t),a=(async()=>{if(t==="shadcn")return{bundle:$e,styles:Xe,api:null,builtin:!0};let[c,l]=await Promise.all([fetch(n+"/bundle.js").then(b=>b.ok?b.text():""),fetch(n+"/styles.css").then(b=>b.ok?b.text():"",()=>"")]),r=null;try{r=await(await fetch(H+"/design/pack-api?packId="+encodeURIComponent(t))).json()}catch{r=null}return{bundle:c,styles:l,api:r,builtin:!1}})();return oe.set(t,a),a.catch(()=>oe.delete(t)),a}var Ce=0;function ue(){Ce+=1;let e=new Uint8Array(16);if(typeof crypto!="undefined"&&typeof crypto.getRandomValues=="function")crypto.getRandomValues(e);else for(let t=0;t<e.length;t+=1)e[t]=Math.floor(Math.random()*256);return Array.from(e,t=>t.toString(16).padStart(2,"0")).join("")+"-"+Ce}function ce(e,t){let n=t||{},a="",c=!1,l=[],r=null,b=!1,p=ue(),d=o=>{if(o.origin!=="null")return;let i=o.data||{};if(i.type==="booted"){i.bootId===p&&(b=!0);return}if(i.nonce===a){if(i.type==="ready"){c=!0;let g=l.splice(0);for(let x of g)x(i.info||{});return}if(i.type==="rendered"){if(r!==null){let g=r;r=null,g(i)}return}if(i.type==="resize"){typeof n.onResize=="function"&&n.onResize(i.height);return}if(i.type==="pick"){typeof n.onPick=="function"&&n.onPick(i.pick);return}if(i.type==="navigate"){typeof n.onNavigate=="function"&&n.onNavigate(i.to);return}i.type==="error"&&typeof n.onError=="function"&&n.onError(i)}};window.addEventListener("message",d),e.setAttribute("sandbox","allow-scripts"),e.setAttribute("srcdoc",ae({csp:ne,title:n.title||"whales-design",bootId:p}));function k(o){if(a=ue(),!b){let i=Date.now();return new Promise(g=>{let x=()=>{if(b||Date.now()-i>6e3){g();return}setTimeout(x,60)};x()}).then(()=>N(o))}return N(o)}function N(o){return new Promise(i=>{l.push(i),e.contentWindow.postMessage({type:"init",nonce:a,runtime:o.runtime,styles:o.styles,packCode:o.bundle},"*"),setTimeout(()=>{c||i({timeout:!0})},8e3)})}function j(o){if(!c)return Promise.resolve({ok:!1,error:"\u6C99\u7BB1\u8FD8\u6CA1\u5C31\u7EEA"});let i=ue();return a=i,new Promise(g=>{r=g,e.contentWindow.postMessage({type:"render",nonce:i,runId:o.runId||"run-"+Date.now(),mountId:o.mountId||"main",name:o.name,code:o.code,props:o.props||{},dependencies:o.dependencies||[],isBoard:o.isBoard===!0},"*"),setTimeout(()=>{r===g&&(r=null,g({ok:!1,error:"\u6E32\u67D3\u8D85\u65F6\uFF088 \u79D2\uFF09"}))},8e3)})}function S(o){c&&e.contentWindow.postMessage({type:"pick-mode",nonce:a,enabled:!!o},"*")}return{init:k,render:j,setPickMode:S,destroy:function(){window.removeEventListener("message",d)},isReady:function(){return c}}}var Y=new Map,Ve=20*1e3;function G(e,t,n,a){let c=e+"|"+t+"|"+n+"|"+(typeof a=="string"?a:""),l=Y.get(c);if(l!==void 0&&Date.now()-l.at<Ve)return l.pending;let r="?projectId="+encodeURIComponent(e)+"&kind="+t+"&id="+encodeURIComponent(n),b=typeof a=="string"&&a!==""?{"x-whales-token":a}:{},p=fetch(H+"/design/source"+r,{headers:b}).then(d=>d.ok?d.json():null).then(d=>!d||d.code!==200?null:d.data);return Y.set(c,{at:Date.now(),pending:p}),p.catch(()=>{let d=Y.get(c);d!==void 0&&d.pending===p&&Y.delete(c)}),p}function pe(e,t,n){for(let a of Array.from(Y.keys()))a.indexOf(e+"|"+t+"|"+n+"|")===0&&Y.delete(a)}async function de(e,t,n,a,c){let l=await G(e,t,n,c);if(l===null)return null;let r=[],b=l.meta&&Array.isArray(l.meta.imports)?l.meta.imports:[];if(a<4)for(let p of b){let d=await de(e,"component",p,a+1,c);d!==null&&r.push(d)}return{name:n,code:l.compiledCode||"",deps:r,meta:l.meta,source:l.source}}var W={card:{background:"var(--daw-surface, #fff)",border:"1px solid var(--daw-border, #dce2ee)",borderRadius:12,boxShadow:"0 6px 18px rgba(0,0,0,.06)",overflow:"hidden"},head:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:12,cursor:"grab",whiteSpace:"nowrap"},tag:{fontSize:10,padding:"2px 6px",borderRadius:999,background:"var(--daw-accent-bg, #f9effa)",color:"var(--daw-accent, #c05bd0)",fontWeight:600},muted:{color:"var(--daw-text-muted, #8a93a6)"}},fe={mobile:390,desktop:1024};function Re(e){let[t,n]=_(560);return Q(()=>{let a=e.current;if(!a)return;function c(){a.clientWidth>0&&n(a.clientWidth)}if(c(),typeof ResizeObserver=="undefined")return;let l=new ResizeObserver(c);return l.observe(a),()=>l.disconnect()},[e]),t}function ge(e){let{projectId:t,kind:n,id:a,title:c,packId:l,entry:r,width:b,scale:p,maxHeight:d,exampleIndex:k,onReport:N,onNavigate:j,sourceHash:S,token:o,mode:i,onChanged:g,snapshot:x,interactive:T}=e,u=K(null),m=K(null),[w,M]=_({status:"loading",error:"",info:null}),[D,L]=_(0),E=i==="edit"||i==="annotate"?i:"view",h=K(E);h.current=E;let C=K(j);C.current=j;let[f,v]=_(null),[R,J]=_(""),[P,q]=_(""),[V,he]=_(!1),[X,Z]=_(null),[ye,be]=_(""),[je,U]=_(""),[Te,Me]=_(0),we=fe[b==="mobile"?"mobile":"desktop"];Q(()=>{let y=m.current;y!==null&&typeof y.setPickMode=="function"&&y.setPickMode(E!=="view"),v(null),Z(null),q(""),U("")},[E,a]);let _e=me(async()=>{if(f===null||V)return;let y=String(R||"").trim();if(y!==""){he(!0),q("\u63D0\u4EA4\u4E2D\u2026");try{let B=await(await fetch(H+"/design/comments?projectId="+encodeURIComponent(t),{method:"POST",headers:{"content-type":"application/json","x-whales-token":o||""},body:JSON.stringify({target:(n==="artboard"?"board:":"comp:")+a,wsrc:f.wsrc,line:f.line,column:f.column,tag:f.tag,nth:f.nth,count:f.count,body:y,sourceSnippet:f.sourceSnippet})})).json();B&&B.code===200?(q(B.data&&B.data.delivered==="sent"?"\u6807\u6CE8\u5DF2\u4FDD\u5B58\u5E76\u53D1\u9001":"\u6807\u6CE8\u5DF2\u4FDD\u5B58\uFF0C\u9001\u8FBE\u5F85\u786E\u8BA4"),v(null),J("")):q("\u5931\u8D25\uFF1A"+String(B&&B.msg||"\u672A\u77E5\u9519\u8BEF"))}catch(A){q("\u5931\u8D25\uFF1A"+String(A&&A.message||A))}finally{he(!1)}}},[f,R,V,t,n,a,o]),xe=me(async y=>{if(f===null||!f.wsrc){U("\u8FD9\u4E2A\u5143\u7D20\u6CA1\u6709\u6E90\u7801\u951A\u70B9\uFF0C\u8BF7\u7528\u6807\u6CE8\u8BA9 AI \u6539");return}U("\u4FDD\u5B58\u4E2D\u2026");try{let B=await(await fetch(H+"/design/edit?projectId="+encodeURIComponent(t),{method:"POST",headers:{"content-type":"application/json","x-whales-token":o||""},body:JSON.stringify(Object.assign({kind:n,name:n==="component"?a:void 0,artboardId:n==="artboard"?a:void 0,wsrc:f.wsrc},y))})).json();B&&B.code===200?(U("\u5DF2\u4FDD\u5B58\u5E76\u91CD\u65B0\u6E32\u67D3"),pe(t,n,a),Me(I=>I+1),typeof g=="function"&&g()):U("\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(B&&B.msg||"\u672A\u77E5\u9519\u8BEF"))}catch(A){U("\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(A&&A.message||A))}},[f,t,n,a,o,g]);Q(()=>{let y=!0,A=u.current;if(!A)return;M({status:"loading",error:"",info:null}),L(0);let B=ce(A,{title:c,onResize:I=>{y&&Number.isFinite(I)&&I>0&&L(Math.min(2e4,I))},onError:()=>{},onNavigate:I=>{var $;return($=C.current)==null?void 0:$.call(C,I)},onPick:I=>{!y||!I||G(t,n,a,o).then($=>{if(!y||h.current==="view")return;let z=($&&Array.isArray($.jsxTable)?$.jsxTable:[]).filter(O=>O&&O.wsrc===I.wsrc)[0],F={wsrc:I.wsrc||"",line:z?z.line:0,column:z?z.column:0,tag:I.tag||z&&z.tag||"",nth:I.nth||0,count:I.count||1,text:I.text||"",sourceSnippet:z&&z.snippet||""};if(v(F),q(""),U(""),h.current==="edit"){if(be(F.text||""),Z(null),!F.wsrc){U("\u8FD9\u4E2A\u5143\u7D20\u6CA1\u6709\u6E90\u7801\u951A\u70B9\uFF0C\u8BF7\u7528\u6807\u6CE8\u8BA9 AI \u6539");return}fetch(H+"/design/classes?projectId="+encodeURIComponent(t)+"&kind="+n+"&id="+encodeURIComponent(a)+"&wsrc="+encodeURIComponent(F.wsrc),{headers:{"x-whales-token":o||""}}).then(O=>O.json()).then(O=>{y&&Z(O&&O.code===200?O.data:{error:O&&O.msg||"\u8BFB\u53D6\u5143\u7D20\u5931\u8D25"})}).catch(O=>{y&&U(String(O&&O.message||O))})}},()=>{})}});return m.current=B,(async()=>{try{let[I,$]=await Promise.all([se(),ie(l)]),ee=await B.init({runtime:I,styles:$.styles,bundle:$.bundle});if(!y)return;if(ee&&ee.timeout){M({status:"error",error:"\u6C99\u7BB1\u521D\u59CB\u5316\u8D85\u65F6",info:null});return}let z=x||await de(t,n,a,0,o);if(!y)return;if(z===null||z.code===""){M({status:"error",error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269\uFF08\u6E90\u7801\u53EF\u80FD\u8FD8\u6CA1\u4FDD\u5B58\uFF09",info:ee});return}let F=await B.render({name:a,code:z.code,props:r&&r.props||{},dependencies:(z.deps||[]).map(O=>({name:O.name,code:O.code})),isBoard:n==="artboard"});if(!y)return;F.ok&&B.setPickMode(h.current!=="view"),M({status:F.ok?"ok":"error",error:F.error||"",info:F}),typeof N=="function"&&N(F)}catch(I){y&&M({status:"error",error:String(I&&I.message||I),info:null})}})(),()=>{y=!1,m.current&&m.current.destroy()}},[t,n,a,l,S,r&&r.key,k,Te,x,o]);let le=p||1,Ae=Math.max(120,D||w.info&&Math.max(w.info.height||0,w.info.scrollHeight||0)||480),ve=Math.max(120,Math.ceil(Ae*le)),ke=d?Math.min(d,ve):ve,Pe=Math.ceil(ke/le),tt=typeof H=="string"?H:"/agent-whales/api";return s.createElement("div",{style:{position:"relative",width:Math.ceil(we*(p||1)),height:ke,overflow:"hidden",background:"#fff"}},s.createElement("iframe",{ref:u,title:c||a,style:{border:0,width:we,height:Pe,transform:"scale("+le+")",transformOrigin:"0 0",pointerEvents:T||E!=="view"?"auto":"none",display:"block"}}),w.status==="loading"?s.createElement("div",{style:{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#8a93a6",background:"rgba(255,255,255,.6)"}},"\u6C99\u7BB1\u6E32\u67D3\u4E2D\u2026"):null,w.status==="error"?s.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,border:"1px solid #dc2626",background:"#fef2f2",color:"#991b1b",borderRadius:8,padding:"6px 8px",fontSize:11,fontFamily:"ui-monospace, Consolas, monospace",maxHeight:120,overflow:"auto",whiteSpace:"pre-wrap"}},"\u6E32\u67D3\u51FA\u9519\uFF1A"+String(w.error).slice(0,400)):null,E!=="view"?s.createElement("div",{style:{position:"absolute",left:8,top:6,zIndex:2,font:"11px system-ui",padding:"3px 8px",borderRadius:999,background:"#2563eb",color:"#fff"}},E==="edit"?"\u76F4\u63A5\u6539\uFF1A\u70B9\u9009\u5143\u7D20":"\u6807\u6CE8\uFF1A\u70B9\u9009\u5143\u7D20"):null,f!==null&&E==="annotate"?s.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,zIndex:3,background:"#fff",border:"1px solid #2563eb",borderRadius:8,padding:"8px 10px",boxShadow:"0 8px 24px rgba(15,23,42,.18)",font:"12px system-ui"}},s.createElement("div",{style:{color:"#5b6577",marginBottom:4}},String(f.tag||"\u5143\u7D20")+(f.line?" \xB7 \u7B2C "+f.line+" \u884C":"")+(Number(f.count)>1?" \xB7 \u540C\u6B3E\u7B2C "+(Number(f.nth)+1)+" \u4E2A":"")),s.createElement("textarea",{autoFocus:!0,"aria-label":"\u4FEE\u6539\u610F\u89C1",onKeyDown:y=>{y.key==="Escape"&&(y.stopPropagation(),V||(v(null),J(""),q("")))},value:R,placeholder:"\u8FD9\u91CC\u8981\u600E\u4E48\u6539\uFF1F\uFF08\u4F8B\u5982\uFF1A\u6807\u9898\u592A\u5927 / \u6362\u4E2A\u989C\u8272\uFF09",onChange:y=>J(y.target.value),style:{width:"100%",boxSizing:"border-box",height:56,resize:"vertical",font:"12px system-ui",padding:6,borderRadius:6,border:"1px solid #dce2ee"}}),s.createElement("div",{style:{display:"flex",gap:6,marginTop:6,alignItems:"center"}},s.createElement("button",{type:"button",className:"daw-wb-btn",onClick:_e,disabled:V||String(R||"").trim()===""},"\u63D0\u4EA4"),s.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"ghost",disabled:V,onClick:()=>{v(null),J(""),q("")}},"\u53D6\u6D88"),s.createElement("span",{role:"status",style:{color:"#5b6577",marginLeft:"auto"}},P))):null,f===null&&E==="annotate"&&P!==""?s.createElement("div",{role:"status",style:{position:"absolute",left:8,bottom:8,maxWidth:"calc(100% - 16px)",padding:"5px 8px",borderRadius:6,background:"var(--daw-surface, #fff)",color:"var(--daw-text, #172033)",fontSize:12}},P):null,f!==null&&E==="edit"?s.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,zIndex:3,background:"#fff",border:"1px solid #2563eb",borderRadius:8,padding:"8px 10px",boxShadow:"0 8px 24px rgba(15,23,42,.18)",font:"12px system-ui",maxHeight:"80%",overflow:"auto"}},s.createElement("div",{style:{color:"#5b6577",marginBottom:4}},"\u76F4\u63A5\u6539 \xB7 "+(f.tag||"\u5143\u7D20")+(f.line?" \xB7 L"+f.line:"")),s.createElement("textarea",{value:ye,onChange:y=>be(y.target.value),placeholder:"\u4FEE\u6539\u8FD9\u4E2A\u5143\u7D20\u7684\u6587\u5B57",style:{width:"100%",boxSizing:"border-box",height:42,resize:"vertical",font:"12px system-ui",padding:6,borderRadius:6,border:"1px solid #dce2ee"}}),s.createElement("div",{style:{display:"flex",gap:6,marginTop:6}},s.createElement("button",{type:"button",className:"daw-wb-btn",onClick:()=>xe({text:ye})},"\u4FDD\u5B58\u6587\u5B57"),s.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"ghost",onClick:()=>{v(null),Z(null),U("")}},"\u53D6\u6D88")),X&&X.error?s.createElement("div",{style:{color:"#b45309",marginTop:6}},X.error):null,X&&Array.isArray(X.classes)?X.classes.map(y=>s.createElement("label",{key:y.name,style:{display:"flex",alignItems:"center",gap:6,marginTop:6}},s.createElement("span",{style:{color:"#5b6577",minWidth:70}},y.family),s.createElement("select",{value:y.name,onChange:A=>xe({fromClass:y.name,toClass:A.target.value}),style:{font:"12px system-ui",padding:4,borderRadius:6,border:"1px solid #dce2ee",maxWidth:"100%"}},[y.name].concat(X.options&&X.options[y.name]||[]).map(A=>s.createElement("option",{key:A,value:A},A))))):null,s.createElement("div",{style:{color:"#5b6577",marginTop:6}},je)):null)}function Ie(e){let t=e.data&&e.data.original||{},n=typeof t.name=="string"?t.name:"",a=typeof t.title=="string"?t.title:n,c=e.data&&e.data.projectId||e.projectId||"",l=Number.isFinite(t.examplesCount)?t.examplesCount:0,[r,b]=_(0),[p,d]=_("view"),[k,N]=_(null);Q(()=>{let u=!0;return G(c,"component",n,e.data&&e.data.token||e.token).then(m=>{u&&N(m)},()=>{}),()=>{u=!1}},[c,n]);let j=k&&k.meta&&Array.isArray(k.meta.examples)?k.meta.examples:[],S=k&&k.meta&&k.meta.tweaksSpec&&typeof k.meta.tweaksSpec=="object"?k.meta.tweaksSpec:{},o=Object.keys(S),[i,g]=_({}),x={};for(let u of o){let m=S[u]||{};if(i[u]!==void 0){x[u]=i[u];continue}if(m.default!==void 0){x[u]=m.default;continue}x[u]=m.type==="number"?Number.isFinite(m.min)?m.min:0:""}let T={key:n+"-"+r+"-"+JSON.stringify(x),props:Object.assign({},j[r]||{},o.length>0?{__tweaks:x}:{})};return s.createElement("div",{style:W.card},s.createElement("div",{style:W.head,"data-design-head":"1"},s.createElement("span",{style:{fontWeight:600}},a||n),s.createElement("span",{style:W.tag},"AI \xB7 \u7EC4\u4EF6"),s.createElement("span",{style:W.muted},n),typeof t.onEdit=="function"?s.createElement("button",{type:"button",onClick:u=>{u.stopPropagation(),t.onEdit()},className:"daw-wb-btn","data-variant":"ghost"},t.labels&&t.labels.edit||"\u7F16\u8F91"):null,s.createElement("button",{type:"button",onClick:u=>{u.stopPropagation(),d(p==="annotate"?"view":"annotate")},className:"daw-wb-btn","data-variant":"ghost","data-on":String(p==="annotate")},p==="annotate"?"\u9000\u51FA\u6807\u6CE8":t.labels&&t.labels.annotate||"\u6807\u6CE8"),s.createElement("button",{type:"button",onClick:u=>{u.stopPropagation(),d(p==="edit"?"view":"edit")},className:"daw-wb-btn","data-variant":"ghost","data-on":String(p==="edit")},p==="edit"?"\u9000\u51FA\u76F4\u63A5\u6539":t.labels&&t.labels.editDirect||"\u76F4\u63A5\u6539"),l>1?s.createElement("span",{style:{display:"flex",gap:4,marginLeft:"auto"}},Array.from({length:Math.min(l,6)},(u,m)=>s.createElement("button",{key:m,onClick:w=>{w.stopPropagation(),b(m)},className:"daw-wb-btn","data-variant":"ghost","data-on":String(m===r)},"\u4F8B\u5B50 "+(m+1)))):null),o.length>0?s.createElement("div",{style:{display:"flex",flexWrap:"wrap",gap:8,padding:"6px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:11}},o.slice(0,8).map(u=>{let m=S[u]||{},w=x[u];if(m.type==="select"){let E=Array.isArray(m.options)?m.options:[];return s.createElement("label",{key:u,style:{display:"flex",alignItems:"center",gap:4}},s.createElement("span",{style:W.muted},u),s.createElement("select",{value:String(w),onChange:h=>g(C=>Object.assign({},C,{[u]:h.target.value})),className:"daw-wb-btn","data-variant":"ghost"},E.map(h=>s.createElement("option",{key:String(h),value:String(h)},String(h)))))}let M=Number.isFinite(m.min)?m.min:0,D=Number.isFinite(m.max)?m.max:64,L=Number.isFinite(m.step)?m.step:1;return s.createElement("label",{key:u,style:{display:"flex",alignItems:"center",gap:4}},s.createElement("span",{style:W.muted},u),s.createElement("input",{type:"range",min:M,max:D,step:L,value:Number(w)||M,onChange:E=>g(h=>Object.assign({},h,{[u]:Number(E.target.value)})),style:{width:80}}),s.createElement("span",null,String(w)))})):null,s.createElement(ge,{projectId:c,kind:"component",id:n,title:a,packId:t.packId,token:e.data&&e.data.token||e.token,entry:T,exampleIndex:r,sourceHash:t.sourceHash,width:"desktop",scale:e.scale||.42,maxHeight:e.maxHeight||360,mode:p,onChanged:t.onDesignChanged}))}function Ne(e){var L,E;let t=e.data&&e.data.original||{},n=typeof t.artboardId=="string"?t.artboardId:"",a=typeof t.title=="string"?t.title:n,c=e.data&&e.data.projectId||e.projectId||"",l=e.data&&e.data.token||e.token,r=((L=e.data)==null?void 0:L.labels)||t.labels||{},[b,p]=_([]),[d,k]=_("view"),[N,j]=_(""),S=b[b.length-1],o=S?S.id:n,i=S?S.meta:t,g=i.title||(S?o:a),x=i.width==="mobile"?"mobile":"desktop",T=K(null),u=Re(T),m=e.review?Math.min(1,u/fe[x]):e.scale||.42,w=me(h=>{if(!(typeof h!="string"||h===""||h===o)){if(!Array.isArray(i.links)||!i.links.includes(h)){j("\u8FD9\u4E2A\u753B\u677F\u6CA1\u6709\u8FDE\u5230\u300C"+h+"\u300D");return}G(c,"artboard",h,l).then(C=>{if(C===null){j("\u753B\u677F\u300C"+h+"\u300D\u4E0D\u5B58\u5728");return}j(""),p(f=>{var v;return((v=f[f.length-1])==null?void 0:v.id)===h?f:[...f,{id:h,meta:C.meta||{}}]})},()=>{j("\u753B\u677F\u52A0\u8F7D\u5931\u8D25")})}},[o,i.links,c,l]);function M(h,C){h.stopPropagation(),k(f=>f===C?"view":C)}let D=(h,C)=>s.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"tool","aria-pressed":d===C,onClick:f=>M(f,C)},h);return s.createElement("div",{style:e.review?{background:"var(--daw-surface, #fff)"}:W.card},s.createElement("div",{style:e.review?{...W.head,cursor:"default",flexWrap:"wrap",whiteSpace:"normal"}:W.head,"data-design-head":"1"},s.createElement("span",{style:{fontWeight:650,flex:e.review?"1 1 95px":void 0,minWidth:0,overflowWrap:"anywhere"}},g),e.review?null:s.createElement("span",{style:W.tag},"AI \xB7 \u753B\u677F"),s.createElement("span",{style:W.muted},x==="mobile"?"\u624B\u673A":"\u684C\u9762"),!e.review&&t.requirementId?s.createElement("span",{style:W.muted},"\xB7 \u9700\u6C42 "+String(t.requirementId).slice(0,12)):null,!S&&typeof t.onEdit=="function"?s.createElement("button",{type:"button",onClick:h=>{h.stopPropagation(),t.onEdit()},className:"daw-wb-btn","data-variant":"ghost"},r.edit||"\u7F16\u8F91"):null,s.createElement("div",{className:"daw-wb-board-tools",role:"group","aria-label":r.toolGroup||"\u753B\u677F\u5DE5\u5177"},D(d==="annotate"?"\u9000\u51FA\u6807\u6CE8":r.annotate||"\u6807\u6CE8","annotate"),D(d==="edit"?"\u9000\u51FA\u76F4\u63A5\u6539":r.editDirect||"\u76F4\u63A5\u6539","edit")),b.length>0?s.createElement("button",{type:"button",onClick:h=>{h.stopPropagation(),j(""),p(C=>C.slice(0,-1))},className:"daw-wb-btn","data-variant":"ghost",title:"\u56DE\u5230\u4E0A\u4E00\u4E2A\u753B\u677F"},"\u2190 \u8FD4\u56DE ("+b.length+")"):null),N?s.createElement("div",{role:"status",style:{padding:"6px 10px",color:"var(--daw-warn, #b45309)",fontSize:12}},N):null,s.createElement("div",{ref:e.review?T:void 0,style:e.review?{display:"grid",justifyItems:"center",minWidth:0,overflow:"hidden",background:"var(--daw-surface-muted, #f5f6f8)"}:void 0},s.createElement(ge,{projectId:c,kind:"artboard",id:o,title:g,packId:i.packId||t.packId,token:l,entry:{key:o+"-0",props:{}},sourceHash:i.sourceHash,width:x,scale:m,onNavigate:w,interactive:!0,mode:d,onChanged:((E=e.data)==null?void 0:E.onDesignChanged)||t.onDesignChanged})))}function Ge(e){let t=e.delivery,n=K(null),a=Re(n),[c,l]=_([t.entryId]),r=t.boards.find(d=>d.id===c[c.length-1]),b=Je(()=>r&&{code:r.code,deps:r.dependencies.map(d=>({name:d,code:t.modules[d]}))},[r,t]);if(Q(()=>{r&&typeof e.onBoardChange=="function"&&e.onBoardChange(r.id)},[r,e.onBoardChange]),!r)return null;let p=Math.min(1,a/fe[r.width==="mobile"?"mobile":"desktop"]);return s.createElement("div",{ref:n,style:{display:"grid",justifyItems:"center",minWidth:0,overflow:"hidden"}},c.length>1?s.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"ghost",onClick:()=>l(d=>d.slice(0,-1))},e.backLabel||"\u8FD4\u56DE\u4E0A\u4E00\u5C4F"):null,s.createElement(ge,{projectId:t.projectId,kind:"artboard",id:r.id,title:r.title,packId:t.packId,width:r.width,scale:p,interactive:!0,snapshot:b,onNavigate:d=>{d!==r.id&&r.links.includes(d)&&t.boards.some(k=>k.id===d)&&l(k=>[...k,d])}}))}function Ke(e,t,n){let a=n||{};Q(()=>{if(typeof e!="string"||e===""||typeof t!="string"||t==="")return;let c=!0,l=null,r=document.createElement("div");r.style.cssText="position:fixed;left:-10000px;top:0;width:1024px;height:800px;overflow:hidden",document.body.appendChild(r);let b=document.createElement("iframe");b.style.cssText="width:1024px;height:800px;border:0",r.appendChild(b);let p=null,d=null;async function k(){return p!==null?p:(d!==null||(p=ce(b,{title:"whales-design-live"}),d=(async()=>{let[o,i]=await Promise.all([se(),ie(a.packId)]);return p.init({runtime:o,styles:i.styles,bundle:i.bundle})})()),d)}async function N(o){let i=o.target||{},g=i.type==="artboard"?"artboard":"component",x=g==="artboard"?i.artboardId:i.name;try{await k();let T=await de(e,g,x,0,t);if(T===null||T.code===""){await j({requestId:o.requestId,ok:!1,error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269"});return}let u=await G(e,g,x,t),m=u&&u.meta&&Array.isArray(u.meta.examples)?u.meta.examples:[],w=await p.render({name:x,code:T.code,props:m[Number(o.exampleIndex)||0]||{},dependencies:(T.deps||[]).map(M=>({name:M.name,code:M.code}))});await j({requestId:o.requestId,ok:w.ok!==!1,error:w.error||"",consoleErrors:w.consoleErrors||[],ms:w.ms,width:w.width,height:w.height,nodeCount:w.nodeCount,textLength:w.textLength,textSample:w.textSample,empty:w.empty,buttons:w.buttons,inputs:w.inputs,tables:w.tables})}catch(T){await j({requestId:o.requestId,ok:!1,error:String(T&&T.message||T)})}}async function j(o){try{await fetch(H+"/design/live/result",{method:"POST",headers:{"content-type":"application/json","x-whales-token":t},body:JSON.stringify(o)})}catch{}}async function S(){if(c){try{let o=await fetch(H+"/design/live?projectId="+encodeURIComponent(e),{headers:{"x-whales-token":t}});if(o.ok){let i=await o.json(),g=i&&i.data&&Array.isArray(i.data.requests)?i.data.requests:[];for(let x of g)await N(x)}}catch{}c&&(l=setTimeout(S,4e3))}}return S(),()=>{c=!1,l&&clearTimeout(l),p&&p.destroy(),r.remove()}},[e,t,a.packId])}async function Ye(e){let t=e&&e.data||{},n=e&&e.projectId?e.projectId:"",a=e.kind==="artboard"?"artboard":"component",c=a==="artboard"?t.artboardId:t.name,l=typeof e.token=="string"?e.token:"",[r,b,p]=await Promise.all([G(n,a,c,l),se().catch(()=>""),ie(t.packId).catch(()=>({styles:"",bundle:""}))]),d=document.createElement("div");d.style.cssText="position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px";let k=document.createElement("div");k.style.cssText="width:min(1280px,97vw);height:min(860px,94vh);background:#fff;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.35)";let N=document.createElement("div");N.style.cssText="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #dce2ee;font:13px system-ui";let j=document.createElement("b");j.textContent=r&&r.meta&&r.meta.title||c;let S=document.createElement("span");S.style.color="#8a93a6",S.textContent=c+".tsx",N.append(j,S);let o=document.createElement("span");o.style.cssText="margin-left:12px;font:11px system-ui;color:#8a93a6",N.appendChild(o);let i=document.createElement("button");i.textContent="\u89E3\u9501\u8BA9 AI \u7EE7\u7EED\u6539",i.style.cssText="margin-left:auto;font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer;display:none",N.appendChild(i);let g=document.createElement("button");g.textContent="\u4FDD\u5B58",g.style.cssText="font:12px system-ui;padding:4px 12px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer",N.appendChild(g);let x=document.createElement("button");x.textContent="\u5173\u95ED",x.style.cssText="font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer",x.onclick=()=>d.remove(),N.appendChild(x);let T=document.createElement("div");T.style.cssText="flex:1;display:flex;min-height:0";let u=document.createElement("div");u.style.cssText="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid #dce2ee";let m=document.createElement("textarea");m.spellcheck=!1,m.value=r?r.source:"",m.style.cssText="flex:1;width:100%;border:0;outline:none;resize:none;padding:14px;font:12px/1.6 ui-monospace,Consolas,monospace;background:#fbfcfe;color:#1e2430;tab-size:2",u.appendChild(m);let w=document.createElement("div");w.style.cssText="width:min(560px,46%);display:flex;flex-direction:column;min-width:0;background:#f6f8fb";let M=document.createElement("iframe");M.setAttribute("sandbox","allow-scripts"),M.setAttribute("srcdoc",ae({title:"\u6E90\u7801\u9884\u89C8"})),M.style.cssText="flex:1;width:100%;border:0;background:#fff",w.appendChild(M),T.append(u,w);let D=document.createElement("div");D.style.cssText="display:none;padding:8px 12px;border-top:1px solid #fecaca;background:#fef2f2;color:#991b1b;font:11px/1.6 ui-monospace,Consolas,monospace;max-height:120px;overflow:auto;white-space:pre-wrap",k.append(N,T,D),d.appendChild(k),document.body.appendChild(d),d.addEventListener("click",v=>{v.target===d&&d.remove()});let L=null,E=r&&r.compiledCode||"";try{L=ce(M,{title:"\u6E90\u7801\u9884\u89C8"}),await L.init({runtime:b,styles:p.styles||"",bundle:p.bundle||""})}catch(v){o.textContent="\u6C99\u7BB1\u521D\u59CB\u5316\u5931\u8D25\uFF1A"+String(v&&v.message||v)}let h=null,C=0;async function f(v){let R=++C;g.disabled=!0,o.textContent="\u7F16\u8BD1\u4E2D\u2026";try{let P=await(await fetch(H+"/design/compile",{method:"POST",headers:{"content-type":"application/json","x-whales-token":l},body:JSON.stringify({projectId:n,kind:a,name:a==="component"?c:void 0,artboardId:a==="artboard"?c:void 0,source:v})})).json();if(R!==C)return;if(!P||P.code!==200||!P.data||P.data.compile&&P.data.compile.ok===!1){let q=P&&P.data&&P.data.compile&&P.data.compile.errors?P.data.compile.errors:[];D.style.display="block",D.textContent=q.length>0?q.map(V=>V.message).join(`
`):String(P&&P.msg||"\u7F16\u8BD1\u5931\u8D25"),o.textContent="\u7F16\u8BD1\u5931\u8D25",g.disabled=!1;return}D.style.display="none",E=P.data.compiled||E,o.textContent="\u7F16\u8BD1\u901A\u8FC7",g.disabled=!1,L!==null&&await L.render({name:c,code:E,props:r&&r.meta&&r.meta.examples&&r.meta.examples[0]||{},isBoard:a==="artboard"})}catch(J){if(R!==C)return;D.style.display="block",D.textContent="\u7F16\u8BD1\u8BF7\u6C42\u5931\u8D25\uFF1A"+String(J&&J.message||J),g.disabled=!1}}if(m.addEventListener("input",()=>{h&&clearTimeout(h),h=setTimeout(()=>f(m.value),500)}),g.onclick=async()=>{o.textContent="\u4FDD\u5B58\u4E2D\u2026";try{let R=await(await fetch(H+"/design/source",{method:"POST",headers:{"content-type":"application/json","x-whales-token":l},body:JSON.stringify({projectId:n,kind:a,name:a==="component"?c:void 0,artboardId:a==="artboard"?c:void 0,source:m.value})})).json();R&&R.code===200&&R.data&&R.data.written===!0?(o.textContent="\u5DF2\u4FDD\u5B58\uFF08agent \u4E4B\u540E\u4E0D\u80FD\u6539\u8FD9\u4E2A\u4E86\uFF09",pe(n,a,c),i.style.display=""):o.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(R&&R.msg||"\u672A\u77E5\u9519\u8BEF")}catch(v){o.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(v&&v.message||v)}},i.onclick=async()=>{o.textContent="\u89E3\u9501\u4E2D\u2026";try{let R=await(await fetch(H+"/design/unlock",{method:"POST",headers:{"content-type":"application/json","x-whales-token":l},body:JSON.stringify({projectId:n,kind:a,name:a==="component"?c:void 0,artboardId:a==="artboard"?c:void 0})})).json();o.textContent=R&&R.code===200&&R.data&&R.data.unlocked?"\u5DF2\u89E3\u9501\uFF0CAI \u53EF\u4EE5\u7EE7\u7EED\u6539":"\u89E3\u9501\u5931\u8D25\uFF1A"+String(R&&R.msg||""),i.style.display="none"}catch(v){o.textContent="\u89E3\u9501\u5931\u8D25\uFF1A"+String(v&&v.message||v)}},r&&r.userEdited===!0&&(i.style.display=""),E!==""&&L!==null)try{await L.render({name:c,code:E,props:r&&r.meta&&r.meta.examples&&r.meta.examples[0]||{},isBoard:a==="artboard"})}catch{}return{close:()=>d.remove()}}var Qe={component:Ie,artboard:Ne},Ze="";

return module.exports;
} });

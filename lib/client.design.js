/* dsh-agent-whales · client.design.js —— 由 tools/flow-chunk/build-design.mjs 生成，勿手改。
 * 组件工坊：组件 / 画板节点的沙箱预览与在线画布登记。只在画布上出现这两种节点时按需加载。 */
window.__ModuleLoader__.load({ id: "dsh-agent-whales", chunk: "client.design.js", factory: function (require) {
var module = { exports: {} }; var exports = module.exports;
var We=Object.create;var re=Object.defineProperty;var qe=Object.getOwnPropertyDescriptor;var Fe=Object.getOwnPropertyNames;var Ue=Object.getPrototypeOf,Je=Object.prototype.hasOwnProperty;var $e=(e,t)=>{for(var n in t)re(e,n,{get:t[n],enumerable:!0})},Se=(e,t,n,o)=>{if(t&&typeof t=="object"||typeof t=="function")for(let i of Fe(t))!Je.call(e,i)&&i!==n&&re(e,i,{get:()=>t[i],enumerable:!(o=qe(t,i))||o.enumerable});return e};var Xe=(e,t,n)=>(n=e!=null?We(Ue(e)):{},Se(t||!e||!e.__esModule?re(n,"default",{value:e,enumerable:!0}):n,e)),Ve=e=>Se(re({},"__esModule",{value:!0}),e);var st={};$e(st,{DESIGN_CSS:()=>at,DesignArtboardNode:()=>_e,DesignChatPreview:()=>tt,DesignComponentNode:()=>Pe,SANDBOX_CSP:()=>oe,createSandboxHost:()=>ue,designNodeTypes:()=>ot,invalidateEntity:()=>he,loadCompiled:()=>me,loadEntity:()=>Y,loadPackText:()=>de,loadRuntimeText:()=>le,openSourceEditor:()=>rt,sandboxSrcdoc:()=>ae,useDesignLive:()=>nt});module.exports=Ve(st);var r=Xe(require("react"),1),Me=require("react-dom");function Ge(e){let t=e||{},n=String(t.csp||"default-src 'none'"),o=Ie(String(t.title||"whales-design-sandbox"));return`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${n}">
<meta name="whales-boot-id" content="${Ie(String(t.bootId||""))}">
<title>${o}</title>
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
<script>${Ke}<\/script>
</body></html>`}var Ke=String.raw`
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
    var previous = state.mounts[label];
    if (previous) { previous.root.unmount(); delete state.mounts[label]; }
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
      // React 已 flushSync 提交。离屏 iframe 的 rAF 可能被暂停，计时器兜底，且只回报一次。
      var reported = false;
      var reportTimer = setTimeout(finishRender, 100);
      var reportNonce = nonce;
      var frameId = 0;
      function finishRender() {
          if (reported || nonce !== reportNonce) return;
          reported = true;
          clearTimeout(reportTimer);
          cancelAnimationFrame(frameId);
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
      }
      frameId = requestAnimationFrame(function () { frameId = requestAnimationFrame(finishRender); });
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
`,oe="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";function ae(e){return Ge(Object.assign({csp:oe},e||{}))}function Ie(e){let t={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"};return String(e).replace(/[&<>"]/g,n=>t[n])}var{useCallback:ge,useEffect:K,useMemo:Ye,useRef:q,useState:M}=r,W="/agent-whales/api",Qe=`var t=require("react/jsx-runtime"),d=(...e)=>e.filter(Boolean).join(" ");var i={default:"border-transparent bg-primary text-primary-foreground shadow",secondary:"border-transparent bg-secondary text-secondary-foreground",outline:"text-foreground",destructive:"border-transparent bg-destructive text-destructive-foreground shadow"},c={info:"bg-background text-foreground",success:"border-emerald-500/50 text-emerald-700 bg-emerald-50",warning:"border-amber-500/50 text-amber-800 bg-amber-50",error:"border-destructive/50 text-destructive bg-red-50"},o="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",x="text-sm font-medium leading-none";var m={default:"bg-primary text-primary-foreground shadow hover:bg-primary/90",primary:"bg-primary text-primary-foreground shadow hover:bg-primary/90",secondary:"bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",outline:"border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",ghost:"hover:bg-accent hover:text-accent-foreground",destructive:"bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"},g="rounded-lg border bg-background text-foreground shadow-sm",h=({className:e,children:r,header:a,footer:l,...n})=>(0,t.jsxs)("div",{className:d(g,e),...n,children:[a?(0,t.jsx)("div",{className:"flex flex-col gap-1 p-5 pb-2",children:a}):null,(0,t.jsx)("div",{className:"p-5",children:r}),l?(0,t.jsx)("div",{className:"flex items-center p-5 pt-0",children:l}):null]}),u={Button:({variant:e="default",className:r,children:a,...l})=>(0,t.jsx)("button",{type:"button",className:d("inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors",m[e]||m.default,r),...l,children:a}),Input:({className:e,...r})=>(0,t.jsx)("input",{className:d(o,e),...r}),Textarea:({className:e,rows:r=3,...a})=>(0,t.jsx)("textarea",{rows:r,className:d(o,"min-h-[72px] h-auto py-2",e),...a}),Select:({options:e,className:r,...a})=>{let l=(Array.isArray(e)?e:[]).map(n=>{let s=n&&n.value!==void 0?n.value:n,f=n&&n.label!==void 0?n.label:String(s);return{value:String(s),text:String(f)}});return(0,t.jsx)("select",{className:d(o,r),...a,children:l.map(n=>(0,t.jsx)("option",{value:n.value,children:n.text},n.value))})},Label:({className:e,children:r,...a})=>(0,t.jsx)("label",{className:d(x,e),...a,children:r}),Badge:({variant:e="default",className:r,children:a,...l})=>(0,t.jsx)("span",{className:d("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",i[e]||i.default,r),...l,children:a}),Card:h,CardHeader:({className:e,children:r})=>(0,t.jsx)("div",{className:d("flex flex-col gap-1 p-5 pb-2",e),children:r}),CardTitle:({className:e,children:r})=>(0,t.jsx)("div",{className:d("text-lg font-semibold leading-none tracking-tight",e),children:r}),CardDescription:({className:e,children:r})=>(0,t.jsx)("div",{className:d("text-sm text-muted-foreground",e),children:r}),CardContent:({className:e,children:r})=>(0,t.jsx)("div",{className:d("p-5",e),children:r}),Separator:({className:e})=>(0,t.jsx)("hr",{className:d("my-2 border-border",e)}),Alert:({tone:e="info",title:r,children:a,className:l})=>(0,t.jsxs)("div",{role:"alert",className:d("relative w-full rounded-lg border p-4 text-sm",c[e]||c.info,l),children:[r?(0,t.jsx)("div",{className:"mb-1 font-medium",children:r}):null,a?(0,t.jsx)("div",{children:a}):null]}),Table:({columns:e,rows:r,rowKey:a})=>(0,t.jsx)("div",{className:"w-full overflow-auto rounded-lg border",children:(0,t.jsxs)("table",{className:"w-full caption-bottom text-sm",children:[(0,t.jsx)("thead",{children:(0,t.jsx)("tr",{className:"border-b bg-muted/50",children:(e||[]).map(l=>(0,t.jsx)("th",{className:"h-10 px-3 text-left align-middle font-medium text-muted-foreground",children:l.header},l.key))})}),(0,t.jsx)("tbody",{children:(r||[]).map((l,n)=>(0,t.jsx)("tr",{className:"border-b transition-colors hover:bg-muted/50",children:(e||[]).map(s=>(0,t.jsx)("td",{className:"p-3 align-middle",children:typeof s.render=="function"?s.render(l):String(l[s.key]===void 0?"":l[s.key])},s.key))},typeof a=="function"?a(l,n):n))})]})}),Tabs:({items:e,value:r,onChange:a})=>(0,t.jsxs)("div",{className:"flex flex-col gap-3",children:[(0,t.jsx)("div",{className:"flex gap-1 border-b",children:(e||[]).map(l=>(0,t.jsx)("button",{type:"button",onClick:()=>{typeof a=="function"&&a(l.key)},className:d("px-3 py-2 text-sm font-medium",l.key===r?"border-b-2 border-primary text-foreground":"text-muted-foreground hover:text-foreground"),children:l.label},l.key))}),(0,t.jsx)("div",{children:(e||[]).filter(l=>l.key===r).map(l=>(0,t.jsx)("div",{children:l.content},l.key))})]}),Switch:({checked:e,onChange:r,className:a})=>(0,t.jsx)("button",{type:"button",role:"switch","aria-checked":!!e,onClick:()=>{typeof r=="function"&&r(!e)},className:d("relative inline-flex h-5 w-9 items-center rounded-full transition-colors",e?"bg-primary":"bg-input",a),children:(0,t.jsx)("span",{className:d("block size-4 rounded-full bg-background shadow transition-transform",e?"translate-x-4":"translate-x-0.5")})}),Checkbox:({checked:e,onChange:r,className:a,...l})=>(0,t.jsx)("input",{type:"checkbox",checked:!!e,onChange:n=>{typeof r=="function"&&r(n.target.checked)},className:d("size-4 rounded border-input accent-primary",a),...l}),EmptyState:({title:e="\\u8FD8\\u6CA1\\u6709\\u6570\\u636E",hint:r,className:a})=>(0,t.jsxs)("div",{className:d("flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-8 text-center",a),children:[(0,t.jsx)("div",{className:"text-sm font-medium text-foreground",children:e}),r?(0,t.jsx)("div",{className:"text-xs text-muted-foreground",children:r}):null]}),Progress:({value:e=0,className:r})=>(0,t.jsx)("div",{className:d("h-2 w-full overflow-hidden rounded-full bg-muted",r),children:(0,t.jsx)("div",{className:"h-full bg-primary transition-all",style:{width:Math.max(0,Math.min(100,Number(e)||0))+"%"}})}),Avatar:({name:e="",className:r})=>(0,t.jsx)("span",{className:d("inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground",r),children:String(e).trim().slice(0,1)||"?"}),Title:({level:e=2,className:r,children:a})=>(0,t.jsx)("h"+(Number(e)>=1&&Number(e)<=6?e:2),{className:d("font-semibold tracking-tight",r),children:a}),Text:({tone:e="default",className:r,children:a})=>(0,t.jsx)("p",{className:d("text-sm leading-7",e==="muted"?"text-muted-foreground":"text-foreground",r),children:a}),Stack:({gap:e=3,className:r,children:a})=>(0,t.jsx)("div",{className:d("flex flex-col",e===1?"gap-1":e===2?"gap-2":e===4?"gap-4":"gap-3",r),children:a}),Row:({gap:e=2,className:r,children:a})=>(0,t.jsx)("div",{className:d("flex flex-row items-center",e===1?"gap-1":e===3?"gap-3":e===4?"gap-4":"gap-2",r),children:a})};module.exports=u;
`,Ze=`*, ::before, ::after {
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
`,se=new Map,ie=new Map;function ce(e,t){let n=new AbortController,o=setTimeout(()=>n.abort(),12e3);return fetch(e,{...t,signal:n.signal}).then(async i=>{if(!i.ok)throw new Error("\u8BBE\u8BA1\u8D44\u6E90\u52A0\u8F7D\u5931\u8D25\uFF08"+i.status+"\uFF09");return e.includes("/design/source?")?i.json():i.text()}).catch(i=>{throw n.signal.aborted?new Error("\u8BBE\u8BA1\u8D44\u6E90\u52A0\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u6E32\u67D3"):i}).finally(()=>clearTimeout(o))}function le(){let e="runtime";if(se.has(e))return se.get(e);let t=ce(W+"/design/runtime.js");return se.set(e,t),t.catch(()=>se.delete(e)),t}function de(e){let t=typeof e=="string"&&e!==""?e:"shadcn";if(ie.has(t))return ie.get(t);let n=W+"/component-packs/"+encodeURIComponent(t),o=(async()=>{if(t==="shadcn")return{bundle:Qe,styles:Ze,api:null,builtin:!0};let[i,h]=await Promise.all([ce(n+"/bundle.js"),ce(n+"/styles.css")]);return{bundle:i,styles:h,api:null,builtin:!1}})();return ie.set(t,o),o.catch(()=>ie.delete(t)),o}var Ne=0;function fe(){Ne+=1;let e=new Uint8Array(16);if(typeof crypto!="undefined"&&typeof crypto.getRandomValues=="function")crypto.getRandomValues(e);else for(let t=0;t<e.length;t+=1)e[t]=Math.floor(Math.random()*256);return Array.from(e,t=>t.toString(16).padStart(2,"0")).join("")+"-"+Ne}function ue(e,t){let n=t||{},o="",i=!1,h=!1,c=!1,w=null,v=null,p=null,S=new Set,b=fe(),a=n.timeoutMs||8e3;function g(d,m){return new Promise(I=>{let C=setTimeout(()=>R({ok:!1,timeout:!0,error:m}),a);S.add(C);function R(f){clearTimeout(C),S.delete(C),I(f)}d(R)})}let u=d=>{var I,C,R,f;if(h||d.origin!=="null")return;let m=d.data||{};if(m.type==="booted"){m.bootId===b&&(c=!0,w&&w({ok:!0}));return}if(m.nonce===o){if(m.type==="ready"){i=!0,v&&v(m.info||{});return}if(m.type==="rendered"){if(p){let y=p;p=null,y(m)}return}if(m.type==="resize"){(I=n.onResize)==null||I.call(n,m.height);return}if(m.type==="pick"){(C=n.onPick)==null||C.call(n,m.pick);return}if(m.type==="navigate"){(R=n.onNavigate)==null||R.call(n,m.to);return}if(m.type==="error"){let y={ok:!1,error:m.message||"\u6C99\u7BB1\u6267\u884C\u5931\u8D25"};!i&&v&&v(y),p&&(p(y),p=null),(f=n.onError)==null||f.call(n,m)}}};window.addEventListener("message",u),e.setAttribute("sandbox","allow-scripts"),e.setAttribute("srcdoc",ae({csp:oe,title:n.title||"whales-design",bootId:b}));async function k(d){if(h)return{ok:!1,cancelled:!0};if(!c){let m=await g(I=>{w=I},"\u6C99\u7BB1\u542F\u52A8\u8D85\u65F6");if(w=null,!m.ok||h)return m}return o=fe(),g(m=>{v=m,e.contentWindow.postMessage({type:"init",nonce:o,runtime:d.runtime,styles:d.styles,packCode:d.bundle},"*")},"\u6C99\u7BB1\u521D\u59CB\u5316\u8D85\u65F6")}function l(d){return h||!i?Promise.resolve({ok:!1,error:"\u6C99\u7BB1\u8FD8\u6CA1\u5C31\u7EEA"}):(p&&p({ok:!1,cancelled:!0}),o=fe(),g(m=>{p=m,e.contentWindow.postMessage({type:"render",nonce:o,runId:d.runId||"run-"+Date.now(),mountId:d.mountId||"main",name:d.name,code:d.code,props:d.props||{},dependencies:d.dependencies||[],isBoard:d.isBoard===!0},"*")},"\u6E32\u67D3\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u6E32\u67D3"))}return{init:k,render:l,setPickMode:function(d){i&&!h&&e.contentWindow.postMessage({type:"pick-mode",nonce:o,enabled:!!d},"*")},destroy:function(){h=!0,window.removeEventListener("message",u);for(let d of[w,v,p])d&&d({ok:!1,cancelled:!0});for(let d of S)clearTimeout(d);S.clear()},isReady:function(){return i&&!h}}}var X=new Map,et=20*1e3;function Y(e,t,n,o){let i=e+"|"+t+"|"+n+"|"+(typeof o=="string"?o:""),h=X.get(i);if(h!==void 0&&Date.now()-h.at<et)return h.pending;let c="?projectId="+encodeURIComponent(e)+"&kind="+t+"&id="+encodeURIComponent(n),w=typeof o=="string"&&o!==""?{"x-whales-token":o}:{},v=ce(W+"/design/source"+c,{headers:w}).then(p=>!p||p.code!==200?null:p.data);return X.set(i,{at:Date.now(),pending:v}),v.catch(()=>{let p=X.get(i);p!==void 0&&p.pending===v&&X.delete(i)}),v}function he(e,t,n){for(let o of Array.from(X.keys()))o.indexOf(e+"|"+t+"|"+n+"|")===0&&X.delete(o)}async function me(e,t,n,o,i,h=[]){let c=t+":"+n;if(h.includes(c))throw new Error("\u7EC4\u4EF6\u5B58\u5728\u5FAA\u73AF\u4F9D\u8D56\uFF1A"+h.concat(c).join(" \u2192 "));let w=await Y(e,t,n,i);if(w===null)return null;let v=w.meta&&Array.isArray(w.meta.imports)?w.meta.imports:[],p=await Promise.all(v.map(b=>me(e,"component",b,o+1,i,h.concat(c)))),S=new Map;for(let b of p){if(!b)throw new Error("\u62FF\u4E0D\u5230\u4F9D\u8D56\u7EC4\u4EF6\u7684\u7F16\u8BD1\u4EA7\u7269");for(let a of b.deps)S.set(a.name,a);S.set(b.name,{name:b.name,code:b.code})}return{name:n,code:w.compiledCode||"",deps:Array.from(S.values()),meta:w.meta,source:w.source}}var U={card:{background:"var(--daw-surface, #fff)",border:"1px solid var(--daw-border, #dce2ee)",borderRadius:12,boxShadow:"0 6px 18px rgba(0,0,0,.06)",overflow:"hidden"},head:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:12,cursor:"grab",whiteSpace:"nowrap"},tag:{fontSize:10,padding:"2px 6px",borderRadius:999,background:"var(--daw-accent-bg, #f9effa)",color:"var(--daw-accent, #c05bd0)",fontWeight:600},muted:{color:"var(--daw-text-muted, #8a93a6)"}},te={mobile:390,desktop:1024};function Te(e,t){let[n,o]=M(560);return K(()=>{let i=e.current;if(!i)return;function h(){i.clientWidth>0&&o(i.clientWidth)}if(h(),typeof ResizeObserver=="undefined")return;let c=new ResizeObserver(h);return c.observe(i),()=>c.disconnect()},[e,t]),n}function je(e,t){var b;let n=(b=e.data)==null?void 0:b.frameSize,[o,i]=M(()=>({w:(n==null?void 0:n.w)>0?n.w:t,h:(n==null?void 0:n.h)>0?n.h:0})),h=q(null),c=q(null),w=q(o);w.current=o;let v=!e.review;function p(a){var g,u;i(a),w.current=a,(u=(g=e.data)==null?void 0:g.onFrameResize)==null||u.call(g,a.w,a.h)}let S=v?r.createElement("button",{type:"button",className:"nodrag nopan","aria-label":"\u8C03\u6574\u8BBE\u8BA1\u56FE\u5916\u6846\u5927\u5C0F",title:"\u62D6\u62FD\u8C03\u6574\u5927\u5C0F\uFF1B\u65B9\u5411\u952E\u5FAE\u8C03",style:{position:"absolute",right:0,bottom:0,width:22,height:22,padding:0,border:0,borderRadius:"6px 0 10px 0",background:"var(--daw-surface, #fff)",color:"#64748b",cursor:"nwse-resize",touchAction:"none",zIndex:4},onPointerDown:a=>{if(a.button!==0)return;a.preventDefault(),a.stopPropagation();let g=h.current,u=g.getBoundingClientRect();c.current={x:a.clientX,y:a.clientY,w:g.offsetWidth,h:g.offsetHeight,zoom:u.width/g.offsetWidth||1},a.currentTarget.setPointerCapture(a.pointerId)},onPointerMove:a=>{let g=c.current;if(!g)return;a.stopPropagation();let u={w:Math.round(Math.max(280,Math.min(2400,g.w+(a.clientX-g.x)/g.zoom))),h:Math.round(Math.max(180,Math.min(2400,g.h+(a.clientY-g.y)/g.zoom)))};w.current=u,i(u)},onPointerUp:a=>{c.current&&(a.stopPropagation(),c.current=null,p(w.current),a.currentTarget.releasePointerCapture(a.pointerId))},onLostPointerCapture:()=>{c.current&&(c.current=null,p(w.current))},onPointerCancel:()=>{c.current&&(c.current=null,p(w.current))},onKeyDown:a=>{if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(a.key))return;a.preventDefault(),a.stopPropagation();let g=h.current,u=a.shiftKey?40:10;p({w:Math.max(280,Math.min(2400,g.offsetWidth+(a.key==="ArrowRight"?u:a.key==="ArrowLeft"?-u:0))),h:Math.max(180,Math.min(2400,g.offsetHeight+(a.key==="ArrowDown"?u:a.key==="ArrowUp"?-u:0)))})}},"\u25E2"):null;return{frame:h,handle:S,width:o.w,style:v?{...U.card,position:"relative",display:"flex",flexDirection:"column",boxSizing:"border-box",width:o.w,height:o.h||void 0}:{background:"var(--daw-surface, #fff)"}}}function Ae(e,t){for(let n of Array.from(X.keys()))n.startsWith(e+"|")&&X.delete(n);t(n=>n+1)}function ye(e){let{projectId:t,kind:n,id:o,title:i,packId:h,entry:c,width:w,scale:v,maxHeight:p,exampleIndex:S,onReport:b,onNavigate:a,sourceHash:g,token:u,mode:k,onChanged:l,snapshot:d,interactive:m,renderRevision:I}=e,C=q(null),R=q(null),[f,y]=M({status:"loading",error:"",info:null}),[B,D]=M(0),j=k==="edit"||k==="annotate"?k:"view",z=q(j);z.current=j;let L=q(a);L.current=a;let[s,E]=M(null),[A,T]=M(""),[Q,J]=M(""),[ee,be]=M(!1),[V,ne]=M(null),[we,xe]=M(""),[Be,$]=M(""),[Oe,ve]=M(0),ke=te[w==="mobile"?"mobile":"desktop"];K(()=>{let x=R.current;x!==null&&typeof x.setPickMode=="function"&&x.setPickMode(j!=="view"),E(null),ne(null),J(""),$("")},[j,o]);let De=ge(async()=>{if(s===null||ee)return;let x=String(A||"").trim();if(x!==""){be(!0),J("\u63D0\u4EA4\u4E2D\u2026");try{let _=await(await fetch(W+"/design/comments?projectId="+encodeURIComponent(t),{method:"POST",headers:{"content-type":"application/json","x-whales-token":u||""},body:JSON.stringify({target:(n==="artboard"?"board:":"comp:")+o,wsrc:s.wsrc,line:s.line,column:s.column,tag:s.tag,nth:s.nth,count:s.count,body:x,sourceSnippet:s.sourceSnippet})})).json();_&&_.code===200?(J(_.data&&_.data.delivered==="sent"?"\u6807\u6CE8\u5DF2\u4FDD\u5B58\u5E76\u53D1\u9001":"\u6807\u6CE8\u5DF2\u4FDD\u5B58\uFF0C\u9001\u8FBE\u5F85\u786E\u8BA4"),E(null),T("")):J("\u5931\u8D25\uFF1A"+String(_&&_.msg||"\u672A\u77E5\u9519\u8BEF"))}catch(P){J("\u5931\u8D25\uFF1A"+String(P&&P.message||P))}finally{be(!1)}}},[s,A,ee,t,n,o,u]),Ee=ge(async x=>{if(s===null||!s.wsrc){$("\u8FD9\u4E2A\u5143\u7D20\u6CA1\u6709\u6E90\u7801\u951A\u70B9\uFF0C\u8BF7\u7528\u6807\u6CE8\u8BA9 AI \u6539");return}$("\u4FDD\u5B58\u4E2D\u2026");try{let _=await(await fetch(W+"/design/edit?projectId="+encodeURIComponent(t),{method:"POST",headers:{"content-type":"application/json","x-whales-token":u||""},body:JSON.stringify(Object.assign({kind:n,name:n==="component"?o:void 0,artboardId:n==="artboard"?o:void 0,wsrc:s.wsrc},x))})).json();_&&_.code===200?($("\u5DF2\u4FDD\u5B58\u5E76\u91CD\u65B0\u6E32\u67D3"),he(t,n,o),ve(N=>N+1),typeof l=="function"&&l()):$("\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(_&&_.msg||"\u672A\u77E5\u9519\u8BEF"))}catch(P){$("\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(P&&P.message||P))}},[s,t,n,o,u,l]);K(()=>{let x=!0,P=C.current;if(!P)return;y({status:"loading",error:"",info:null}),D(0);let _=ue(P,{title:i,onResize:N=>{x&&Number.isFinite(N)&&N>0&&D(Math.min(2e4,N))},onError:()=>{},onNavigate:N=>{var F;return(F=L.current)==null?void 0:F.call(L,N)},onPick:N=>{!x||!N||Y(t,n,o,u).then(F=>{if(!x||z.current==="view")return;let H=(F&&Array.isArray(F.jsxTable)?F.jsxTable:[]).filter(O=>O&&O.wsrc===N.wsrc)[0],G={wsrc:N.wsrc||"",line:H?H.line:0,column:H?H.column:0,tag:N.tag||H&&H.tag||"",nth:N.nth||0,count:N.count||1,text:N.text||"",sourceSnippet:H&&H.snippet||""};if(E(G),J(""),$(""),z.current==="edit"){if(xe(G.text||""),ne(null),!G.wsrc){$("\u8FD9\u4E2A\u5143\u7D20\u6CA1\u6709\u6E90\u7801\u951A\u70B9\uFF0C\u8BF7\u7528\u6807\u6CE8\u8BA9 AI \u6539");return}fetch(W+"/design/classes?projectId="+encodeURIComponent(t)+"&kind="+n+"&id="+encodeURIComponent(o)+"&wsrc="+encodeURIComponent(G.wsrc),{headers:{"x-whales-token":u||""}}).then(O=>O.json()).then(O=>{x&&ne(O&&O.code===200?O.data:{error:O&&O.msg||"\u8BFB\u53D6\u5143\u7D20\u5931\u8D25"})}).catch(O=>{x&&$(String(O&&O.message||O))})}},()=>{})}});return R.current=_,(async()=>{try{let[N,F]=await Promise.all([Promise.all([le(),de(h)]).then(([H,G])=>x?_.init({runtime:H,styles:G.styles,bundle:G.bundle}):{cancelled:!0}),d||me(t,n,o,0,u)]);if(!x)return;if(N&&(N.timeout||N.ok===!1)){y({status:"error",error:N.error||"\u6C99\u7BB1\u521D\u59CB\u5316\u5931\u8D25",info:null});return}if(!x)return;if(F===null||F.code===""){y({status:"error",error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269\uFF08\u6E90\u7801\u53EF\u80FD\u8FD8\u6CA1\u4FDD\u5B58\uFF09",info:N});return}let Z=await _.render({name:o,code:F.code,props:c&&c.props||{},dependencies:(F.deps||[]).map(H=>({name:H.name,code:H.code})),isBoard:n==="artboard"});if(!x)return;Z.ok&&_.setPickMode(z.current!=="view"),y({status:Z.ok?"ok":"error",error:Z.error||"",info:Z}),typeof b=="function"&&b(Z)}catch(N){x&&y({status:"error",error:String(N&&N.message||N),info:null})}})(),()=>{x=!1,_.destroy(),R.current===_&&(R.current=null)}},[t,n,o,h,g,c&&c.key,S,Oe,d,u,I]);function ze(){if(!d)for(let x of Array.from(X.keys()))x.startsWith(t+"|")&&X.delete(x);ve(x=>x+1)}let pe=v||1,Le=Math.max(120,B||f.info&&Math.max(f.info.height||0,f.info.scrollHeight||0)||480),Re=Math.max(120,Math.ceil(Le*pe)),Ce=p?Math.min(p,Re):Re,He=Math.ceil(Ce/pe),it=typeof W=="string"?W:"/agent-whales/api";return r.createElement("div",{style:{position:"relative",width:Math.ceil(ke*(v||1)),height:Ce,overflow:"hidden",background:"#fff"}},r.createElement("iframe",{ref:C,title:i||o,style:{border:0,width:ke,height:He,transform:"scale("+pe+")",transformOrigin:"0 0",pointerEvents:m||j!=="view"?"auto":"none",display:"block"}}),f.status==="loading"?r.createElement("div",{style:{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#8a93a6",background:"rgba(255,255,255,.6)"}},"\u6C99\u7BB1\u6E32\u67D3\u4E2D\u2026"):null,f.status==="error"?r.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,border:"1px solid #dc2626",background:"#fef2f2",color:"#991b1b",borderRadius:8,padding:"6px 8px",fontSize:11,fontFamily:"ui-monospace, Consolas, monospace",maxHeight:120,overflow:"auto",whiteSpace:"pre-wrap"}},r.createElement("span",{role:"alert"},"\u6E32\u67D3\u51FA\u9519\uFF1A"+String(f.error||"\u9884\u89C8\u5185\u5BB9\u4E3A\u7A7A").slice(0,400)),r.createElement("button",{type:"button",className:"daw-wb-btn nodrag nopan",style:{marginLeft:8},onClick:ze},"\u91CD\u65B0\u6E32\u67D3")):null,j!=="view"?r.createElement("div",{style:{position:"absolute",left:8,top:6,zIndex:2,font:"11px system-ui",padding:"3px 8px",borderRadius:999,background:"#2563eb",color:"#fff"}},j==="edit"?"\u76F4\u63A5\u6539\uFF1A\u70B9\u9009\u5143\u7D20":"\u6807\u6CE8\uFF1A\u70B9\u9009\u5143\u7D20"):null,s!==null&&j==="annotate"?r.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,zIndex:3,background:"#fff",border:"1px solid #2563eb",borderRadius:8,padding:"8px 10px",boxShadow:"0 8px 24px rgba(15,23,42,.18)",font:"12px system-ui"}},r.createElement("div",{style:{color:"#5b6577",marginBottom:4}},String(s.tag||"\u5143\u7D20")+(s.line?" \xB7 \u7B2C "+s.line+" \u884C":"")+(Number(s.count)>1?" \xB7 \u540C\u6B3E\u7B2C "+(Number(s.nth)+1)+" \u4E2A":"")),r.createElement("textarea",{autoFocus:!0,"aria-label":"\u4FEE\u6539\u610F\u89C1",onKeyDown:x=>{x.key==="Escape"&&(x.stopPropagation(),ee||(E(null),T(""),J("")))},value:A,placeholder:"\u8FD9\u91CC\u8981\u600E\u4E48\u6539\uFF1F\uFF08\u4F8B\u5982\uFF1A\u6807\u9898\u592A\u5927 / \u6362\u4E2A\u989C\u8272\uFF09",onChange:x=>T(x.target.value),style:{width:"100%",boxSizing:"border-box",height:56,resize:"vertical",font:"12px system-ui",padding:6,borderRadius:6,border:"1px solid #dce2ee"}}),r.createElement("div",{style:{display:"flex",gap:6,marginTop:6,alignItems:"center"}},r.createElement("button",{type:"button",className:"daw-wb-btn",onClick:De,disabled:ee||String(A||"").trim()===""},"\u63D0\u4EA4"),r.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"ghost",disabled:ee,onClick:()=>{E(null),T(""),J("")}},"\u53D6\u6D88"),r.createElement("span",{role:"status",style:{color:"#5b6577",marginLeft:"auto"}},Q))):null,s===null&&j==="annotate"&&Q!==""?r.createElement("div",{role:"status",style:{position:"absolute",left:8,bottom:8,maxWidth:"calc(100% - 16px)",padding:"5px 8px",borderRadius:6,background:"var(--daw-surface, #fff)",color:"var(--daw-text, #172033)",fontSize:12}},Q):null,s!==null&&j==="edit"?r.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,zIndex:3,background:"#fff",border:"1px solid #2563eb",borderRadius:8,padding:"8px 10px",boxShadow:"0 8px 24px rgba(15,23,42,.18)",font:"12px system-ui",maxHeight:"80%",overflow:"auto"}},r.createElement("div",{style:{color:"#5b6577",marginBottom:4}},"\u76F4\u63A5\u6539 \xB7 "+(s.tag||"\u5143\u7D20")+(s.line?" \xB7 L"+s.line:"")),r.createElement("textarea",{value:we,onChange:x=>xe(x.target.value),placeholder:"\u4FEE\u6539\u8FD9\u4E2A\u5143\u7D20\u7684\u6587\u5B57",style:{width:"100%",boxSizing:"border-box",height:42,resize:"vertical",font:"12px system-ui",padding:6,borderRadius:6,border:"1px solid #dce2ee"}}),r.createElement("div",{style:{display:"flex",gap:6,marginTop:6}},r.createElement("button",{type:"button",className:"daw-wb-btn",onClick:()=>Ee({text:we})},"\u4FDD\u5B58\u6587\u5B57"),r.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"ghost",onClick:()=>{E(null),ne(null),$("")}},"\u53D6\u6D88")),V&&V.error?r.createElement("div",{style:{color:"#b45309",marginTop:6}},V.error):null,V&&Array.isArray(V.classes)?V.classes.map(x=>r.createElement("label",{key:x.name,style:{display:"flex",alignItems:"center",gap:6,marginTop:6}},r.createElement("span",{style:{color:"#5b6577",minWidth:70}},x.family),r.createElement("select",{value:x.name,onChange:P=>Ee({fromClass:x.name,toClass:P.target.value}),style:{font:"12px system-ui",padding:4,borderRadius:6,border:"1px solid #dce2ee",maxWidth:"100%"}},[x.name].concat(V.options&&V.options[x.name]||[]).map(P=>r.createElement("option",{key:P,value:P},P))))):null,r.createElement("div",{style:{color:"#5b6577",marginTop:6}},Be)):null)}function Pe(e){let t=e.data&&e.data.original||{},n=typeof t.name=="string"?t.name:"",o=typeof t.title=="string"?t.title:n,i=e.data&&e.data.projectId||e.projectId||"",h=Number.isFinite(t.examplesCount)?t.examplesCount:0,c=je(e,440),[w,v]=M(0),[p,S]=M(0),[b,a]=M("view"),[g,u]=M(null);K(()=>{let f=!0;return Y(i,"component",n,e.data&&e.data.token||e.token).then(y=>{f&&u(y)},()=>{}),()=>{f=!1}},[i,n]);let k=g&&g.meta&&Array.isArray(g.meta.examples)?g.meta.examples:[],l=g&&g.meta&&g.meta.tweaksSpec&&typeof g.meta.tweaksSpec=="object"?g.meta.tweaksSpec:{},d=Object.keys(l),[m,I]=M({}),C={};for(let f of d){let y=l[f]||{};if(m[f]!==void 0){C[f]=m[f];continue}if(y.default!==void 0){C[f]=y.default;continue}C[f]=y.type==="number"?Number.isFinite(y.min)?y.min:0:""}let R={key:n+"-"+p+"-"+JSON.stringify(C),props:Object.assign({},k[p]||{},d.length>0?{__tweaks:C}:{})};return r.createElement("div",{ref:c.frame,style:c.style},r.createElement("div",{style:{...U.head,flexWrap:"wrap",whiteSpace:"normal",flexShrink:0},"data-design-head":"1"},r.createElement("span",{style:{fontWeight:600}},o||n),r.createElement("span",{style:U.tag},"AI \xB7 \u7EC4\u4EF6"),r.createElement("span",{style:U.muted},n),r.createElement("button",{type:"button",className:"daw-wb-btn nodrag",onClick:f=>{f.stopPropagation(),Ae(i,v)}},"\u91CD\u65B0\u6E32\u67D3"),typeof t.onEdit=="function"?r.createElement("button",{type:"button",onClick:f=>{f.stopPropagation(),t.onEdit()},className:"daw-wb-btn","data-variant":"ghost"},t.labels&&t.labels.edit||"\u7F16\u8F91"):null,r.createElement("button",{type:"button",onClick:f=>{f.stopPropagation(),a(b==="annotate"?"view":"annotate")},className:"daw-wb-btn","data-variant":"ghost","data-on":String(b==="annotate")},b==="annotate"?"\u9000\u51FA\u6807\u6CE8":t.labels&&t.labels.annotate||"\u6807\u6CE8"),r.createElement("button",{type:"button",onClick:f=>{f.stopPropagation(),a(b==="edit"?"view":"edit")},className:"daw-wb-btn","data-variant":"ghost","data-on":String(b==="edit")},b==="edit"?"\u9000\u51FA\u76F4\u63A5\u6539":t.labels&&t.labels.editDirect||"\u76F4\u63A5\u6539"),h>1?r.createElement("span",{style:{display:"flex",gap:4,marginLeft:"auto"}},Array.from({length:Math.min(h,6)},(f,y)=>r.createElement("button",{key:y,onClick:B=>{B.stopPropagation(),S(y)},className:"daw-wb-btn","data-variant":"ghost","data-on":String(y===p)},"\u4F8B\u5B50 "+(y+1)))):null),d.length>0?r.createElement("div",{style:{display:"flex",flexWrap:"wrap",gap:8,padding:"6px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:11}},d.slice(0,8).map(f=>{let y=l[f]||{},B=C[f];if(y.type==="select"){let L=Array.isArray(y.options)?y.options:[];return r.createElement("label",{key:f,style:{display:"flex",alignItems:"center",gap:4}},r.createElement("span",{style:U.muted},f),r.createElement("select",{value:String(B),onChange:s=>I(E=>Object.assign({},E,{[f]:s.target.value})),className:"daw-wb-btn","data-variant":"ghost"},L.map(s=>r.createElement("option",{key:String(s),value:String(s)},String(s)))))}let D=Number.isFinite(y.min)?y.min:0,j=Number.isFinite(y.max)?y.max:64,z=Number.isFinite(y.step)?y.step:1;return r.createElement("label",{key:f,style:{display:"flex",alignItems:"center",gap:4}},r.createElement("span",{style:U.muted},f),r.createElement("input",{type:"range",min:D,max:j,step:z,value:Number(B)||D,onChange:L=>I(s=>Object.assign({},s,{[f]:Number(L.target.value)})),style:{width:80}}),r.createElement("span",null,String(B)))})):null,r.createElement("div",{className:"nodrag nowheel",style:{minHeight:0,flex:1,overflow:"auto"}},r.createElement(ye,{renderRevision:w,projectId:i,kind:"component",id:n,title:o,packId:t.packId,token:e.data&&e.data.token||e.token,entry:R,exampleIndex:p,sourceHash:t.sourceHash,width:"desktop",scale:(c.width-2)/te.desktop,maxHeight:e.maxHeight||(c.style.height?void 0:360),mode:b,onChanged:t.onDesignChanged})),c.handle)}function _e(e){var z,L;let t=e.data&&e.data.original||{},n=typeof t.artboardId=="string"?t.artboardId:"",o=typeof t.title=="string"?t.title:n,i=e.data&&e.data.projectId||e.projectId||"",h=e.data&&e.data.token||e.token,c=((z=e.data)==null?void 0:z.labels)||t.labels||{},w=je(e,460),[v,p]=M(0),[S,b]=M([]),[a,g]=M("view"),[u,k]=M(""),l=S[S.length-1],d=l?l.id:n,m=l?l.meta:t,I=m.title||(l?d:o),C=m.width==="mobile"?"mobile":"desktop",R=q(null),f=Te(R),y=e.review?Math.min(1,f/te[C]):(w.width-2)/te[C],B=ge(s=>{if(!(typeof s!="string"||s===""||s===d)){if(!Array.isArray(m.links)||!m.links.includes(s)){k("\u8FD9\u4E2A\u753B\u677F\u6CA1\u6709\u8FDE\u5230\u300C"+s+"\u300D");return}Y(i,"artboard",s,h).then(E=>{if(E===null){k("\u753B\u677F\u300C"+s+"\u300D\u4E0D\u5B58\u5728");return}k(""),b(A=>{var T;return((T=A[A.length-1])==null?void 0:T.id)===s?A:[...A,{id:s,meta:E.meta||{}}]})},()=>{k("\u753B\u677F\u52A0\u8F7D\u5931\u8D25")})}},[d,m.links,i,h]);function D(s,E){s.stopPropagation(),g(A=>A===E?"view":E)}let j=(s,E)=>r.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"tool","aria-pressed":a===E,onClick:A=>D(A,E)},s);return r.createElement("div",{ref:w.frame,style:w.style},r.createElement("div",{style:{...U.head,cursor:e.review?"default":"grab",flexWrap:"wrap",whiteSpace:"normal",flexShrink:0},"data-design-head":"1"},r.createElement("span",{style:{fontWeight:650,flex:e.review?"1 1 95px":void 0,minWidth:0,overflowWrap:"anywhere"}},I),e.review?null:r.createElement("span",{style:U.tag},"AI \xB7 \u753B\u677F"),r.createElement("span",{style:U.muted},C==="mobile"?"\u624B\u673A":"\u684C\u9762"),!e.review&&t.requirementId?r.createElement("span",{style:U.muted},"\xB7 \u9700\u6C42 "+String(t.requirementId).slice(0,12)):null,!l&&typeof t.onEdit=="function"?r.createElement("button",{type:"button",onClick:s=>{s.stopPropagation(),t.onEdit()},className:"daw-wb-btn","data-variant":"ghost"},c.edit||"\u7F16\u8F91"):null,r.createElement("button",{type:"button",className:"daw-wb-btn nodrag",onClick:s=>{s.stopPropagation(),Ae(i,p)}},"\u91CD\u65B0\u6E32\u67D3"),r.createElement("div",{className:"daw-wb-board-tools",role:"group","aria-label":c.toolGroup||"\u753B\u677F\u5DE5\u5177"},j(a==="annotate"?"\u9000\u51FA\u6807\u6CE8":c.annotate||"\u6807\u6CE8","annotate"),j(a==="edit"?"\u9000\u51FA\u76F4\u63A5\u6539":c.editDirect||"\u76F4\u63A5\u6539","edit")),S.length>0?r.createElement("button",{type:"button",onClick:s=>{s.stopPropagation(),k(""),b(E=>E.slice(0,-1))},className:"daw-wb-btn","data-variant":"ghost",title:"\u56DE\u5230\u4E0A\u4E00\u4E2A\u753B\u677F"},"\u2190 \u8FD4\u56DE ("+S.length+")"):null),u?r.createElement("div",{role:"status",style:{padding:"6px 10px",color:"var(--daw-warn, #b45309)",fontSize:12}},u):null,r.createElement("div",{ref:e.review?R:void 0,className:"nodrag nowheel",style:e.review?{display:"grid",justifyItems:"center",minWidth:0,overflow:"hidden",background:"var(--daw-surface-muted, #f5f6f8)"}:{flex:1,minHeight:0,overflow:"auto"}},r.createElement(ye,{renderRevision:v,projectId:i,kind:"artboard",id:d,title:I,packId:m.packId||t.packId,token:h,entry:{key:d+"-0",props:{}},sourceHash:m.sourceHash,width:C,scale:y,onNavigate:B,interactive:!0,mode:a,onChanged:((L=e.data)==null?void 0:L.onDesignChanged)||t.onDesignChanged})),w.handle)}function tt(e){let t=e.delivery,n=q(null),o=q(null),i=q(null),h=q(null),[c]=M(()=>document.createElement("div")),w=Te(n,e.fullscreen),[v,p]=M(0),[S,b]=M([t.entryId]),a=t.boards.find(l=>l.id===S[S.length-1]),g=Ye(()=>a&&{code:a.code,deps:a.dependencies.map(l=>({name:l,code:t.modules[l]}))},[a,t]);if(K(()=>{a&&typeof e.onBoardChange=="function"&&e.onBoardChange(a.id)},[a,e.onBoardChange]),K(()=>{let l=o.current,d=e.fullscreen?h.current:i.current;if(d&&c.parentNode!==d)if(c.isConnected&&typeof d.moveBefore=="function")d.moveBefore(c,null);else{let m=c.isConnected;d.appendChild(c),m&&p(I=>I+1)}e.fullscreen&&l&&!l.open?l.showModal():l!=null&&l.open&&l.close()},[e.fullscreen,c]),!a)return null;let u=Math.min(1,w/te[a.width==="mobile"?"mobile":"desktop"]),k=r.createElement("div",{ref:n,style:{display:"grid",justifyItems:"center",minWidth:0,overflow:"hidden"}},S.length>1?r.createElement("button",{type:"button",className:"daw-wb-btn","data-variant":"ghost",onClick:()=>b(l=>l.slice(0,-1))},e.backLabel||"\u8FD4\u56DE\u4E0A\u4E00\u5C4F"):null,r.createElement(ye,{projectId:t.projectId,kind:"artboard",id:a.id,title:a.title,packId:t.packId,width:a.width,scale:u,interactive:!0,snapshot:g,renderRevision:String(e.renderRevision||0)+":"+v,onNavigate:l=>{l!==a.id&&a.links.includes(l)&&t.boards.some(d=>d.id===l)&&b(d=>[...d,l])}}));return r.createElement(r.Fragment,null,r.createElement("div",{ref:i}),(0,Me.createPortal)(k,c),r.createElement("dialog",{ref:o,"aria-label":a.title||a.id,onCancel:()=>{var l;return(l=e.onCloseFullscreen)==null?void 0:l.call(e)},onClose:()=>{var l;e.fullscreen&&((l=e.onCloseFullscreen)==null||l.call(e))},onClick:l=>{var d;l.target===l.currentTarget&&((d=e.onCloseFullscreen)==null||d.call(e))},style:{width:"calc(100vw - 32px)",maxWidth:"none",height:"calc(100dvh - 32px)",maxHeight:"none",padding:0,border:"1px solid var(--daw-border, #dce2ee)",borderRadius:12,background:"var(--daw-surface, #fff)",color:"var(--daw-text, #172033)"}},r.createElement("div",{style:{height:"100%",display:"flex",flexDirection:"column"}},r.createElement("header",{style:{...U.head,cursor:"default",flexShrink:0}},r.createElement("strong",{style:{flex:1,minWidth:0,whiteSpace:"normal"}},a.title||a.id),r.createElement("button",{type:"button",className:"daw-wb-btn",onClick:()=>p(l=>l+1)},"\u91CD\u65B0\u6E32\u67D3"),r.createElement("button",{type:"button",className:"daw-wb-btn",onClick:()=>{var l;return(l=e.onCloseFullscreen)==null?void 0:l.call(e)}},e.closeLabel||"\u5173\u95ED")),r.createElement("div",{ref:h,className:"nowheel",style:{flex:1,minHeight:0,overflow:"auto",background:"#f5f6f8"}}))))}function nt(e,t,n){let o=n||{};K(()=>{if(typeof e!="string"||e===""||typeof t!="string"||t==="")return;let i=!0,h=null,c=document.createElement("div");c.style.cssText="position:fixed;left:-10000px;top:0;width:1024px;height:800px;overflow:hidden",document.body.appendChild(c);let w=document.createElement("iframe");w.style.cssText="width:1024px;height:800px;border:0",c.appendChild(w);let v=null,p=null;async function S(){return v!==null?v:(p!==null||(v=ue(w,{title:"whales-design-live"}),p=(async()=>{let[u,k]=await Promise.all([le(),de(o.packId)]);return v.init({runtime:u,styles:k.styles,bundle:k.bundle})})()),p)}async function b(u){let k=u.target||{},l=k.type==="artboard"?"artboard":"component",d=l==="artboard"?k.artboardId:k.name;try{await S();let m=await me(e,l,d,0,t);if(m===null||m.code===""){await a({requestId:u.requestId,ok:!1,error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269"});return}let I=await Y(e,l,d,t),C=I&&I.meta&&Array.isArray(I.meta.examples)?I.meta.examples:[],R=await v.render({name:d,code:m.code,props:C[Number(u.exampleIndex)||0]||{},dependencies:(m.deps||[]).map(f=>({name:f.name,code:f.code}))});await a({requestId:u.requestId,ok:R.ok!==!1,error:R.error||"",consoleErrors:R.consoleErrors||[],ms:R.ms,width:R.width,height:R.height,nodeCount:R.nodeCount,textLength:R.textLength,textSample:R.textSample,empty:R.empty,buttons:R.buttons,inputs:R.inputs,tables:R.tables})}catch(m){await a({requestId:u.requestId,ok:!1,error:String(m&&m.message||m)})}}async function a(u){try{await fetch(W+"/design/live/result",{method:"POST",headers:{"content-type":"application/json","x-whales-token":t},body:JSON.stringify(u)})}catch{}}async function g(){if(i){try{let u=await fetch(W+"/design/live?projectId="+encodeURIComponent(e),{headers:{"x-whales-token":t}});if(u.ok){let k=await u.json(),l=k&&k.data&&Array.isArray(k.data.requests)?k.data.requests:[];for(let d of l)await b(d)}}catch{}i&&(h=setTimeout(g,4e3))}}return g(),()=>{i=!1,h&&clearTimeout(h),v&&v.destroy(),c.remove()}},[e,t,o.packId])}async function rt(e){let t=e&&e.data||{},n=e&&e.projectId?e.projectId:"",o=e.kind==="artboard"?"artboard":"component",i=o==="artboard"?t.artboardId:t.name,h=typeof e.token=="string"?e.token:"",[c,w,v]=await Promise.all([Y(n,o,i,h),le().catch(()=>""),de(t.packId).catch(()=>({styles:"",bundle:""}))]),p=document.createElement("div");p.style.cssText="position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px";let S=document.createElement("div");S.style.cssText="width:min(1280px,97vw);height:min(860px,94vh);background:#fff;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.35)";let b=document.createElement("div");b.style.cssText="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #dce2ee;font:13px system-ui";let a=document.createElement("b");a.textContent=c&&c.meta&&c.meta.title||i;let g=document.createElement("span");g.style.color="#8a93a6",g.textContent=i+".tsx",b.append(a,g);let u=document.createElement("span");u.style.cssText="margin-left:12px;font:11px system-ui;color:#8a93a6",b.appendChild(u);let k=document.createElement("button");k.textContent="\u89E3\u9501\u8BA9 AI \u7EE7\u7EED\u6539",k.style.cssText="margin-left:auto;font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer;display:none",b.appendChild(k);let l=document.createElement("button");l.textContent="\u4FDD\u5B58",l.style.cssText="font:12px system-ui;padding:4px 12px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer",b.appendChild(l);let d=document.createElement("button");d.textContent="\u5173\u95ED",d.style.cssText="font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer",d.onclick=()=>p.remove(),b.appendChild(d);let m=document.createElement("div");m.style.cssText="flex:1;display:flex;min-height:0";let I=document.createElement("div");I.style.cssText="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid #dce2ee";let C=document.createElement("textarea");C.spellcheck=!1,C.value=c?c.source:"",C.style.cssText="flex:1;width:100%;border:0;outline:none;resize:none;padding:14px;font:12px/1.6 ui-monospace,Consolas,monospace;background:#fbfcfe;color:#1e2430;tab-size:2",I.appendChild(C);let R=document.createElement("div");R.style.cssText="width:min(560px,46%);display:flex;flex-direction:column;min-width:0;background:#f6f8fb";let f=document.createElement("iframe");f.setAttribute("sandbox","allow-scripts"),f.setAttribute("srcdoc",ae({title:"\u6E90\u7801\u9884\u89C8"})),f.style.cssText="flex:1;width:100%;border:0;background:#fff",R.appendChild(f),m.append(I,R);let y=document.createElement("div");y.style.cssText="display:none;padding:8px 12px;border-top:1px solid #fecaca;background:#fef2f2;color:#991b1b;font:11px/1.6 ui-monospace,Consolas,monospace;max-height:120px;overflow:auto;white-space:pre-wrap",S.append(b,m,y),p.appendChild(S),document.body.appendChild(p),p.addEventListener("click",s=>{s.target===p&&p.remove()});let B=null,D=c&&c.compiledCode||"";try{B=ue(f,{title:"\u6E90\u7801\u9884\u89C8"}),await B.init({runtime:w,styles:v.styles||"",bundle:v.bundle||""})}catch(s){u.textContent="\u6C99\u7BB1\u521D\u59CB\u5316\u5931\u8D25\uFF1A"+String(s&&s.message||s)}let j=null,z=0;async function L(s){let E=++z;l.disabled=!0,u.textContent="\u7F16\u8BD1\u4E2D\u2026";try{let T=await(await fetch(W+"/design/compile",{method:"POST",headers:{"content-type":"application/json","x-whales-token":h},body:JSON.stringify({projectId:n,kind:o,name:o==="component"?i:void 0,artboardId:o==="artboard"?i:void 0,source:s})})).json();if(E!==z)return;if(!T||T.code!==200||!T.data||T.data.compile&&T.data.compile.ok===!1){let Q=T&&T.data&&T.data.compile&&T.data.compile.errors?T.data.compile.errors:[];y.style.display="block",y.textContent=Q.length>0?Q.map(J=>J.message).join(`
`):String(T&&T.msg||"\u7F16\u8BD1\u5931\u8D25"),u.textContent="\u7F16\u8BD1\u5931\u8D25",l.disabled=!1;return}y.style.display="none",D=T.data.compiled||D,u.textContent="\u7F16\u8BD1\u901A\u8FC7",l.disabled=!1,B!==null&&await B.render({name:i,code:D,props:c&&c.meta&&c.meta.examples&&c.meta.examples[0]||{},isBoard:o==="artboard"})}catch(A){if(E!==z)return;y.style.display="block",y.textContent="\u7F16\u8BD1\u8BF7\u6C42\u5931\u8D25\uFF1A"+String(A&&A.message||A),l.disabled=!1}}if(C.addEventListener("input",()=>{j&&clearTimeout(j),j=setTimeout(()=>L(C.value),500)}),l.onclick=async()=>{u.textContent="\u4FDD\u5B58\u4E2D\u2026";try{let E=await(await fetch(W+"/design/source",{method:"POST",headers:{"content-type":"application/json","x-whales-token":h},body:JSON.stringify({projectId:n,kind:o,name:o==="component"?i:void 0,artboardId:o==="artboard"?i:void 0,source:C.value})})).json();E&&E.code===200&&E.data&&E.data.written===!0?(u.textContent="\u5DF2\u4FDD\u5B58\uFF08agent \u4E4B\u540E\u4E0D\u80FD\u6539\u8FD9\u4E2A\u4E86\uFF09",he(n,o,i),k.style.display=""):u.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(E&&E.msg||"\u672A\u77E5\u9519\u8BEF")}catch(s){u.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(s&&s.message||s)}},k.onclick=async()=>{u.textContent="\u89E3\u9501\u4E2D\u2026";try{let E=await(await fetch(W+"/design/unlock",{method:"POST",headers:{"content-type":"application/json","x-whales-token":h},body:JSON.stringify({projectId:n,kind:o,name:o==="component"?i:void 0,artboardId:o==="artboard"?i:void 0})})).json();u.textContent=E&&E.code===200&&E.data&&E.data.unlocked?"\u5DF2\u89E3\u9501\uFF0CAI \u53EF\u4EE5\u7EE7\u7EED\u6539":"\u89E3\u9501\u5931\u8D25\uFF1A"+String(E&&E.msg||""),k.style.display="none"}catch(s){u.textContent="\u89E3\u9501\u5931\u8D25\uFF1A"+String(s&&s.message||s)}},c&&c.userEdited===!0&&(k.style.display=""),D!==""&&B!==null)try{await B.render({name:i,code:D,props:c&&c.meta&&c.meta.examples&&c.meta.examples[0]||{},isBoard:o==="artboard"})}catch{}return{close:()=>p.remove()}}var ot={component:Pe,artboard:_e},at="";

return module.exports;
} });

/* dsh-agent-whales · client.design.js —— 由 tools/flow-chunk/build-design.mjs 生成，勿手改。
 * 组件工坊：组件 / 画板节点的沙箱预览与在线画布登记。只在画布上出现这两种节点时按需加载。 */
window.__ModuleLoader__.load({ id: "dsh-agent-whales", chunk: "client.design.js", factory: function (require) {
var module = { exports: {} }; var exports = module.exports;
var ue=Object.create;var J=Object.defineProperty;var pe=Object.getOwnPropertyDescriptor;var me=Object.getOwnPropertyNames;var fe=Object.getPrototypeOf,ge=Object.prototype.hasOwnProperty;var he=(e,t)=>{for(var n in t)J(e,n,{get:t[n],enumerable:!0})},oe=(e,t,n,s)=>{if(t&&typeof t=="object"||typeof t=="function")for(let i of me(t))!ge.call(e,i)&&i!==n&&J(e,i,{get:()=>t[i],enumerable:!(s=pe(t,i))||s.enumerable});return e};var ye=(e,t,n)=>(n=e!=null?ue(fe(e)):{},oe(t||!e||!e.__esModule?J(n,"default",{value:e,enumerable:!0}):n,e)),be=e=>oe(J({},"__esModule",{value:!0}),e);var je={};he(je,{DESIGN_CSS:()=>Ie,DesignArtboardNode:()=>le,DesignComponentNode:()=>de,SANDBOX_CSP:()=>$,createSandboxHost:()=>Q,designNodeTypes:()=>Re,invalidateEntity:()=>ie,loadCompiled:()=>Z,loadEntity:()=>L,loadPackText:()=>K,loadRuntimeText:()=>Y,openSourceEditor:()=>Ce,sandboxSrcdoc:()=>X,useDesignLive:()=>Se});module.exports=be(je);var u=ye(require("react"),1);function xe(e){let t=e||{},n=String(t.csp||"default-src 'none'"),s=ke(String(t.title||"whales-design-sandbox"));return`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${n}">
<title>${s}</title>
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
<script>${we}<\/script>
</body></html>`}var we=String.raw`
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
    if (typeof component !== "function") throw new Error("组件 " + entry.name + " 没有 export default 一个函数（或组件）");
    state.components[entry.name] = { component: component, code: entry.code };
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
`,$="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";function X(e){return xe(Object.assign({csp:$},e||{}))}function ke(e){let t={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"};return String(e).replace(/[&<>"]/g,n=>t[n])}var{useCallback:ne,useEffect:F,useMemo:Ae,useRef:ae,useState:B}=u,O="/agent-whales/api",V=new Map,G=new Map;function Y(){let e="runtime";if(V.has(e))return V.get(e);let t=fetch(O+"/design/runtime.js").then(n=>{if(!n.ok)throw new Error("\u8FD0\u884C\u65F6\u4E0B\u8F7D\u5931\u8D25 "+n.status);return n.text()});return V.set(e,t),t.catch(()=>V.delete(e)),t}function K(e){let t=typeof e=="string"&&e!==""?e:"shadcn";if(G.has(t))return G.get(t);let n=O+"/component-packs/"+encodeURIComponent(t),s=(async()=>{if(t==="shadcn"){let l=null;try{l=await(await fetch(O+"/design/pack-api?projectId=")).json()}catch{l=null}return{bundle:"",styles:"",api:l,builtin:!0}}let[i,h]=await Promise.all([fetch(n+"/bundle.js").then(l=>l.ok?l.text():""),fetch(n+"/styles.css").then(l=>l.ok?l.text():"",()=>"")]),a=null;try{a=await(await fetch(O+"/design/pack-api?packId="+encodeURIComponent(t))).json()}catch{a=null}return{bundle:i,styles:h,api:a,builtin:!1}})();return G.set(t,s),s.catch(()=>G.delete(t)),s}var se=0;function te(){se+=1;let e=new Uint8Array(16);if(typeof crypto!="undefined"&&typeof crypto.getRandomValues=="function")crypto.getRandomValues(e);else for(let t=0;t<e.length;t+=1)e[t]=Math.floor(Math.random()*256);return Array.from(e,t=>t.toString(16).padStart(2,"0")).join("")+"-"+se}function Q(e,t){let n=t||{},s="",i=!1,h=[],a=null,l=!1,m=f=>{if(f.origin!=="null")return;let r=f.data||{};if(r.type==="booted"){l=!0;return}if(r.nonce===s){if(r.type==="ready"){i=!0;let o=h.splice(0);for(let g of o)g(r.info||{});return}if(r.type==="rendered"){if(a!==null){let o=a;a=null,o(r)}return}if(r.type==="pick"){typeof n.onPick=="function"&&n.onPick(r.pick);return}if(r.type==="navigate"){typeof n.onNavigate=="function"&&n.onNavigate(r.to);return}r.type==="error"&&typeof n.onError=="function"&&n.onError(r)}};window.addEventListener("message",m),e.setAttribute("sandbox","allow-scripts"),e.setAttribute("srcdoc",X({csp:$,title:n.title||"whales-design"}));function x(f){if(s=te(),!l){let r=Date.now();return new Promise(o=>{let g=()=>{if(l||Date.now()-r>6e3){o();return}setTimeout(g,60)};g()}).then(()=>w(f))}return w(f)}function w(f){return new Promise(r=>{h.push(r),e.contentWindow.postMessage({type:"init",nonce:s,runtime:f.runtime,styles:f.styles,packCode:f.bundle},"*"),setTimeout(()=>{i||r({timeout:!0})},8e3)})}function v(f){if(!i)return Promise.resolve({ok:!1,error:"\u6C99\u7BB1\u8FD8\u6CA1\u5C31\u7EEA"});let r=te();return s=r,new Promise(o=>{a=o,e.contentWindow.postMessage({type:"render",nonce:r,runId:f.runId||"run-"+Date.now(),mountId:f.mountId||"main",name:f.name,code:f.code,props:f.props||{},dependencies:f.dependencies||[]},"*"),setTimeout(()=>{a===o&&(a=null,o({ok:!1,error:"\u6E32\u67D3\u8D85\u65F6\uFF088 \u79D2\uFF09"}))},8e3)})}function R(f){if(!i)return;let r=te();s=r,e.contentWindow.postMessage({type:"pick-mode",nonce:r,enabled:!!f},"*")}return{init:x,render:v,setPickMode:R,destroy:function(){window.removeEventListener("message",m)},isReady:function(){return i}}}var z=new Map,ve=20*1e3;function L(e,t,n){let s=e+"|"+t+"|"+n,i=z.get(s);if(i!==void 0&&Date.now()-i.at<ve)return i.pending;let h="?projectId="+encodeURIComponent(e)+"&kind="+t+"&id="+encodeURIComponent(n),a=fetch(O+"/design/source"+h).then(l=>l.ok?l.json():null).then(l=>!l||l.code!==200?null:l.data);return z.set(s,{at:Date.now(),pending:a}),a.catch(()=>{let l=z.get(s);l!==void 0&&l.pending===a&&z.delete(s)}),a}function ie(e,t,n){z.delete(e+"|"+t+"|"+n)}async function Z(e,t,n,s){let i=await L(e,t,n);if(i===null)return null;let h=[],a=i.meta&&Array.isArray(i.meta.imports)?i.meta.imports:[];if(s<4)for(let l of a){let m=await Z(e,"component",l,s+1);m!==null&&h.push(m)}return{name:n,code:i.compiledCode||"",deps:h,meta:i.meta,source:i.source}}var N={card:{background:"var(--daw-surface, #fff)",border:"1px solid var(--daw-border, #dce2ee)",borderRadius:12,boxShadow:"0 6px 18px rgba(0,0,0,.06)",overflow:"hidden"},head:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:12,cursor:"grab",whiteSpace:"nowrap"},tag:{fontSize:10,padding:"2px 6px",borderRadius:999,background:"var(--daw-accent-bg, #f9effa)",color:"var(--daw-accent, #c05bd0)",fontWeight:600},btn:{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1px solid var(--daw-border, #dce2ee)",background:"var(--daw-surface, #fff)",cursor:"pointer"},muted:{color:"var(--daw-text-muted, #8a93a6)"}},Ee={mobile:390,desktop:1024};function ce(e){let{projectId:t,kind:n,id:s,title:i,packId:h,entry:a,width:l,scale:m,maxHeight:x,exampleIndex:w,onReport:v,onNavigate:R,sourceHash:f,token:r}=e,o=ae(null),g=ae(null),[d,c]=B({status:"loading",error:"",info:null}),[y,M]=B(!1),[p,T]=B(null),[S,C]=B(""),[q,_]=B(""),H=Ee[l==="mobile"?"mobile":"desktop"];F(()=>{let b=g.current;b!==null&&typeof b.setPickMode=="function"&&b.setPickMode(y)},[y,d.status]);let ee=ne(async()=>{if(p===null)return;let b=String(S||"").trim();if(b!==""){_("\u63D0\u4EA4\u4E2D\u2026");try{let A=await(await fetch(O+"/design/comments?projectId="+encodeURIComponent(t),{method:"POST",headers:{"content-type":"application/json","x-whales-token":r||""},body:JSON.stringify({target:(n==="artboard"?"board:":"comp:")+s,wsrc:p.wsrc,line:p.line,column:p.column,tag:p.tag,nth:p.nth,count:p.count,body:b,sourceSnippet:p.sourceSnippet})})).json();A&&A.code===200?(_(A.data&&A.data.delivered==="sent"?"\u5DF2\u63D0\u4EA4\uFF0C\u5DF2\u53D1\u7ED9 agent":"\u5DF2\u63D0\u4EA4\uFF08agent \u672A\u5728\u7EBF\uFF0C\u5B83\u4E0B\u6B21\u8BFB comments \u80FD\u770B\u5230\uFF09"),T(null),C("")):_("\u5931\u8D25\uFF1A"+String(A&&A.msg||"\u672A\u77E5\u9519\u8BEF"))}catch(k){_("\u5931\u8D25\uFF1A"+String(k&&k.message||k))}}},[p,S,t,n,s,r]);F(()=>{let b=!0,k=o.current;if(!k)return;let A=Q(k,{title:i,onError:()=>{},onNavigate:R,onPick:j=>{!b||!j||!j.wsrc||L(t,n,s).then(W=>{if(!b)return;let P=(W&&Array.isArray(W.jsxTable)?W.jsxTable:[]).filter(D=>D&&D.wsrc===j.wsrc)[0];T({wsrc:j.wsrc,line:P?P.line:0,column:P?P.column:0,tag:j.tag||P&&P.tag||"",nth:j.nth||0,count:j.count||1,text:j.text||"",sourceSnippet:P&&P.snippet||""}),_("")},()=>{})}});return g.current=A,(async()=>{try{let[j,W]=await Promise.all([Y(),K(h)]),U=await A.init({runtime:j,styles:W.styles,bundle:W.bundle});if(!b)return;if(U&&U.timeout){c({status:"error",error:"\u6C99\u7BB1\u521D\u59CB\u5316\u8D85\u65F6",info:null});return}let P=await Z(t,n,s,0);if(!b)return;if(P===null||P.code===""){c({status:"error",error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269\uFF08\u6E90\u7801\u53EF\u80FD\u8FD8\u6CA1\u4FDD\u5B58\uFF09",info:U});return}let D=await A.render({name:s,code:P.code,props:a&&a.props||{},dependencies:(P.deps||[]).map(re=>({name:re.name,code:re.code})),isBoard:n==="artboard"});if(!b)return;c({status:D.ok?"ok":"error",error:D.error||"",info:D}),typeof v=="function"&&v(D)}catch(j){b&&c({status:"error",error:String(j&&j.message||j),info:null})}})(),()=>{b=!1,g.current&&g.current.destroy()}},[t,n,s,h,f,a&&a.key,w]);let E=Math.min(x||640,Math.max(120,d.info&&d.info.height||260)),I=typeof O=="string"?O:"/agent-whales/api";return u.createElement("div",{style:{position:"relative",width:Math.ceil(H*(m||1)),height:E,overflow:"hidden",background:"#fff"}},u.createElement("iframe",{ref:o,title:i||s,style:{border:0,width:H,height:Math.max(120,d.info&&d.info.height||480),transform:"scale("+(m||1)+")",transformOrigin:"0 0",pointerEvents:y?"auto":"none",display:"block"}}),d.status==="loading"?u.createElement("div",{style:{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#8a93a6",background:"rgba(255,255,255,.6)"}},"\u6C99\u7BB1\u6E32\u67D3\u4E2D\u2026"):null,d.status==="error"?u.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,border:"1px solid #dc2626",background:"#fef2f2",color:"#991b1b",borderRadius:8,padding:"6px 8px",fontSize:11,fontFamily:"ui-monospace, Consolas, monospace",maxHeight:120,overflow:"auto",whiteSpace:"pre-wrap"}},"\u6E32\u67D3\u51FA\u9519\uFF1A"+String(d.error).slice(0,400)):null,u.createElement("button",{type:"button",title:y?"\u9000\u51FA\u8BC4\u8BBA\u6A21\u5F0F":"\u8BC4\u8BBA\uFF1A\u70B9\u9875\u9762\u4E0A\u7684\u5143\u7D20\u7559\u610F\u89C1",onClick:b=>{b.stopPropagation(),M(!y),y&&(T(null),_(""))},style:{position:"absolute",right:6,top:6,zIndex:2,font:"11px system-ui",padding:"2px 7px",borderRadius:999,border:"1px solid "+(y?"#2563eb":"#dce2ee"),background:y?"#2563eb":"rgba(255,255,255,.92)",color:y?"#fff":"#5b6577",cursor:"pointer"}},y?"\u8BC4\u8BBA\u4E2D\u2026":"\u{1F4AC} \u8BC4\u8BBA"),p!==null?u.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,zIndex:3,background:"#fff",border:"1px solid #2563eb",borderRadius:8,padding:"8px 10px",boxShadow:"0 8px 24px rgba(15,23,42,.18)",font:"12px system-ui"}},u.createElement("div",{style:{color:"#5b6577",marginBottom:4}},String(p.tag||"\u5143\u7D20")+(p.line?" \xB7 \u7B2C "+p.line+" \u884C":"")+(Number(p.count)>1?" \xB7 \u540C\u6B3E\u7B2C "+(Number(p.nth)+1)+" \u4E2A":"")),u.createElement("textarea",{autoFocus:!0,value:S,placeholder:"\u8FD9\u91CC\u8981\u600E\u4E48\u6539\uFF1F\uFF08\u4F8B\u5982\uFF1A\u6807\u9898\u592A\u5927 / \u6362\u4E2A\u989C\u8272\uFF09",onChange:b=>C(b.target.value),style:{width:"100%",boxSizing:"border-box",height:56,resize:"vertical",font:"12px system-ui",padding:6,borderRadius:6,border:"1px solid #dce2ee"}}),u.createElement("div",{style:{display:"flex",gap:6,marginTop:6,alignItems:"center"}},u.createElement("button",{type:"button",onClick:ee,disabled:String(S||"").trim()==="",style:{font:"12px system-ui",padding:"3px 12px",borderRadius:6,border:"1px solid #2563eb",background:String(S||"").trim()===""?"#c7d2fe":"#2563eb",color:"#fff",cursor:String(S||"").trim()===""?"default":"pointer"}},"\u63D0\u4EA4"),u.createElement("button",{type:"button",onClick:()=>{T(null),C(""),_("")},style:{font:"12px system-ui",padding:"3px 10px",borderRadius:6,border:"1px solid #dce2ee",background:"#fff",cursor:"pointer"}},"\u53D6\u6D88"),u.createElement("span",{style:{color:"#5b6577",marginLeft:"auto"}},q))):null)}function de(e){let t=e.data&&e.data.original||{},n=typeof t.name=="string"?t.name:"",s=typeof t.title=="string"?t.title:n,i=e.data&&e.data.projectId||e.projectId||"",h=Number.isFinite(t.examplesCount)?t.examplesCount:0,[a,l]=B(0),[m,x]=B(null);F(()=>{let d=!0;return L(i,"component",n).then(c=>{d&&x(c)},()=>{}),()=>{d=!1}},[i,n]);let w=m&&m.meta&&Array.isArray(m.meta.examples)?m.meta.examples:[],v=m&&m.meta&&m.meta.tweaksSpec&&typeof m.meta.tweaksSpec=="object"?m.meta.tweaksSpec:{},R=Object.keys(v),[f,r]=B({}),o={};for(let d of R){let c=v[d]||{};if(f[d]!==void 0){o[d]=f[d];continue}if(c.default!==void 0){o[d]=c.default;continue}o[d]=c.type==="number"?Number.isFinite(c.min)?c.min:0:""}let g={key:n+"-"+a+"-"+JSON.stringify(o),props:Object.assign({},w[a]||{},R.length>0?{__tweaks:o}:{})};return u.createElement("div",{style:N.card},u.createElement("div",{style:N.head},u.createElement("span",{style:{fontWeight:600}},s||n),u.createElement("span",{style:N.tag},"AI \xB7 \u7EC4\u4EF6"),u.createElement("span",{style:N.muted},n),h>1?u.createElement("span",{style:{display:"flex",gap:4,marginLeft:"auto"}},Array.from({length:Math.min(h,6)},(d,c)=>u.createElement("button",{key:c,onClick:y=>{y.stopPropagation(),l(c)},style:Object.assign({},N.btn,{borderColor:c===a?"var(--daw-accent, #c05bd0)":void 0,fontWeight:c===a?600:400})},"\u4F8B\u5B50 "+(c+1)))):null),R.length>0?u.createElement("div",{style:{display:"flex",flexWrap:"wrap",gap:8,padding:"6px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:11}},R.slice(0,8).map(d=>{let c=v[d]||{},y=o[d];if(c.type==="select"){let S=Array.isArray(c.options)?c.options:[];return u.createElement("label",{key:d,style:{display:"flex",alignItems:"center",gap:4}},u.createElement("span",{style:N.muted},d),u.createElement("select",{value:String(y),onChange:C=>r(q=>Object.assign({},q,{[d]:C.target.value})),style:Object.assign({},N.btn,{padding:"1px 4px"})},S.map(C=>u.createElement("option",{key:String(C),value:String(C)},String(C)))))}let M=Number.isFinite(c.min)?c.min:0,p=Number.isFinite(c.max)?c.max:64,T=Number.isFinite(c.step)?c.step:1;return u.createElement("label",{key:d,style:{display:"flex",alignItems:"center",gap:4}},u.createElement("span",{style:N.muted},d),u.createElement("input",{type:"range",min:M,max:p,step:T,value:Number(y)||M,onChange:S=>r(C=>Object.assign({},C,{[d]:Number(S.target.value)})),style:{width:80}}),u.createElement("span",null,String(y)))})):null,u.createElement(ce,{projectId:i,kind:"component",id:n,title:s,packId:t.packId,token:e.data&&e.data.token||e.token,entry:g,exampleIndex:a,sourceHash:t.sourceHash,width:"desktop",scale:e.scale||.42,maxHeight:e.maxHeight||360}))}function le(e){let t=e.data&&e.data.original||{},n=typeof t.artboardId=="string"?t.artboardId:"",s=typeof t.title=="string"?t.title:n,i=e.data&&e.data.projectId||e.projectId||"",h=t.width==="mobile"?"mobile":"desktop",[a,l]=B([n]),[m,x]=B(""),w=a[a.length-1]||n,v=ne(o=>{if(typeof o!="string"||o==="")return;if((Array.isArray(t.links)?t.links:[]).indexOf(o)<0){x("\u8FD9\u4E2A\u753B\u677F\u6CA1\u6709\u8FDE\u5230\u300C"+o+"\u300D");return}L(i,"artboard",o).then(d=>{if(d===null){x("\u753B\u677F\u300C"+o+"\u300D\u4E0D\u5B58\u5728");return}l(c=>c[c.length-1]===o?c:c.concat([o]))},()=>{})},[t.links,i]),R=ne(()=>l(o=>o.length>1?o.slice(0,-1):o),[]),[f,r]=B(s);return F(()=>{let o=!0;if(w===n){r(s);return}return L(i,"artboard",w).then(g=>{o&&r(g&&g.meta&&g.meta.title?g.meta.title:w)},()=>{}),()=>{o=!1}},[i,n,w,s]),u.createElement("div",{style:N.card},u.createElement("div",{style:N.head},u.createElement("span",{style:{fontWeight:600}},f||w),u.createElement("span",{style:N.tag},"AI \xB7 \u753B\u677F"),u.createElement("span",{style:N.muted},h==="mobile"?"\u624B\u673A":"\u684C\u9762"),t.requirementId?u.createElement("span",{style:N.muted},"\xB7 \u9700\u6C42 "+String(t.requirementId).slice(0,12)):null,m!==""?u.createElement("span",{style:{color:"#b45309",fontSize:11}},m):null,a.length>1?u.createElement("button",{onClick:o=>{o.stopPropagation(),R()},style:Object.assign({},N.btn,{marginLeft:"auto"}),title:"\u56DE\u5230\u4E0A\u4E00\u4E2A\u753B\u677F"},"\u2190 \u8FD4\u56DE ("+(a.length-1)+")"):null),u.createElement(ce,{projectId:i,kind:"artboard",id:w,title:f,packId:t.packId,token:e.data&&e.data.token||e.token,entry:{key:w+"-0",props:{}},sourceHash:w===n?t.sourceHash:void 0,width:h,scale:e.scale||.42,maxHeight:e.maxHeight||420,onNavigate:v}))}function Se(e,t,n){let s=n||{};F(()=>{if(typeof e!="string"||e===""||typeof t!="string"||t==="")return;let i=!0,h=null,a=document.createElement("div");a.style.cssText="position:fixed;left:-10000px;top:0;width:1024px;height:800px;overflow:hidden",document.body.appendChild(a);let l=document.createElement("iframe");l.style.cssText="width:1024px;height:800px;border:0",a.appendChild(l);let m=null,x=null;async function w(){return m!==null?m:(x!==null||(m=Q(l,{title:"whales-design-live"}),x=(async()=>{let[r,o]=await Promise.all([Y(),K(s.packId)]);return m.init({runtime:r,styles:o.styles,bundle:o.bundle})})()),x)}async function v(r){let o=r.target||{},g=o.type==="artboard"?"artboard":"component",d=g==="artboard"?o.artboardId:o.name;try{await w();let c=await Z(e,g,d,0);if(c===null||c.code===""){await R({requestId:r.requestId,ok:!1,error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269"});return}let y=await L(e,g,d),M=y&&y.meta&&Array.isArray(y.meta.examples)?y.meta.examples:[],p=await m.render({name:d,code:c.code,props:M[Number(r.exampleIndex)||0]||{},dependencies:(c.deps||[]).map(T=>({name:T.name,code:T.code}))});await R({requestId:r.requestId,ok:p.ok!==!1,error:p.error||"",consoleErrors:p.consoleErrors||[],ms:p.ms,width:p.width,height:p.height,nodeCount:p.nodeCount,textLength:p.textLength,textSample:p.textSample,empty:p.empty,buttons:p.buttons,inputs:p.inputs,tables:p.tables})}catch(c){await R({requestId:r.requestId,ok:!1,error:String(c&&c.message||c)})}}async function R(r){try{await fetch(O+"/design/live/result",{method:"POST",headers:{"content-type":"application/json","x-whales-token":t},body:JSON.stringify(r)})}catch{}}async function f(){if(i){try{let r=await fetch(O+"/design/live?projectId="+encodeURIComponent(e),{headers:{"x-whales-token":t}});if(r.ok){let o=await r.json(),g=o&&o.data&&Array.isArray(o.data.requests)?o.data.requests:[];for(let d of g)await v(d)}}catch{}i&&(h=setTimeout(f,4e3))}}return f(),()=>{i=!1,h&&clearTimeout(h),m&&m.destroy(),a.remove()}},[e,t,s.packId])}async function Ce(e){let t=e&&e.data||{},n=e&&e.projectId?e.projectId:"",s=e.kind==="artboard"?"artboard":"component",i=s==="artboard"?t.artboardId:t.name,h=typeof e.token=="string"?e.token:"",[a,l,m]=await Promise.all([L(n,s,i),Y().catch(()=>""),K(t.packId).catch(()=>({styles:"",bundle:""}))]),x=document.createElement("div");x.style.cssText="position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px";let w=document.createElement("div");w.style.cssText="width:min(1280px,97vw);height:min(860px,94vh);background:#fff;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.35)";let v=document.createElement("div");v.style.cssText="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #dce2ee;font:13px system-ui";let R=document.createElement("b");R.textContent=a&&a.meta&&a.meta.title||i;let f=document.createElement("span");f.style.color="#8a93a6",f.textContent=i+".tsx",v.append(R,f);let r=document.createElement("span");r.style.cssText="margin-left:12px;font:11px system-ui;color:#8a93a6",v.appendChild(r);let o=document.createElement("button");o.textContent="\u89E3\u9501\u8BA9 AI \u7EE7\u7EED\u6539",o.style.cssText="margin-left:auto;font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer;display:none",v.appendChild(o);let g=document.createElement("button");g.textContent="\u4FDD\u5B58",g.style.cssText="font:12px system-ui;padding:4px 12px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer",v.appendChild(g);let d=document.createElement("button");d.textContent="\u5173\u95ED",d.style.cssText="font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer",d.onclick=()=>x.remove(),v.appendChild(d);let c=document.createElement("div");c.style.cssText="flex:1;display:flex;min-height:0";let y=document.createElement("div");y.style.cssText="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid #dce2ee";let M=document.createElement("textarea");M.spellcheck=!1,M.value=a?a.source:"",M.style.cssText="flex:1;width:100%;border:0;outline:none;resize:none;padding:14px;font:12px/1.6 ui-monospace,Consolas,monospace;background:#fbfcfe;color:#1e2430;tab-size:2",y.appendChild(M);let p=document.createElement("div");p.style.cssText="width:min(560px,46%);display:flex;flex-direction:column;min-width:0;background:#f6f8fb";let T=document.createElement("iframe");T.setAttribute("sandbox","allow-scripts"),T.setAttribute("srcdoc",X({title:"\u6E90\u7801\u9884\u89C8"})),T.style.cssText="flex:1;width:100%;border:0;background:#fff",p.appendChild(T),c.append(y,p);let S=document.createElement("div");S.style.cssText="display:none;padding:8px 12px;border-top:1px solid #fecaca;background:#fef2f2;color:#991b1b;font:11px/1.6 ui-monospace,Consolas,monospace;max-height:120px;overflow:auto;white-space:pre-wrap",w.append(v,c,S),x.appendChild(w),document.body.appendChild(x),x.addEventListener("click",E=>{E.target===x&&x.remove()});let C=null,q=a&&a.compiledCode||"";try{C=Q(T,{title:"\u6E90\u7801\u9884\u89C8"}),await C.init({runtime:l,styles:m.styles||"",bundle:m.bundle||""})}catch(E){r.textContent="\u6C99\u7BB1\u521D\u59CB\u5316\u5931\u8D25\uFF1A"+String(E&&E.message||E)}let _=null,H=0;async function ee(E){let I=++H;g.disabled=!0,r.textContent="\u7F16\u8BD1\u4E2D\u2026";try{let k=await(await fetch(O+"/design/compile",{method:"POST",headers:{"content-type":"application/json","x-whales-token":h},body:JSON.stringify({projectId:n,kind:s,name:s==="component"?i:void 0,artboardId:s==="artboard"?i:void 0,source:E})})).json();if(I!==H)return;if(!k||k.code!==200||!k.data||k.data.compile&&k.data.compile.ok===!1){let A=k&&k.data&&k.data.compile&&k.data.compile.errors?k.data.compile.errors:[];S.style.display="block",S.textContent=A.length>0?A.map(j=>j.message).join(`
`):String(k&&k.msg||"\u7F16\u8BD1\u5931\u8D25"),r.textContent="\u7F16\u8BD1\u5931\u8D25",g.disabled=!1;return}S.style.display="none",q=k.data.compiled||q,r.textContent="\u7F16\u8BD1\u901A\u8FC7",g.disabled=!1,C!==null&&await C.render({name:i,code:q,props:a&&a.meta&&a.meta.examples&&a.meta.examples[0]||{},isBoard:s==="artboard"})}catch(b){if(I!==H)return;S.style.display="block",S.textContent="\u7F16\u8BD1\u8BF7\u6C42\u5931\u8D25\uFF1A"+String(b&&b.message||b),g.disabled=!1}}if(M.addEventListener("input",()=>{_&&clearTimeout(_),_=setTimeout(()=>ee(M.value),500)}),g.onclick=async()=>{r.textContent="\u4FDD\u5B58\u4E2D\u2026";try{let I=await(await fetch(O+"/design/source",{method:"POST",headers:{"content-type":"application/json","x-whales-token":h},body:JSON.stringify({projectId:n,kind:s,name:s==="component"?i:void 0,artboardId:s==="artboard"?i:void 0,source:M.value})})).json();I&&I.code===200&&I.data&&I.data.written===!0?(r.textContent="\u5DF2\u4FDD\u5B58\uFF08agent \u4E4B\u540E\u4E0D\u80FD\u6539\u8FD9\u4E2A\u4E86\uFF09",ie(n,s,i),o.style.display=""):r.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(I&&I.msg||"\u672A\u77E5\u9519\u8BEF")}catch(E){r.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(E&&E.message||E)}},o.onclick=async()=>{r.textContent="\u89E3\u9501\u4E2D\u2026";try{let I=await(await fetch(O+"/design/unlock",{method:"POST",headers:{"content-type":"application/json","x-whales-token":h},body:JSON.stringify({projectId:n,kind:s,name:s==="component"?i:void 0,artboardId:s==="artboard"?i:void 0})})).json();r.textContent=I&&I.code===200&&I.data&&I.data.unlocked?"\u5DF2\u89E3\u9501\uFF0CAI \u53EF\u4EE5\u7EE7\u7EED\u6539":"\u89E3\u9501\u5931\u8D25\uFF1A"+String(I&&I.msg||""),o.style.display="none"}catch(E){r.textContent="\u89E3\u9501\u5931\u8D25\uFF1A"+String(E&&E.message||E)}},a&&a.userEdited===!0&&(o.style.display=""),q!==""&&C!==null)try{await C.render({name:i,code:q,props:a&&a.meta&&a.meta.examples&&a.meta.examples[0]||{},isBoard:s==="artboard"})}catch{}return{close:()=>x.remove()}}var Re={component:de,artboard:le},Ie="";

return module.exports;
} });

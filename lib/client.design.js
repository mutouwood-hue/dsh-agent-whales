/* dsh-agent-whales · client.design.js —— 由 tools/flow-chunk/build-design.mjs 生成，勿手改。
 * 组件工坊：组件 / 画板节点的沙箱预览与在线画布登记。只在画布上出现这两种节点时按需加载。 */
window.__ModuleLoader__.load({ id: "dsh-agent-whales", chunk: "client.design.js", factory: function (require) {
var module = { exports: {} }; var exports = module.exports;
var Y=Object.create;var T=Object.defineProperty;var Z=Object.getOwnPropertyDescriptor;var ee=Object.getOwnPropertyNames;var te=Object.getPrototypeOf,ne=Object.prototype.hasOwnProperty;var re=(e,t)=>{for(var n in t)T(e,n,{get:t[n],enumerable:!0})},J=(e,t,n,i)=>{if(t&&typeof t=="object"||typeof t=="function")for(let s of ee(t))!ne.call(e,s)&&s!==n&&T(e,s,{get:()=>t[s],enumerable:!(i=Z(t,s))||i.enumerable});return e};var oe=(e,t,n)=>(n=e!=null?Y(te(e)):{},J(t||!e||!e.__esModule?T(n,"default",{value:e,enumerable:!0}):n,e)),ae=e=>J(T({},"__esModule",{value:!0}),e);var me={};re(me,{DESIGN_CSS:()=>pe,DesignArtboardNode:()=>Q,DesignComponentNode:()=>K,SANDBOX_CSP:()=>A,createSandboxHost:()=>U,designNodeTypes:()=>ue,loadCompiled:()=>B,loadEntity:()=>R,loadPackText:()=>H,loadRuntimeText:()=>W,openSourceEditor:()=>le,sandboxSrcdoc:()=>L,useDesignLive:()=>de});module.exports=ae(me);var p=oe(require("react"),1);function se(e){let t=e||{},n=String(t.csp||"default-src 'none'"),i=String(t.title||"whales-design-sandbox");return`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${n}">
<title>${i}</title>
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
<script>${ie}<\/script>
</body></html>`}var ie=String.raw`
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
`,A="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";function L(e){return se(Object.assign({csp:A},e||{}))}var{useCallback:X,useEffect:O,useMemo:ye,useRef:$,useState:S}=p,C="/agent-whales/api",N=new Map,P=new Map;function W(){let e="runtime";if(N.has(e))return N.get(e);let t=fetch(C+"/design/runtime.js").then(n=>{if(!n.ok)throw new Error("\u8FD0\u884C\u65F6\u4E0B\u8F7D\u5931\u8D25 "+n.status);return n.text()});return N.set(e,t),t.catch(()=>N.delete(e)),t}function H(e){let t=typeof e=="string"&&e!==""?e:"shadcn";if(P.has(t))return P.get(t);let n=C+"/component-packs/"+encodeURIComponent(t),i=(async()=>{if(t==="shadcn"){let d=null;try{d=await(await fetch(C+"/design/pack-api?projectId=")).json()}catch{d=null}return{bundle:"",styles:"",api:d,builtin:!0}}let[s,l]=await Promise.all([fetch(n+"/bundle.js").then(d=>d.ok?d.text():""),fetch(n+"/styles.css").then(d=>d.ok?d.text():"",()=>"")]),o=null;try{o=await(await fetch(C+"/design/pack-api?packId="+encodeURIComponent(t))).json()}catch{o=null}return{bundle:s,styles:l,api:o,builtin:!1}})();return P.set(t,i),i.catch(()=>P.delete(t)),i}var G=0;function D(){G+=1;let e=new Uint8Array(16);if(typeof crypto!="undefined"&&typeof crypto.getRandomValues=="function")crypto.getRandomValues(e);else for(let t=0;t<e.length;t+=1)e[t]=Math.floor(Math.random()*256);return Array.from(e,t=>t.toString(16).padStart(2,"0")).join("")+"-"+G}function U(e,t){let n=t||{},i="",s=!1,l=[],o=null,d=!1,c=a=>{if(a.origin!=="null")return;let r=a.data||{};if(r.type==="booted"){d=!0;return}if(r.nonce===i){if(r.type==="ready"){s=!0;let u=l.splice(0);for(let g of u)g(r.info||{});return}if(r.type==="rendered"){if(o!==null){let u=o;o=null,u(r)}return}if(r.type==="pick"){typeof n.onPick=="function"&&n.onPick(r.pick);return}if(r.type==="navigate"){typeof n.onNavigate=="function"&&n.onNavigate(r.to);return}r.type==="error"&&typeof n.onError=="function"&&n.onError(r)}};window.addEventListener("message",c),e.setAttribute("sandbox","allow-scripts"),e.setAttribute("srcdoc",L({csp:A,title:n.title||"whales-design"}));function m(a){if(i=D(),!d){let r=Date.now();return new Promise(u=>{let g=()=>{if(d||Date.now()-r>6e3){u();return}setTimeout(g,60)};g()}).then(()=>h(a))}return h(a)}function h(a){return new Promise(r=>{l.push(r),e.contentWindow.postMessage({type:"init",nonce:i,runtime:a.runtime,styles:a.styles,packCode:a.bundle},"*"),setTimeout(()=>{s||r({timeout:!0})},8e3)})}function b(a){if(!s)return Promise.resolve({ok:!1,error:"\u6C99\u7BB1\u8FD8\u6CA1\u5C31\u7EEA"});let r=D();return i=r,new Promise(u=>{o=u,e.contentWindow.postMessage({type:"render",nonce:r,runId:a.runId||"run-"+Date.now(),mountId:a.mountId||"main",name:a.name,code:a.code,props:a.props||{},dependencies:a.dependencies||[]},"*"),setTimeout(()=>{o===u&&(o=null,u({ok:!1,error:"\u6E32\u67D3\u8D85\u65F6\uFF088 \u79D2\uFF09"}))},8e3)})}function y(a){if(!s)return;let r=D();i=r,e.contentWindow.postMessage({type:"pick-mode",nonce:r,enabled:!!a},"*")}return{init:m,render:b,setPickMode:y,destroy:function(){window.removeEventListener("message",c)},isReady:function(){return s}}}var _=new Map;function R(e,t,n){let i=e+"|"+t+"|"+n;if(_.has(i))return _.get(i);let s="?projectId="+encodeURIComponent(e)+"&kind="+t+"&id="+encodeURIComponent(n),l=fetch(C+"/design/source"+s).then(o=>o.ok?o.json():null).then(o=>!o||o.code!==200?null:o.data);return _.set(i,l),l.catch(()=>_.delete(i)),l}async function B(e,t,n,i){let s=await R(e,t,n);if(s===null)return null;let l=[],o=s.meta&&Array.isArray(s.meta.imports)?s.meta.imports:[];if(i<4)for(let d of o){let c=await B(e,"component",d,i+1);c!==null&&l.push(c)}return{name:n,code:s.compiledCode||"",deps:l,meta:s.meta,source:s.source}}var w={card:{background:"var(--daw-surface, #fff)",border:"1px solid var(--daw-border, #dce2ee)",borderRadius:12,boxShadow:"0 6px 18px rgba(0,0,0,.06)",overflow:"hidden"},head:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:12,cursor:"grab",whiteSpace:"nowrap"},tag:{fontSize:10,padding:"2px 6px",borderRadius:999,background:"var(--daw-accent-bg, #f9effa)",color:"var(--daw-accent, #c05bd0)",fontWeight:600},btn:{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1px solid var(--daw-border, #dce2ee)",background:"var(--daw-surface, #fff)",cursor:"pointer"},muted:{color:"var(--daw-text-muted, #8a93a6)"}},ce={mobile:390,desktop:1024};function V(e){let{projectId:t,kind:n,id:i,title:s,packId:l,entry:o,width:d,scale:c,maxHeight:m,exampleIndex:h,onReport:b,onNavigate:y}=e,a=$(null),r=$(null),[u,g]=S({status:"loading",error:"",info:null}),k=ce[d==="mobile"?"mobile":"desktop"];O(()=>{let v=!0,I=a.current;if(!I)return;let f=U(I,{title:s,onError:()=>{},onNavigate:y});return r.current=f,(async()=>{try{let[E,z]=await Promise.all([W(),H(l)]),q=await f.init({runtime:E,styles:z.styles,bundle:z.bundle});if(!v)return;if(q&&q.timeout){g({status:"error",error:"\u6C99\u7BB1\u521D\u59CB\u5316\u8D85\u65F6",info:null});return}let M=await B(t,n,i,0);if(!v)return;if(M===null||M.code===""){g({status:"error",error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269\uFF08\u6E90\u7801\u53EF\u80FD\u8FD8\u6CA1\u4FDD\u5B58\uFF09",info:q});return}let j=await f.render({name:i,code:M.code,props:o&&o.props||{},dependencies:(M.deps||[]).map(F=>({name:F.name,code:F.code})),isBoard:n==="artboard"});if(!v)return;g({status:j.ok?"ok":"error",error:j.error||"",info:j}),typeof b=="function"&&b(j)}catch(E){v&&g({status:"error",error:String(E&&E.message||E),info:null})}})(),()=>{v=!1,r.current&&r.current.destroy()}},[t,n,i,l,o&&o.key,h]);let x=Math.min(m||640,Math.max(120,u.info&&u.info.height||260));return p.createElement("div",{style:{position:"relative",width:Math.ceil(k*(c||1)),height:x,overflow:"hidden",background:"#fff"}},p.createElement("iframe",{ref:a,title:s||i,style:{border:0,width:k,height:Math.max(120,u.info&&u.info.height||480),transform:"scale("+(c||1)+")",transformOrigin:"0 0",pointerEvents:"none",display:"block"}}),u.status==="loading"?p.createElement("div",{style:{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#8a93a6",background:"rgba(255,255,255,.6)"}},"\u6C99\u7BB1\u6E32\u67D3\u4E2D\u2026"):null,u.status==="error"?p.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,border:"1px solid #dc2626",background:"#fef2f2",color:"#991b1b",borderRadius:8,padding:"6px 8px",fontSize:11,fontFamily:"ui-monospace, Consolas, monospace",maxHeight:120,overflow:"auto",whiteSpace:"pre-wrap"}},"\u6E32\u67D3\u51FA\u9519\uFF1A"+String(u.error).slice(0,400)):null)}function K(e){let t=e.data&&e.data.original||{},n=typeof t.name=="string"?t.name:"",i=typeof t.title=="string"?t.title:n,s=e.projectId||"",l=Number.isFinite(t.examplesCount)?t.examplesCount:0,[o,d]=S(0),[c,m]=S(null);O(()=>{let y=!0;return R(s,"component",n).then(a=>{y&&m(a)},()=>{}),()=>{y=!1}},[s,n]);let h=c&&c.meta&&Array.isArray(c.meta.examples)?c.meta.examples:[],b={key:n+"-"+o,props:h[o]||{}};return p.createElement("div",{style:w.card},p.createElement("div",{style:w.head},p.createElement("span",{style:{fontWeight:600}},i||n),p.createElement("span",{style:w.tag},"AI \xB7 \u7EC4\u4EF6"),p.createElement("span",{style:w.muted},n),l>1?p.createElement("span",{style:{display:"flex",gap:4,marginLeft:"auto"}},Array.from({length:Math.min(l,6)},(y,a)=>p.createElement("button",{key:a,onClick:r=>{r.stopPropagation(),d(a)},style:Object.assign({},w.btn,{borderColor:a===o?"var(--daw-accent, #c05bd0)":void 0,fontWeight:a===o?600:400})},"\u4F8B\u5B50 "+(a+1)))):null),p.createElement(V,{projectId:s,kind:"component",id:n,title:i,packId:t.packId,entry:b,exampleIndex:o,width:"desktop",scale:e.scale||.42,maxHeight:e.maxHeight||360}))}function Q(e){let t=e.data&&e.data.original||{},n=typeof t.artboardId=="string"?t.artboardId:"",i=typeof t.title=="string"?t.title:n,s=e.projectId||"",l=t.width==="mobile"?"mobile":"desktop",[o,d]=S([n]),c=o[o.length-1]||n,m=X(a=>{typeof a!="string"||a===""||d(r=>r[r.length-1]===a?r:r.concat([a]))},[]),h=X(()=>d(a=>a.length>1?a.slice(0,-1):a),[]),[b,y]=S(i);return O(()=>{let a=!0;if(c===n){y(i);return}return R(s,"artboard",c).then(r=>{a&&y(r&&r.meta&&r.meta.title?r.meta.title:c)},()=>{}),()=>{a=!1}},[s,n,c,i]),p.createElement("div",{style:w.card},p.createElement("div",{style:w.head},p.createElement("span",{style:{fontWeight:600}},b||c),p.createElement("span",{style:w.tag},"AI \xB7 \u753B\u677F"),p.createElement("span",{style:w.muted},l==="mobile"?"\u624B\u673A":"\u684C\u9762"),t.requirementId?p.createElement("span",{style:w.muted},"\xB7 \u9700\u6C42 "+String(t.requirementId).slice(0,12)):null,o.length>1?p.createElement("button",{onClick:a=>{a.stopPropagation(),h()},style:Object.assign({},w.btn,{marginLeft:"auto"}),title:"\u56DE\u5230\u4E0A\u4E00\u4E2A\u753B\u677F"},"\u2190 \u8FD4\u56DE ("+(o.length-1)+")"):null),p.createElement(V,{projectId:s,kind:"artboard",id:c,title:b,packId:t.packId,entry:{key:c+"-0",props:{}},width:l,scale:e.scale||.42,maxHeight:e.maxHeight||420,onNavigate:m}))}function de(e,t,n){let i=n||{};O(()=>{if(typeof e!="string"||e===""||typeof t!="string"||t==="")return;let s=!0,l=null,o=document.createElement("div");o.style.cssText="position:fixed;left:-10000px;top:0;width:1024px;height:800px;overflow:hidden",document.body.appendChild(o);let d=document.createElement("iframe");d.style.cssText="width:1024px;height:800px;border:0",o.appendChild(d);let c=null,m=null;async function h(){return c!==null?c:(m!==null||(c=U(d,{title:"whales-design-live"}),m=(async()=>{let[r,u]=await Promise.all([W(),H(i.packId)]);return c.init({runtime:r,styles:u.styles,bundle:u.bundle})})()),m)}async function b(r){let u=r.target||{},g=u.type==="artboard"?"artboard":"component",k=g==="artboard"?u.artboardId:u.name;try{await h();let x=await B(e,g,k,0);if(x===null||x.code===""){await y({requestId:r.requestId,ok:!1,error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269"});return}let v=await R(e,g,k),I=v&&v.meta&&Array.isArray(v.meta.examples)?v.meta.examples:[],f=await c.render({name:k,code:x.code,props:I[Number(r.exampleIndex)||0]||{},dependencies:(x.deps||[]).map(E=>({name:E.name,code:E.code}))});await y({requestId:r.requestId,ok:f.ok!==!1,error:f.error||"",consoleErrors:f.consoleErrors||[],ms:f.ms,width:f.width,height:f.height,nodeCount:f.nodeCount,textLength:f.textLength,textSample:f.textSample,empty:f.empty,buttons:f.buttons,inputs:f.inputs,tables:f.tables})}catch(x){await y({requestId:r.requestId,ok:!1,error:String(x&&x.message||x)})}}async function y(r){try{await fetch(C+"/design/live/result",{method:"POST",headers:{"content-type":"application/json","x-whales-token":t},body:JSON.stringify(r)})}catch{}}async function a(){if(s){try{let r=await fetch(C+"/design/live?projectId="+encodeURIComponent(e),{headers:{"x-whales-token":t}});if(r.ok){let u=await r.json(),g=u&&u.data&&Array.isArray(u.data.requests)?u.data.requests:[];for(let k of g)await b(k)}}catch{}s&&(l=setTimeout(a,4e3))}}return a(),()=>{s=!1,l&&clearTimeout(l),c&&c.destroy(),o.remove()}},[e,t,i.packId])}async function le(e){let t=e&&e.data||{},n=e&&e.projectId?e.projectId:"",i=e.kind==="artboard"?"artboard":"component",s=i==="artboard"?t.artboardId:t.name,l=await R(n,i,s),o=document.createElement("div");o.style.cssText="position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:24px";let d=document.createElement("div");d.style.cssText="width:min(1100px,96vw);height:min(800px,92vh);background:#fff;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.35)";let c=document.createElement("div");c.style.cssText="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #dce2ee;font:13px system-ui",c.innerHTML="<b>"+(l&&l.meta&&l.meta.title||s)+'</b><span style="color:#8a93a6">'+s+".tsx \xB7 \u53EA\u8BFB\uFF08P2 \u8D77\u53EF\u7F16\u8F91\uFF09</span>";let m=document.createElement("button");m.textContent="\u5173\u95ED",m.style.cssText="margin-left:auto;font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer",m.onclick=()=>o.remove(),c.appendChild(m);let h=document.createElement("pre");h.style.cssText="flex:1;margin:0;padding:14px;overflow:auto;font:12px/1.6 ui-monospace,Consolas,monospace;background:#fbfcfe;color:#1e2430;white-space:pre",h.textContent=l?l.source:"\uFF08\u8BFB\u4E0D\u5230\u6E90\u7801\uFF1A\u5B9E\u4F53\u53EF\u80FD\u8FD8\u6CA1\u4FDD\u5B58\uFF09",d.appendChild(c),d.appendChild(h),o.appendChild(d),o.addEventListener("click",b=>{b.target===o&&o.remove()}),document.body.appendChild(o)}var ue={component:K,artboard:Q},pe="";

return module.exports;
} });

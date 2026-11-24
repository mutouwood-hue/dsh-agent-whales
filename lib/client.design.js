/* dsh-agent-whales · client.design.js —— 由 tools/flow-chunk/build-design.mjs 生成，勿手改。
 * 组件工坊：组件 / 画板节点的沙箱预览与在线画布登记。只在画布上出现这两种节点时按需加载。 */
window.__ModuleLoader__.load({ id: "dsh-agent-whales", chunk: "client.design.js", factory: function (require) {
var module = { exports: {} }; var exports = module.exports;
var ae=Object.create;var L=Object.defineProperty;var se=Object.getOwnPropertyDescriptor;var ie=Object.getOwnPropertyNames;var ce=Object.getPrototypeOf,de=Object.prototype.hasOwnProperty;var le=(e,t)=>{for(var r in t)L(e,r,{get:t[r],enumerable:!0})},K=(e,t,r,s)=>{if(t&&typeof t=="object"||typeof t=="function")for(let a of ie(t))!de.call(e,a)&&a!==r&&L(e,a,{get:()=>t[a],enumerable:!(s=se(t,a))||s.enumerable});return e};var ue=(e,t,r)=>(r=e!=null?ae(ce(e)):{},K(t||!e||!e.__esModule?L(r,"default",{value:e,enumerable:!0}):r,e)),pe=e=>K(L({},"__esModule",{value:!0}),e);var ve={};le(ve,{DESIGN_CSS:()=>ke,DesignArtboardNode:()=>re,DesignComponentNode:()=>ne,SANDBOX_CSP:()=>H,createSandboxHost:()=>X,designNodeTypes:()=>we,invalidateEntity:()=>he,loadCompiled:()=>G,loadEntity:()=>_,loadPackText:()=>$,loadRuntimeText:()=>F,openSourceEditor:()=>xe,sandboxSrcdoc:()=>W,useDesignLive:()=>be});module.exports=pe(ve);var m=ue(require("react"),1);function me(e){let t=e||{},r=String(t.csp||"default-src 'none'"),s=String(t.title||"whales-design-sandbox");return`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${r}">
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
<script>${fe}<\/script>
</body></html>`}var fe=String.raw`
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
`,H="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";function W(e){return me(Object.assign({csp:H},e||{}))}var{useCallback:Q,useEffect:J,useMemo:Ie,useRef:Z,useState:B}=m,j="/agent-whales/api",U=new Map,z=new Map;function F(){let e="runtime";if(U.has(e))return U.get(e);let t=fetch(j+"/design/runtime.js").then(r=>{if(!r.ok)throw new Error("\u8FD0\u884C\u65F6\u4E0B\u8F7D\u5931\u8D25 "+r.status);return r.text()});return U.set(e,t),t.catch(()=>U.delete(e)),t}function $(e){let t=typeof e=="string"&&e!==""?e:"shadcn";if(z.has(t))return z.get(t);let r=j+"/component-packs/"+encodeURIComponent(t),s=(async()=>{if(t==="shadcn"){let c=null;try{c=await(await fetch(j+"/design/pack-api?projectId=")).json()}catch{c=null}return{bundle:"",styles:"",api:c,builtin:!0}}let[a,p]=await Promise.all([fetch(r+"/bundle.js").then(c=>c.ok?c.text():""),fetch(r+"/styles.css").then(c=>c.ok?c.text():"",()=>"")]),o=null;try{o=await(await fetch(j+"/design/pack-api?packId="+encodeURIComponent(t))).json()}catch{o=null}return{bundle:a,styles:p,api:o,builtin:!1}})();return z.set(t,s),s.catch(()=>z.delete(t)),s}var ee=0;function V(){ee+=1;let e=new Uint8Array(16);if(typeof crypto!="undefined"&&typeof crypto.getRandomValues=="function")crypto.getRandomValues(e);else for(let t=0;t<e.length;t+=1)e[t]=Math.floor(Math.random()*256);return Array.from(e,t=>t.toString(16).padStart(2,"0")).join("")+"-"+ee}function X(e,t){let r=t||{},s="",a=!1,p=[],o=null,c=!1,d=i=>{if(i.origin!=="null")return;let n=i.data||{};if(n.type==="booted"){c=!0;return}if(n.nonce===s){if(n.type==="ready"){a=!0;let l=p.splice(0);for(let u of l)u(n.info||{});return}if(n.type==="rendered"){if(o!==null){let l=o;o=null,l(n)}return}if(n.type==="pick"){typeof r.onPick=="function"&&r.onPick(n.pick);return}if(n.type==="navigate"){typeof r.onNavigate=="function"&&r.onNavigate(n.to);return}n.type==="error"&&typeof r.onError=="function"&&r.onError(n)}};window.addEventListener("message",d),e.setAttribute("sandbox","allow-scripts"),e.setAttribute("srcdoc",W({csp:H,title:r.title||"whales-design"}));function f(i){if(s=V(),!c){let n=Date.now();return new Promise(l=>{let u=()=>{if(c||Date.now()-n>6e3){l();return}setTimeout(u,60)};u()}).then(()=>E(i))}return E(i)}function E(i){return new Promise(n=>{p.push(n),e.contentWindow.postMessage({type:"init",nonce:s,runtime:i.runtime,styles:i.styles,packCode:i.bundle},"*"),setTimeout(()=>{a||n({timeout:!0})},8e3)})}function h(i){if(!a)return Promise.resolve({ok:!1,error:"\u6C99\u7BB1\u8FD8\u6CA1\u5C31\u7EEA"});let n=V();return s=n,new Promise(l=>{o=l,e.contentWindow.postMessage({type:"render",nonce:n,runId:i.runId||"run-"+Date.now(),mountId:i.mountId||"main",name:i.name,code:i.code,props:i.props||{},dependencies:i.dependencies||[]},"*"),setTimeout(()=>{o===l&&(o=null,l({ok:!1,error:"\u6E32\u67D3\u8D85\u65F6\uFF088 \u79D2\uFF09"}))},8e3)})}function b(i){if(!a)return;let n=V();s=n,e.contentWindow.postMessage({type:"pick-mode",nonce:n,enabled:!!i},"*")}return{init:f,render:h,setPickMode:b,destroy:function(){window.removeEventListener("message",d)},isReady:function(){return a}}}var O=new Map,ge=20*1e3;function _(e,t,r){let s=e+"|"+t+"|"+r,a=O.get(s);if(a!==void 0&&Date.now()-a.at<ge)return a.pending;let p="?projectId="+encodeURIComponent(e)+"&kind="+t+"&id="+encodeURIComponent(r),o=fetch(j+"/design/source"+p).then(c=>c.ok?c.json():null).then(c=>!c||c.code!==200?null:c.data);return O.set(s,{at:Date.now(),pending:o}),o.catch(()=>{let c=O.get(s);c!==void 0&&c.pending===o&&O.delete(s)}),o}function he(e,t,r){O.delete(e+"|"+t+"|"+r)}async function G(e,t,r,s){let a=await _(e,t,r);if(a===null)return null;let p=[],o=a.meta&&Array.isArray(a.meta.imports)?a.meta.imports:[];if(s<4)for(let c of o){let d=await G(e,"component",c,s+1);d!==null&&p.push(d)}return{name:r,code:a.compiledCode||"",deps:p,meta:a.meta,source:a.source}}var R={card:{background:"var(--daw-surface, #fff)",border:"1px solid var(--daw-border, #dce2ee)",borderRadius:12,boxShadow:"0 6px 18px rgba(0,0,0,.06)",overflow:"hidden"},head:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:12,cursor:"grab",whiteSpace:"nowrap"},tag:{fontSize:10,padding:"2px 6px",borderRadius:999,background:"var(--daw-accent-bg, #f9effa)",color:"var(--daw-accent, #c05bd0)",fontWeight:600},btn:{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1px solid var(--daw-border, #dce2ee)",background:"var(--daw-surface, #fff)",cursor:"pointer"},muted:{color:"var(--daw-text-muted, #8a93a6)"}},ye={mobile:390,desktop:1024};function te(e){let{projectId:t,kind:r,id:s,title:a,packId:p,entry:o,width:c,scale:d,maxHeight:f,exampleIndex:E,onReport:h,onNavigate:b,sourceHash:i}=e,n=Z(null),l=Z(null),[u,w]=B({status:"loading",error:"",info:null}),k=ye[c==="mobile"?"mobile":"desktop"];J(()=>{let v=!0,g=n.current;if(!g)return;let I=X(g,{title:a,onError:()=>{},onNavigate:b});return l.current=I,(async()=>{try{let[C,M]=await Promise.all([F(),$(p)]),A=await I.init({runtime:C,styles:M.styles,bundle:M.bundle});if(!v)return;if(A&&A.timeout){w({status:"error",error:"\u6C99\u7BB1\u521D\u59CB\u5316\u8D85\u65F6",info:null});return}let N=await G(t,r,s,0);if(!v)return;if(N===null||N.code===""){w({status:"error",error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269\uFF08\u6E90\u7801\u53EF\u80FD\u8FD8\u6CA1\u4FDD\u5B58\uFF09",info:A});return}let P=await I.render({name:s,code:N.code,props:o&&o.props||{},dependencies:(N.deps||[]).map(q=>({name:q.name,code:q.code})),isBoard:r==="artboard"});if(!v)return;w({status:P.ok?"ok":"error",error:P.error||"",info:P}),typeof h=="function"&&h(P)}catch(C){v&&w({status:"error",error:String(C&&C.message||C),info:null})}})(),()=>{v=!1,l.current&&l.current.destroy()}},[t,r,s,p,i,o&&o.key,E]);let T=Math.min(f||640,Math.max(120,u.info&&u.info.height||260));return m.createElement("div",{style:{position:"relative",width:Math.ceil(k*(d||1)),height:T,overflow:"hidden",background:"#fff"}},m.createElement("iframe",{ref:n,title:a||s,style:{border:0,width:k,height:Math.max(120,u.info&&u.info.height||480),transform:"scale("+(d||1)+")",transformOrigin:"0 0",pointerEvents:"none",display:"block"}}),u.status==="loading"?m.createElement("div",{style:{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#8a93a6",background:"rgba(255,255,255,.6)"}},"\u6C99\u7BB1\u6E32\u67D3\u4E2D\u2026"):null,u.status==="error"?m.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,border:"1px solid #dc2626",background:"#fef2f2",color:"#991b1b",borderRadius:8,padding:"6px 8px",fontSize:11,fontFamily:"ui-monospace, Consolas, monospace",maxHeight:120,overflow:"auto",whiteSpace:"pre-wrap"}},"\u6E32\u67D3\u51FA\u9519\uFF1A"+String(u.error).slice(0,400)):null)}function ne(e){let t=e.data&&e.data.original||{},r=typeof t.name=="string"?t.name:"",s=typeof t.title=="string"?t.title:r,a=e.projectId||"",p=Number.isFinite(t.examplesCount)?t.examplesCount:0,[o,c]=B(0),[d,f]=B(null);J(()=>{let b=!0;return _(a,"component",r).then(i=>{b&&f(i)},()=>{}),()=>{b=!1}},[a,r]);let E=d&&d.meta&&Array.isArray(d.meta.examples)?d.meta.examples:[],h={key:r+"-"+o,props:E[o]||{}};return m.createElement("div",{style:R.card},m.createElement("div",{style:R.head},m.createElement("span",{style:{fontWeight:600}},s||r),m.createElement("span",{style:R.tag},"AI \xB7 \u7EC4\u4EF6"),m.createElement("span",{style:R.muted},r),p>1?m.createElement("span",{style:{display:"flex",gap:4,marginLeft:"auto"}},Array.from({length:Math.min(p,6)},(b,i)=>m.createElement("button",{key:i,onClick:n=>{n.stopPropagation(),c(i)},style:Object.assign({},R.btn,{borderColor:i===o?"var(--daw-accent, #c05bd0)":void 0,fontWeight:i===o?600:400})},"\u4F8B\u5B50 "+(i+1)))):null),m.createElement(te,{projectId:a,kind:"component",id:r,title:s,packId:t.packId,entry:h,exampleIndex:o,sourceHash:t.sourceHash,width:"desktop",scale:e.scale||.42,maxHeight:e.maxHeight||360}))}function re(e){let t=e.data&&e.data.original||{},r=typeof t.artboardId=="string"?t.artboardId:"",s=typeof t.title=="string"?t.title:r,a=e.projectId||"",p=t.width==="mobile"?"mobile":"desktop",[o,c]=B([r]),d=o[o.length-1]||r,f=Q(i=>{typeof i!="string"||i===""||c(n=>n[n.length-1]===i?n:n.concat([i]))},[]),E=Q(()=>c(i=>i.length>1?i.slice(0,-1):i),[]),[h,b]=B(s);return J(()=>{let i=!0;if(d===r){b(s);return}return _(a,"artboard",d).then(n=>{i&&b(n&&n.meta&&n.meta.title?n.meta.title:d)},()=>{}),()=>{i=!1}},[a,r,d,s]),m.createElement("div",{style:R.card},m.createElement("div",{style:R.head},m.createElement("span",{style:{fontWeight:600}},h||d),m.createElement("span",{style:R.tag},"AI \xB7 \u753B\u677F"),m.createElement("span",{style:R.muted},p==="mobile"?"\u624B\u673A":"\u684C\u9762"),t.requirementId?m.createElement("span",{style:R.muted},"\xB7 \u9700\u6C42 "+String(t.requirementId).slice(0,12)):null,o.length>1?m.createElement("button",{onClick:i=>{i.stopPropagation(),E()},style:Object.assign({},R.btn,{marginLeft:"auto"}),title:"\u56DE\u5230\u4E0A\u4E00\u4E2A\u753B\u677F"},"\u2190 \u8FD4\u56DE ("+(o.length-1)+")"):null),m.createElement(te,{projectId:a,kind:"artboard",id:d,title:h,packId:t.packId,entry:{key:d+"-0",props:{}},sourceHash:d===r?t.sourceHash:void 0,width:p,scale:e.scale||.42,maxHeight:e.maxHeight||420,onNavigate:f}))}function be(e,t,r){let s=r||{};J(()=>{if(typeof e!="string"||e===""||typeof t!="string"||t==="")return;let a=!0,p=null,o=document.createElement("div");o.style.cssText="position:fixed;left:-10000px;top:0;width:1024px;height:800px;overflow:hidden",document.body.appendChild(o);let c=document.createElement("iframe");c.style.cssText="width:1024px;height:800px;border:0",o.appendChild(c);let d=null,f=null;async function E(){return d!==null?d:(f!==null||(d=X(c,{title:"whales-design-live"}),f=(async()=>{let[n,l]=await Promise.all([F(),$(s.packId)]);return d.init({runtime:n,styles:l.styles,bundle:l.bundle})})()),f)}async function h(n){let l=n.target||{},u=l.type==="artboard"?"artboard":"component",w=u==="artboard"?l.artboardId:l.name;try{await E();let k=await G(e,u,w,0);if(k===null||k.code===""){await b({requestId:n.requestId,ok:!1,error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269"});return}let T=await _(e,u,w),v=T&&T.meta&&Array.isArray(T.meta.examples)?T.meta.examples:[],g=await d.render({name:w,code:k.code,props:v[Number(n.exampleIndex)||0]||{},dependencies:(k.deps||[]).map(I=>({name:I.name,code:I.code}))});await b({requestId:n.requestId,ok:g.ok!==!1,error:g.error||"",consoleErrors:g.consoleErrors||[],ms:g.ms,width:g.width,height:g.height,nodeCount:g.nodeCount,textLength:g.textLength,textSample:g.textSample,empty:g.empty,buttons:g.buttons,inputs:g.inputs,tables:g.tables})}catch(k){await b({requestId:n.requestId,ok:!1,error:String(k&&k.message||k)})}}async function b(n){try{await fetch(j+"/design/live/result",{method:"POST",headers:{"content-type":"application/json","x-whales-token":t},body:JSON.stringify(n)})}catch{}}async function i(){if(a){try{let n=await fetch(j+"/design/live?projectId="+encodeURIComponent(e),{headers:{"x-whales-token":t}});if(n.ok){let l=await n.json(),u=l&&l.data&&Array.isArray(l.data.requests)?l.data.requests:[];for(let w of u)await h(w)}}catch{}a&&(p=setTimeout(i,4e3))}}return i(),()=>{a=!1,p&&clearTimeout(p),d&&d.destroy(),o.remove()}},[e,t,s.packId])}async function xe(e){let t=e&&e.data||{},r=e&&e.projectId?e.projectId:"",s=e.kind==="artboard"?"artboard":"component",a=s==="artboard"?t.artboardId:t.name,p=typeof e.token=="string"?e.token:"",[o,c,d]=await Promise.all([_(r,s,a),F().catch(()=>""),$(t.packId).catch(()=>({styles:"",bundle:""}))]),f=document.createElement("div");f.style.cssText="position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px";let E=document.createElement("div");E.style.cssText="width:min(1280px,97vw);height:min(860px,94vh);background:#fff;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.35)";let h=document.createElement("div");h.style.cssText="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #dce2ee;font:13px system-ui";let b=document.createElement("b");b.textContent=o&&o.meta&&o.meta.title||a;let i=document.createElement("span");i.style.color="#8a93a6",i.textContent=a+".tsx",h.append(b,i);let n=document.createElement("span");n.style.cssText="margin-left:12px;font:11px system-ui;color:#8a93a6",h.appendChild(n);let l=document.createElement("button");l.textContent="\u89E3\u9501\u8BA9 AI \u7EE7\u7EED\u6539",l.style.cssText="margin-left:auto;font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer;display:none",h.appendChild(l);let u=document.createElement("button");u.textContent="\u4FDD\u5B58",u.style.cssText="font:12px system-ui;padding:4px 12px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer",h.appendChild(u);let w=document.createElement("button");w.textContent="\u5173\u95ED",w.style.cssText="font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer",w.onclick=()=>f.remove(),h.appendChild(w);let k=document.createElement("div");k.style.cssText="flex:1;display:flex;min-height:0";let T=document.createElement("div");T.style.cssText="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid #dce2ee";let v=document.createElement("textarea");v.spellcheck=!1,v.value=o?o.source:"",v.style.cssText="flex:1;width:100%;border:0;outline:none;resize:none;padding:14px;font:12px/1.6 ui-monospace,Consolas,monospace;background:#fbfcfe;color:#1e2430;tab-size:2",T.appendChild(v);let g=document.createElement("div");g.style.cssText="width:min(560px,46%);display:flex;flex-direction:column;min-width:0;background:#f6f8fb";let I=document.createElement("iframe");I.setAttribute("sandbox","allow-scripts"),I.setAttribute("srcdoc",W({title:"\u6E90\u7801\u9884\u89C8"})),I.style.cssText="flex:1;width:100%;border:0;background:#fff",g.appendChild(I),k.append(T,g);let C=document.createElement("div");C.style.cssText="display:none;padding:8px 12px;border-top:1px solid #fecaca;background:#fef2f2;color:#991b1b;font:11px/1.6 ui-monospace,Consolas,monospace;max-height:120px;overflow:auto;white-space:pre-wrap",E.append(h,k,C),f.appendChild(E),document.body.appendChild(f),f.addEventListener("click",y=>{y.target===f&&f.remove()});let M=null,A=o&&o.compiledCode||"";try{M=X(I,{title:"\u6E90\u7801\u9884\u89C8"}),await M.init({runtime:c,styles:d.styles||"",bundle:d.bundle||""})}catch(y){n.textContent="\u6C99\u7BB1\u521D\u59CB\u5316\u5931\u8D25\uFF1A"+String(y&&y.message||y)}let N=null,P=0;async function q(y){let x=++P;u.disabled=!0,n.textContent="\u7F16\u8BD1\u4E2D\u2026";try{let S=await(await fetch(j+"/design/compile",{method:"POST",headers:{"content-type":"application/json","x-whales-token":p},body:JSON.stringify({projectId:r,kind:s,name:s==="component"?a:void 0,artboardId:s==="artboard"?a:void 0,source:y})})).json();if(x!==P)return;if(!S||S.code!==200||!S.data||S.data.compile&&S.data.compile.ok===!1){let Y=S&&S.data&&S.data.compile&&S.data.compile.errors?S.data.compile.errors:[];C.style.display="block",C.textContent=Y.length>0?Y.map(oe=>oe.message).join(`
`):String(S&&S.msg||"\u7F16\u8BD1\u5931\u8D25"),n.textContent="\u7F16\u8BD1\u5931\u8D25",u.disabled=!1;return}C.style.display="none",A=S.data.compiled||A,n.textContent="\u7F16\u8BD1\u901A\u8FC7",u.disabled=!1,M!==null&&await M.render({name:a,code:A,props:o&&o.meta&&o.meta.examples&&o.meta.examples[0]||{},isBoard:s==="artboard"})}catch(D){if(x!==P)return;C.style.display="block",C.textContent="\u7F16\u8BD1\u8BF7\u6C42\u5931\u8D25\uFF1A"+String(D&&D.message||D),u.disabled=!1}}if(v.addEventListener("input",()=>{N&&clearTimeout(N),N=setTimeout(()=>q(v.value),500)}),u.onclick=async()=>{n.textContent="\u4FDD\u5B58\u4E2D\u2026";try{let x=await(await fetch(j+"/design/source",{method:"POST",headers:{"content-type":"application/json","x-whales-token":p},body:JSON.stringify({projectId:r,kind:s,name:s==="component"?a:void 0,artboardId:s==="artboard"?a:void 0,source:v.value})})).json();x&&x.code===200&&x.data&&x.data.written===!0?(n.textContent="\u5DF2\u4FDD\u5B58\uFF08agent \u4E4B\u540E\u4E0D\u80FD\u6539\u8FD9\u4E2A\u4E86\uFF09",l.style.display=""):n.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(x&&x.msg||"\u672A\u77E5\u9519\u8BEF")}catch(y){n.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(y&&y.message||y)}},l.onclick=async()=>{n.textContent="\u89E3\u9501\u4E2D\u2026";try{let x=await(await fetch(j+"/design/unlock",{method:"POST",headers:{"content-type":"application/json","x-whales-token":p},body:JSON.stringify({projectId:r,kind:s,name:s==="component"?a:void 0,artboardId:s==="artboard"?a:void 0})})).json();n.textContent=x&&x.code===200&&x.data&&x.data.unlocked?"\u5DF2\u89E3\u9501\uFF0CAI \u53EF\u4EE5\u7EE7\u7EED\u6539":"\u89E3\u9501\u5931\u8D25\uFF1A"+String(x&&x.msg||""),l.style.display="none"}catch(y){n.textContent="\u89E3\u9501\u5931\u8D25\uFF1A"+String(y&&y.message||y)}},o&&o.userEdited===!0&&(l.style.display=""),A!==""&&M!==null)try{await M.render({name:a,code:A,props:o&&o.meta&&o.meta.examples&&o.meta.examples[0]||{},isBoard:s==="artboard"})}catch{}return{close:()=>f.remove()}}var we={component:ne,artboard:re},ke="";

return module.exports;
} });

/* dsh-agent-whales · client.design.js —— 由 tools/flow-chunk/build-design.mjs 生成，勿手改。
 * 组件工坊：组件 / 画板节点的沙箱预览与在线画布登记。只在画布上出现这两种节点时按需加载。 */
window.__ModuleLoader__.load({ id: "dsh-agent-whales", chunk: "client.design.js", factory: function (require) {
var module = { exports: {} }; var exports = module.exports;
var le=Object.create;var F=Object.defineProperty;var ue=Object.getOwnPropertyDescriptor;var pe=Object.getOwnPropertyNames;var me=Object.getPrototypeOf,fe=Object.prototype.hasOwnProperty;var ge=(e,t)=>{for(var r in t)F(e,r,{get:t[r],enumerable:!0})},oe=(e,t,r,a)=>{if(t&&typeof t=="object"||typeof t=="function")for(let s of pe(t))!fe.call(e,s)&&s!==r&&F(e,s,{get:()=>t[s],enumerable:!(a=ue(t,s))||a.enumerable});return e};var he=(e,t,r)=>(r=e!=null?le(me(e)):{},oe(t||!e||!e.__esModule?F(r,"default",{value:e,enumerable:!0}):r,e)),ye=e=>oe(F({},"__esModule",{value:!0}),e);var Ie={};ge(Ie,{DESIGN_CSS:()=>Re,DesignArtboardNode:()=>de,DesignComponentNode:()=>ce,SANDBOX_CSP:()=>$,createSandboxHost:()=>Q,designNodeTypes:()=>Se,invalidateEntity:()=>ke,loadCompiled:()=>Z,loadEntity:()=>D,loadPackText:()=>K,loadRuntimeText:()=>Y,openSourceEditor:()=>Ce,sandboxSrcdoc:()=>X,useDesignLive:()=>Ee});module.exports=ye(Ie);var p=he(require("react"),1);function be(e){let t=e||{},r=String(t.csp||"default-src 'none'"),a=String(t.title||"whales-design-sandbox");return`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${r}">
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
<script>${xe}<\/script>
</body></html>`}var xe=String.raw`
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
`,$="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";function X(e){return be(Object.assign({csp:$},e||{}))}var{useCallback:ne,useEffect:U,useMemo:Ae,useRef:ae,useState:B}=p,A="/agent-whales/api",G=new Map,V=new Map;function Y(){let e="runtime";if(G.has(e))return G.get(e);let t=fetch(A+"/design/runtime.js").then(r=>{if(!r.ok)throw new Error("\u8FD0\u884C\u65F6\u4E0B\u8F7D\u5931\u8D25 "+r.status);return r.text()});return G.set(e,t),t.catch(()=>G.delete(e)),t}function K(e){let t=typeof e=="string"&&e!==""?e:"shadcn";if(V.has(t))return V.get(t);let r=A+"/component-packs/"+encodeURIComponent(t),a=(async()=>{if(t==="shadcn"){let c=null;try{c=await(await fetch(A+"/design/pack-api?projectId=")).json()}catch{c=null}return{bundle:"",styles:"",api:c,builtin:!0}}let[s,m]=await Promise.all([fetch(r+"/bundle.js").then(c=>c.ok?c.text():""),fetch(r+"/styles.css").then(c=>c.ok?c.text():"",()=>"")]),o=null;try{o=await(await fetch(A+"/design/pack-api?packId="+encodeURIComponent(t))).json()}catch{o=null}return{bundle:s,styles:m,api:o,builtin:!1}})();return V.set(t,a),a.catch(()=>V.delete(t)),a}var se=0;function te(){se+=1;let e=new Uint8Array(16);if(typeof crypto!="undefined"&&typeof crypto.getRandomValues=="function")crypto.getRandomValues(e);else for(let t=0;t<e.length;t+=1)e[t]=Math.floor(Math.random()*256);return Array.from(e,t=>t.toString(16).padStart(2,"0")).join("")+"-"+se}function Q(e,t){let r=t||{},a="",s=!1,m=[],o=null,c=!1,d=i=>{if(i.origin!=="null")return;let n=i.data||{};if(n.type==="booted"){c=!0;return}if(n.nonce===a){if(n.type==="ready"){s=!0;let l=m.splice(0);for(let f of l)f(n.info||{});return}if(n.type==="rendered"){if(o!==null){let l=o;o=null,l(n)}return}if(n.type==="pick"){typeof r.onPick=="function"&&r.onPick(n.pick);return}if(n.type==="navigate"){typeof r.onNavigate=="function"&&r.onNavigate(n.to);return}n.type==="error"&&typeof r.onError=="function"&&r.onError(n)}};window.addEventListener("message",d),e.setAttribute("sandbox","allow-scripts"),e.setAttribute("srcdoc",X({csp:$,title:r.title||"whales-design"}));function h(i){if(a=te(),!c){let n=Date.now();return new Promise(l=>{let f=()=>{if(c||Date.now()-n>6e3){l();return}setTimeout(f,60)};f()}).then(()=>R(i))}return R(i)}function R(i){return new Promise(n=>{m.push(n),e.contentWindow.postMessage({type:"init",nonce:a,runtime:i.runtime,styles:i.styles,packCode:i.bundle},"*"),setTimeout(()=>{s||n({timeout:!0})},8e3)})}function x(i){if(!s)return Promise.resolve({ok:!1,error:"\u6C99\u7BB1\u8FD8\u6CA1\u5C31\u7EEA"});let n=te();return a=n,new Promise(l=>{o=l,e.contentWindow.postMessage({type:"render",nonce:n,runId:i.runId||"run-"+Date.now(),mountId:i.mountId||"main",name:i.name,code:i.code,props:i.props||{},dependencies:i.dependencies||[]},"*"),setTimeout(()=>{o===l&&(o=null,l({ok:!1,error:"\u6E32\u67D3\u8D85\u65F6\uFF088 \u79D2\uFF09"}))},8e3)})}function v(i){if(!s)return;let n=te();a=n,e.contentWindow.postMessage({type:"pick-mode",nonce:n,enabled:!!i},"*")}return{init:h,render:x,setPickMode:v,destroy:function(){window.removeEventListener("message",d)},isReady:function(){return s}}}var z=new Map,we=20*1e3;function D(e,t,r){let a=e+"|"+t+"|"+r,s=z.get(a);if(s!==void 0&&Date.now()-s.at<we)return s.pending;let m="?projectId="+encodeURIComponent(e)+"&kind="+t+"&id="+encodeURIComponent(r),o=fetch(A+"/design/source"+m).then(c=>c.ok?c.json():null).then(c=>!c||c.code!==200?null:c.data);return z.set(a,{at:Date.now(),pending:o}),o.catch(()=>{let c=z.get(a);c!==void 0&&c.pending===o&&z.delete(a)}),o}function ke(e,t,r){z.delete(e+"|"+t+"|"+r)}async function Z(e,t,r,a){let s=await D(e,t,r);if(s===null)return null;let m=[],o=s.meta&&Array.isArray(s.meta.imports)?s.meta.imports:[];if(a<4)for(let c of o){let d=await Z(e,"component",c,a+1);d!==null&&m.push(d)}return{name:r,code:s.compiledCode||"",deps:m,meta:s.meta,source:s.source}}var O={card:{background:"var(--daw-surface, #fff)",border:"1px solid var(--daw-border, #dce2ee)",borderRadius:12,boxShadow:"0 6px 18px rgba(0,0,0,.06)",overflow:"hidden"},head:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:12,cursor:"grab",whiteSpace:"nowrap"},tag:{fontSize:10,padding:"2px 6px",borderRadius:999,background:"var(--daw-accent-bg, #f9effa)",color:"var(--daw-accent, #c05bd0)",fontWeight:600},btn:{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1px solid var(--daw-border, #dce2ee)",background:"var(--daw-surface, #fff)",cursor:"pointer"},muted:{color:"var(--daw-text-muted, #8a93a6)"}},ve={mobile:390,desktop:1024};function ie(e){let{projectId:t,kind:r,id:a,title:s,packId:m,entry:o,width:c,scale:d,maxHeight:h,exampleIndex:R,onReport:x,onNavigate:v,sourceHash:i,token:n}=e,l=ae(null),f=ae(null),[w,E]=B({status:"loading",error:"",info:null}),[k,N]=B(!1),[u,T]=B(null),[I,_]=B(""),[q,P]=B(""),H=ve[c==="mobile"?"mobile":"desktop"];U(()=>{let g=f.current;g!==null&&typeof g.setPickMode=="function"&&g.setPickMode(k)},[k,w.status]);let ee=ne(async()=>{if(u===null)return;let g=String(I||"").trim();if(g!==""){P("\u63D0\u4EA4\u4E2D\u2026");try{let j=await(await fetch(A+"/design/comments?projectId="+encodeURIComponent(t),{method:"POST",headers:{"content-type":"application/json","x-whales-token":n||""},body:JSON.stringify({target:(r==="artboard"?"board:":"comp:")+a,wsrc:u.wsrc,line:u.line,column:u.column,tag:u.tag,nth:u.nth,count:u.count,body:g,sourceSnippet:u.sourceSnippet})})).json();j&&j.code===200?(P(j.data&&j.data.delivered==="sent"?"\u5DF2\u63D0\u4EA4\uFF0C\u5DF2\u53D1\u7ED9 agent":"\u5DF2\u63D0\u4EA4\uFF08agent \u672A\u5728\u7EBF\uFF0C\u5B83\u4E0B\u6B21\u8BFB comments \u80FD\u770B\u5230\uFF09"),T(null),_("")):P("\u5931\u8D25\uFF1A"+String(j&&j.msg||"\u672A\u77E5\u9519\u8BEF"))}catch(y){P("\u5931\u8D25\uFF1A"+String(y&&y.message||y))}}},[u,I,t,r,a,n]);U(()=>{let g=!0,y=l.current;if(!y)return;let j=Q(y,{title:s,onError:()=>{},onNavigate:v,onPick:S=>{!g||!S||!S.wsrc||D(t,r,a).then(W=>{if(!g)return;let M=(W&&Array.isArray(W.jsxTable)?W.jsxTable:[]).filter(L=>L&&L.wsrc===S.wsrc)[0];T({wsrc:S.wsrc,line:M?M.line:0,column:M?M.column:0,tag:S.tag||M&&M.tag||"",nth:S.nth||0,count:S.count||1,text:S.text||"",sourceSnippet:M&&M.snippet||""}),P("")},()=>{})}});return f.current=j,(async()=>{try{let[S,W]=await Promise.all([Y(),K(m)]),J=await j.init({runtime:S,styles:W.styles,bundle:W.bundle});if(!g)return;if(J&&J.timeout){E({status:"error",error:"\u6C99\u7BB1\u521D\u59CB\u5316\u8D85\u65F6",info:null});return}let M=await Z(t,r,a,0);if(!g)return;if(M===null||M.code===""){E({status:"error",error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269\uFF08\u6E90\u7801\u53EF\u80FD\u8FD8\u6CA1\u4FDD\u5B58\uFF09",info:J});return}let L=await j.render({name:a,code:M.code,props:o&&o.props||{},dependencies:(M.deps||[]).map(re=>({name:re.name,code:re.code})),isBoard:r==="artboard"});if(!g)return;E({status:L.ok?"ok":"error",error:L.error||"",info:L}),typeof x=="function"&&x(L)}catch(S){g&&E({status:"error",error:String(S&&S.message||S),info:null})}})(),()=>{g=!1,f.current&&f.current.destroy()}},[t,r,a,m,i,o&&o.key,R]);let b=Math.min(h||640,Math.max(120,w.info&&w.info.height||260)),C=typeof A=="string"?A:"/agent-whales/api";return p.createElement("div",{style:{position:"relative",width:Math.ceil(H*(d||1)),height:b,overflow:"hidden",background:"#fff"}},p.createElement("iframe",{ref:l,title:s||a,style:{border:0,width:H,height:Math.max(120,w.info&&w.info.height||480),transform:"scale("+(d||1)+")",transformOrigin:"0 0",pointerEvents:k?"auto":"none",display:"block"}}),w.status==="loading"?p.createElement("div",{style:{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#8a93a6",background:"rgba(255,255,255,.6)"}},"\u6C99\u7BB1\u6E32\u67D3\u4E2D\u2026"):null,w.status==="error"?p.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,border:"1px solid #dc2626",background:"#fef2f2",color:"#991b1b",borderRadius:8,padding:"6px 8px",fontSize:11,fontFamily:"ui-monospace, Consolas, monospace",maxHeight:120,overflow:"auto",whiteSpace:"pre-wrap"}},"\u6E32\u67D3\u51FA\u9519\uFF1A"+String(w.error).slice(0,400)):null,p.createElement("button",{type:"button",title:k?"\u9000\u51FA\u8BC4\u8BBA\u6A21\u5F0F":"\u8BC4\u8BBA\uFF1A\u70B9\u9875\u9762\u4E0A\u7684\u5143\u7D20\u7559\u610F\u89C1",onClick:g=>{g.stopPropagation(),N(!k),k&&(T(null),P(""))},style:{position:"absolute",right:6,top:6,zIndex:2,font:"11px system-ui",padding:"2px 7px",borderRadius:999,border:"1px solid "+(k?"#2563eb":"#dce2ee"),background:k?"#2563eb":"rgba(255,255,255,.92)",color:k?"#fff":"#5b6577",cursor:"pointer"}},k?"\u8BC4\u8BBA\u4E2D\u2026":"\u{1F4AC} \u8BC4\u8BBA"),u!==null?p.createElement("div",{style:{position:"absolute",left:8,right:8,bottom:8,zIndex:3,background:"#fff",border:"1px solid #2563eb",borderRadius:8,padding:"8px 10px",boxShadow:"0 8px 24px rgba(15,23,42,.18)",font:"12px system-ui"}},p.createElement("div",{style:{color:"#5b6577",marginBottom:4}},String(u.tag||"\u5143\u7D20")+(u.line?" \xB7 \u7B2C "+u.line+" \u884C":"")+(Number(u.count)>1?" \xB7 \u540C\u6B3E\u7B2C "+(Number(u.nth)+1)+" \u4E2A":"")),p.createElement("textarea",{autoFocus:!0,value:I,placeholder:"\u8FD9\u91CC\u8981\u600E\u4E48\u6539\uFF1F\uFF08\u4F8B\u5982\uFF1A\u6807\u9898\u592A\u5927 / \u6362\u4E2A\u989C\u8272\uFF09",onChange:g=>_(g.target.value),style:{width:"100%",boxSizing:"border-box",height:56,resize:"vertical",font:"12px system-ui",padding:6,borderRadius:6,border:"1px solid #dce2ee"}}),p.createElement("div",{style:{display:"flex",gap:6,marginTop:6,alignItems:"center"}},p.createElement("button",{type:"button",onClick:ee,disabled:String(I||"").trim()==="",style:{font:"12px system-ui",padding:"3px 12px",borderRadius:6,border:"1px solid #2563eb",background:String(I||"").trim()===""?"#c7d2fe":"#2563eb",color:"#fff",cursor:String(I||"").trim()===""?"default":"pointer"}},"\u63D0\u4EA4"),p.createElement("button",{type:"button",onClick:()=>{T(null),_(""),P("")},style:{font:"12px system-ui",padding:"3px 10px",borderRadius:6,border:"1px solid #dce2ee",background:"#fff",cursor:"pointer"}},"\u53D6\u6D88"),p.createElement("span",{style:{color:"#5b6577",marginLeft:"auto"}},q))):null)}function ce(e){let t=e.data&&e.data.original||{},r=typeof t.name=="string"?t.name:"",a=typeof t.title=="string"?t.title:r,s=e.projectId||"",m=Number.isFinite(t.examplesCount)?t.examplesCount:0,[o,c]=B(0),[d,h]=B(null);U(()=>{let v=!0;return D(s,"component",r).then(i=>{v&&h(i)},()=>{}),()=>{v=!1}},[s,r]);let R=d&&d.meta&&Array.isArray(d.meta.examples)?d.meta.examples:[],x={key:r+"-"+o,props:R[o]||{}};return p.createElement("div",{style:O.card},p.createElement("div",{style:O.head},p.createElement("span",{style:{fontWeight:600}},a||r),p.createElement("span",{style:O.tag},"AI \xB7 \u7EC4\u4EF6"),p.createElement("span",{style:O.muted},r),m>1?p.createElement("span",{style:{display:"flex",gap:4,marginLeft:"auto"}},Array.from({length:Math.min(m,6)},(v,i)=>p.createElement("button",{key:i,onClick:n=>{n.stopPropagation(),c(i)},style:Object.assign({},O.btn,{borderColor:i===o?"var(--daw-accent, #c05bd0)":void 0,fontWeight:i===o?600:400})},"\u4F8B\u5B50 "+(i+1)))):null),p.createElement(ie,{projectId:s,kind:"component",id:r,title:a,packId:t.packId,token:e.token,entry:x,exampleIndex:o,sourceHash:t.sourceHash,width:"desktop",scale:e.scale||.42,maxHeight:e.maxHeight||360}))}function de(e){let t=e.data&&e.data.original||{},r=typeof t.artboardId=="string"?t.artboardId:"",a=typeof t.title=="string"?t.title:r,s=e.projectId||"",m=t.width==="mobile"?"mobile":"desktop",[o,c]=B([r]),d=o[o.length-1]||r,h=ne(i=>{typeof i!="string"||i===""||c(n=>n[n.length-1]===i?n:n.concat([i]))},[]),R=ne(()=>c(i=>i.length>1?i.slice(0,-1):i),[]),[x,v]=B(a);return U(()=>{let i=!0;if(d===r){v(a);return}return D(s,"artboard",d).then(n=>{i&&v(n&&n.meta&&n.meta.title?n.meta.title:d)},()=>{}),()=>{i=!1}},[s,r,d,a]),p.createElement("div",{style:O.card},p.createElement("div",{style:O.head},p.createElement("span",{style:{fontWeight:600}},x||d),p.createElement("span",{style:O.tag},"AI \xB7 \u753B\u677F"),p.createElement("span",{style:O.muted},m==="mobile"?"\u624B\u673A":"\u684C\u9762"),t.requirementId?p.createElement("span",{style:O.muted},"\xB7 \u9700\u6C42 "+String(t.requirementId).slice(0,12)):null,o.length>1?p.createElement("button",{onClick:i=>{i.stopPropagation(),R()},style:Object.assign({},O.btn,{marginLeft:"auto"}),title:"\u56DE\u5230\u4E0A\u4E00\u4E2A\u753B\u677F"},"\u2190 \u8FD4\u56DE ("+(o.length-1)+")"):null),p.createElement(ie,{projectId:s,kind:"artboard",id:d,title:x,packId:t.packId,token:e.token,entry:{key:d+"-0",props:{}},sourceHash:d===r?t.sourceHash:void 0,width:m,scale:e.scale||.42,maxHeight:e.maxHeight||420,onNavigate:h}))}function Ee(e,t,r){let a=r||{};U(()=>{if(typeof e!="string"||e===""||typeof t!="string"||t==="")return;let s=!0,m=null,o=document.createElement("div");o.style.cssText="position:fixed;left:-10000px;top:0;width:1024px;height:800px;overflow:hidden",document.body.appendChild(o);let c=document.createElement("iframe");c.style.cssText="width:1024px;height:800px;border:0",o.appendChild(c);let d=null,h=null;async function R(){return d!==null?d:(h!==null||(d=Q(c,{title:"whales-design-live"}),h=(async()=>{let[n,l]=await Promise.all([Y(),K(a.packId)]);return d.init({runtime:n,styles:l.styles,bundle:l.bundle})})()),h)}async function x(n){let l=n.target||{},f=l.type==="artboard"?"artboard":"component",w=f==="artboard"?l.artboardId:l.name;try{await R();let E=await Z(e,f,w,0);if(E===null||E.code===""){await v({requestId:n.requestId,ok:!1,error:"\u62FF\u4E0D\u5230\u7F16\u8BD1\u4EA7\u7269"});return}let k=await D(e,f,w),N=k&&k.meta&&Array.isArray(k.meta.examples)?k.meta.examples:[],u=await d.render({name:w,code:E.code,props:N[Number(n.exampleIndex)||0]||{},dependencies:(E.deps||[]).map(T=>({name:T.name,code:T.code}))});await v({requestId:n.requestId,ok:u.ok!==!1,error:u.error||"",consoleErrors:u.consoleErrors||[],ms:u.ms,width:u.width,height:u.height,nodeCount:u.nodeCount,textLength:u.textLength,textSample:u.textSample,empty:u.empty,buttons:u.buttons,inputs:u.inputs,tables:u.tables})}catch(E){await v({requestId:n.requestId,ok:!1,error:String(E&&E.message||E)})}}async function v(n){try{await fetch(A+"/design/live/result",{method:"POST",headers:{"content-type":"application/json","x-whales-token":t},body:JSON.stringify(n)})}catch{}}async function i(){if(s){try{let n=await fetch(A+"/design/live?projectId="+encodeURIComponent(e),{headers:{"x-whales-token":t}});if(n.ok){let l=await n.json(),f=l&&l.data&&Array.isArray(l.data.requests)?l.data.requests:[];for(let w of f)await x(w)}}catch{}s&&(m=setTimeout(i,4e3))}}return i(),()=>{s=!1,m&&clearTimeout(m),d&&d.destroy(),o.remove()}},[e,t,a.packId])}async function Ce(e){let t=e&&e.data||{},r=e&&e.projectId?e.projectId:"",a=e.kind==="artboard"?"artboard":"component",s=a==="artboard"?t.artboardId:t.name,m=typeof e.token=="string"?e.token:"",[o,c,d]=await Promise.all([D(r,a,s),Y().catch(()=>""),K(t.packId).catch(()=>({styles:"",bundle:""}))]),h=document.createElement("div");h.style.cssText="position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px";let R=document.createElement("div");R.style.cssText="width:min(1280px,97vw);height:min(860px,94vh);background:#fff;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.35)";let x=document.createElement("div");x.style.cssText="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #dce2ee;font:13px system-ui";let v=document.createElement("b");v.textContent=o&&o.meta&&o.meta.title||s;let i=document.createElement("span");i.style.color="#8a93a6",i.textContent=s+".tsx",x.append(v,i);let n=document.createElement("span");n.style.cssText="margin-left:12px;font:11px system-ui;color:#8a93a6",x.appendChild(n);let l=document.createElement("button");l.textContent="\u89E3\u9501\u8BA9 AI \u7EE7\u7EED\u6539",l.style.cssText="margin-left:auto;font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer;display:none",x.appendChild(l);let f=document.createElement("button");f.textContent="\u4FDD\u5B58",f.style.cssText="font:12px system-ui;padding:4px 12px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer",x.appendChild(f);let w=document.createElement("button");w.textContent="\u5173\u95ED",w.style.cssText="font:12px system-ui;padding:4px 10px;border-radius:6px;border:1px solid #dce2ee;background:#fff;cursor:pointer",w.onclick=()=>h.remove(),x.appendChild(w);let E=document.createElement("div");E.style.cssText="flex:1;display:flex;min-height:0";let k=document.createElement("div");k.style.cssText="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid #dce2ee";let N=document.createElement("textarea");N.spellcheck=!1,N.value=o?o.source:"",N.style.cssText="flex:1;width:100%;border:0;outline:none;resize:none;padding:14px;font:12px/1.6 ui-monospace,Consolas,monospace;background:#fbfcfe;color:#1e2430;tab-size:2",k.appendChild(N);let u=document.createElement("div");u.style.cssText="width:min(560px,46%);display:flex;flex-direction:column;min-width:0;background:#f6f8fb";let T=document.createElement("iframe");T.setAttribute("sandbox","allow-scripts"),T.setAttribute("srcdoc",X({title:"\u6E90\u7801\u9884\u89C8"})),T.style.cssText="flex:1;width:100%;border:0;background:#fff",u.appendChild(T),E.append(k,u);let I=document.createElement("div");I.style.cssText="display:none;padding:8px 12px;border-top:1px solid #fecaca;background:#fef2f2;color:#991b1b;font:11px/1.6 ui-monospace,Consolas,monospace;max-height:120px;overflow:auto;white-space:pre-wrap",R.append(x,E,I),h.appendChild(R),document.body.appendChild(h),h.addEventListener("click",b=>{b.target===h&&h.remove()});let _=null,q=o&&o.compiledCode||"";try{_=Q(T,{title:"\u6E90\u7801\u9884\u89C8"}),await _.init({runtime:c,styles:d.styles||"",bundle:d.bundle||""})}catch(b){n.textContent="\u6C99\u7BB1\u521D\u59CB\u5316\u5931\u8D25\uFF1A"+String(b&&b.message||b)}let P=null,H=0;async function ee(b){let C=++H;f.disabled=!0,n.textContent="\u7F16\u8BD1\u4E2D\u2026";try{let y=await(await fetch(A+"/design/compile",{method:"POST",headers:{"content-type":"application/json","x-whales-token":m},body:JSON.stringify({projectId:r,kind:a,name:a==="component"?s:void 0,artboardId:a==="artboard"?s:void 0,source:b})})).json();if(C!==H)return;if(!y||y.code!==200||!y.data||y.data.compile&&y.data.compile.ok===!1){let j=y&&y.data&&y.data.compile&&y.data.compile.errors?y.data.compile.errors:[];I.style.display="block",I.textContent=j.length>0?j.map(S=>S.message).join(`
`):String(y&&y.msg||"\u7F16\u8BD1\u5931\u8D25"),n.textContent="\u7F16\u8BD1\u5931\u8D25",f.disabled=!1;return}I.style.display="none",q=y.data.compiled||q,n.textContent="\u7F16\u8BD1\u901A\u8FC7",f.disabled=!1,_!==null&&await _.render({name:s,code:q,props:o&&o.meta&&o.meta.examples&&o.meta.examples[0]||{},isBoard:a==="artboard"})}catch(g){if(C!==H)return;I.style.display="block",I.textContent="\u7F16\u8BD1\u8BF7\u6C42\u5931\u8D25\uFF1A"+String(g&&g.message||g),f.disabled=!1}}if(N.addEventListener("input",()=>{P&&clearTimeout(P),P=setTimeout(()=>ee(N.value),500)}),f.onclick=async()=>{n.textContent="\u4FDD\u5B58\u4E2D\u2026";try{let C=await(await fetch(A+"/design/source",{method:"POST",headers:{"content-type":"application/json","x-whales-token":m},body:JSON.stringify({projectId:r,kind:a,name:a==="component"?s:void 0,artboardId:a==="artboard"?s:void 0,source:N.value})})).json();C&&C.code===200&&C.data&&C.data.written===!0?(n.textContent="\u5DF2\u4FDD\u5B58\uFF08agent \u4E4B\u540E\u4E0D\u80FD\u6539\u8FD9\u4E2A\u4E86\uFF09",l.style.display=""):n.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(C&&C.msg||"\u672A\u77E5\u9519\u8BEF")}catch(b){n.textContent="\u4FDD\u5B58\u5931\u8D25\uFF1A"+String(b&&b.message||b)}},l.onclick=async()=>{n.textContent="\u89E3\u9501\u4E2D\u2026";try{let C=await(await fetch(A+"/design/unlock",{method:"POST",headers:{"content-type":"application/json","x-whales-token":m},body:JSON.stringify({projectId:r,kind:a,name:a==="component"?s:void 0,artboardId:a==="artboard"?s:void 0})})).json();n.textContent=C&&C.code===200&&C.data&&C.data.unlocked?"\u5DF2\u89E3\u9501\uFF0CAI \u53EF\u4EE5\u7EE7\u7EED\u6539":"\u89E3\u9501\u5931\u8D25\uFF1A"+String(C&&C.msg||""),l.style.display="none"}catch(b){n.textContent="\u89E3\u9501\u5931\u8D25\uFF1A"+String(b&&b.message||b)}},o&&o.userEdited===!0&&(l.style.display=""),q!==""&&_!==null)try{await _.render({name:s,code:q,props:o&&o.meta&&o.meta.examples&&o.meta.examples[0]||{},isBoard:a==="artboard"})}catch{}return{close:()=>h.remove()}}var Se={component:ce,artboard:de},Re="";

return module.exports;
} });

/**
 * 离线冒烟测试用的最小 React 垫片 + 插件加载器。
 *
 * 目的：在没有浏览器、也没有真 React 的环境里，把 lib/client.js 当成
 * 浏览器半边真实加载一次（同样的 __ModuleLoader__ 信封、同样的 factory(require)），
 * 从而验证：注册 id、包名一致、apply 注册的槽位、以及组件能否渲染出正确数量的鲸鱼。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const pluginDir = join(here, "..");
export const clientPath = join(pluginDir, "lib", "client.js");

/** 极简 React：只支持本插件用到的 createElement + 4 个 hook。 */
export function createReactShim() {
  return {
    createElement(type, props, ...children) {
      const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
      return { type, props: Object.assign({}, props || {}, { children: flat }) };
    },
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useRef(initial) {
      return { current: initial };
    },
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    }
  };
}

/**
 * 加载客户端半边，返回 { registration, plugin, react, requireLog, win, storage }。
 *
 * options.stored            —— dsh-agent-whales.settings 键的原始字符串（脏数据测试用）
 * options.storedPositions   —— dsh-agent-whales.positions 键的原始字符串
 * options.noStorage         —— true 时 window.localStorage 整个不存在（隐私模式/非浏览器）
 * options.throwOnGet        —— true 时 getItem 抛错（SecurityError）
 * options.throwOnSet        —— true 时 setItem 抛错（QuotaExceededError）
 * options.fetch             —— 假的 window.fetch：画布页不发请求就没数据，只能测「不抛错」
 * 两个键分开，是因为它们由 client.js 里两个独立的 store 读取；混成一个键会
 * 让「脏设置」与「脏坐标」互相污染，测不出真实的回退路径。
 */
export function loadPlugin(options = {}) {
  const react = options.react ?? createReactShim();
  const requireLog = [];
  let registration = null;
  const SETTINGS_KEY = "dsh-agent-whales.settings";
  const POSITIONS_KEY = "dsh-agent-whales.positions";
  const storage = new Map();
  if (options.stored !== undefined) storage.set(SETTINGS_KEY, String(options.stored));
  if (options.storedPositions !== undefined) storage.set(POSITIONS_KEY, String(options.storedPositions));
  // 通用预置：让用例在插件加载前就往 localStorage 里塞任意键（如 last-view），
  // 才能测「初始化时 recall」这类只在模块加载时跑一次的路径。
  if (options.storedExtra && typeof options.storedExtra === "object") {
    for (const key of Object.keys(options.storedExtra)) storage.set(String(key), String(options.storedExtra[key]));
  }
  const win = {
    localStorage: options.noStorage === true ? undefined : {
      get value() { return storage.has(SETTINGS_KEY) ? storage.get(SETTINGS_KEY) : null; },
      set value(next) {
        if (next === null) storage.delete(SETTINGS_KEY);
        else storage.set(SETTINGS_KEY, String(next));
      },
      getItem(key) {
        if (options.throwOnGet === true) throw new Error("SecurityError: localStorage is blocked");
        return storage.has(String(key)) ? storage.get(String(key)) : null;
      },
      setItem(key, next) {
        if (options.throwOnSet === true) throw new Error("QuotaExceededError: localStorage is full");
        storage.set(String(key), String(next));
      },
      removeItem(key) { storage.delete(String(key)); }
    },
    __ModuleLoader__: {
      load(reg) { registration = reg; }
    }
  };
  // 假的 fetch 必须挂在 window 上：client.js 的 resolveFetch() 优先读 window.fetch。
  // 只做最小 {ok,status,json} 形态，url 原样透出，用例按 url 分流 canned 数据。
  if (typeof options.fetch === "function") {
    win.fetch = function (url, init) {
      return Promise.resolve().then(() => options.fetch(String(url), init)).then((payload) => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payload)
      }));
    };
  }
  const code = readFileSync(clientPath, "utf8");
  // eslint-disable-next-line no-new-func
  new Function("window", code)(win);
  if (registration === null) throw new Error("client.js 没有调用 window.__ModuleLoader__.load");
  const plugin = registration.factory((spec) => {
    requireLog.push(spec);
    if (spec === "react") return react;
    throw new Error("client.js 只允许 require(\"react\")，出现了：" + spec);
  });
  return { registration, plugin, react, requireLog, win, storage };
}

/** 最小 DOM/navigator 垫片，供 apply() 里的样式注入使用。 */
export function installDocumentStub(target = globalThis) {
  const appended = [];
  const listeners = new Map();
  const head = {
    appendChild(node) { appended.push(node); node.parentNode = head; return node; },
    removeChild(node) {
      const index = appended.indexOf(node);
      if (index >= 0) appended.splice(index, 1);
      node.parentNode = null;
      return node;
    }
  };
  const document = {
    head,
    hidden: false,
    getElementById(id) { return appended.find((node) => node.id === id) ?? null; },
    createElement(tag) {
      return {
        tagName: tag, id: "", dataset: {}, textContent: "", parentNode: null
      };
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); }
  };
  target.document = document;
  return { document, appended, head, listeners };
}

/** 递归遍历 React 元素树。 */
export function walk(node, visit) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (typeof node !== "object") return;
  visit(node);
  walk(node.props ? node.props.children : undefined, visit);
}

/** 假的已挂载元素。只有 getBoundingClientRect 是画布真会用的。
 *  左上角对齐原点：stagePoint 就会退化成 {x: clientX, y: clientY}，
 *  于是「点某个坐标」=「算那个节点在画布上的中心」，好构造也不好读错。 */
function mountedStub() {
  return {
    getBoundingClientRect() { return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    style: {},
    dataset: {}
  };
}

/**
 * 展开函数组件，得到纯宿主元素的树。
 * 垫片里的 hook 都是无状态的，所以直接调用组件函数即可。
 */
export function render(node) {
  if (node === null || node === undefined || typeof node === "boolean") return node;
  if (Array.isArray(node)) return node.map(render);
  if (typeof node !== "object") return node;
  if (typeof node.type === "function") return render(node.type(node.props));
  // ref 必须挂：React 渲染时会把 useRef 的 current 指到真实 DOM 节点。
  // 垫片不挂的话 stageRef.current 永远是 null，stagePoint 直接返回 {0,0}，
  // 画布上一切指针交互（建线 / 拖拽 / 删除）都模拟不出来。
  const ref = node.props ? node.props.ref : undefined;
  if (typeof ref === "function") ref(mountedStub());
  else if (ref && typeof ref === "object") ref.current = mountedStub();
  return {
    type: node.type,
    props: Object.assign({}, node.props, { children: render(node.props ? node.props.children : undefined) })
  };
}

/** 按 className 前缀收集渲染结果里的节点。 */
export function findByClass(tree, className) {
  const found = [];
  walk(tree, (node) => {
    const cls = node.props && node.props.className;
    if (typeof cls === "string" && cls.split(" ").indexOf(className) >= 0) found.push(node);
  });
  return found;
}

/**
 * 带真实 state 的挂载器。
 *
 * 上面的 render() 是无状态的：useState 的 setter 是 no-op，所以「点一下 → 状态变 →
 * 树变」这条链根本模拟不出来，而画布的核心交互（建线 / 删线 / 一键全清）全在这条链上。
 *
 * 这里按「组件函数 + hook 调用序号」给每个 hook 一个格子，setter 改格子并置脏，
 * 外层循环重画到不脏为止。相当于一个几十行的迷你 React，够跑交互测试。
 *
 *   const { shim, mount } = createMount();
 *   const loaded = loadPlugin({ react: shim, fetch });
 *   const view = mount(WbCanvasPage, { t: MARK, projectId: "p1" });
 *   view.tree        —— 当前渲染树（handler 会变，每次交互后要重新取）
 *   view.rerender()  —— 缓存变了（invalidate 之后）手动重画
 */
export function createMount() {
  const hooks = new Map();
  const stack = [];
  let dirty = false;
  let passes = 0;
  let tree = null;

  const shim = {
    // client.js 第 36 行是 react.createElement，名字不能改
    createElement: function (type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
      return { type: type, props: Object.assign({}, props || {}, { children: flat }) };
    },
    useState: function (initial) {
      const frame = stack[stack.length - 1];
      const key = frame.id + "#" + frame.index++;
      if (!hooks.has(key)) hooks.set(key, { value: typeof initial === "function" ? initial() : initial });
      const cell = hooks.get(key);
      return [cell.value, function (next) {
        cell.value = typeof next === "function" ? next(cell.value) : next;
        dirty = true;
      }];
    },
    useRef: function (initial) {
      const frame = stack[stack.length - 1];
      const key = frame.id + "#" + frame.index++;
      if (!hooks.has(key)) hooks.set(key, { current: initial });
      return hooks.get(key);
    },
    useEffect: function () {},
    useSyncExternalStore: function (_subscribe, getSnapshot) { return getSnapshot(); }
  };

  function draw(node) {
    if (node === null || node === undefined || typeof node === "boolean") return node;
    if (Array.isArray(node)) return node.map(draw);
    if (typeof node !== "object") return node;
    if (typeof node.type === "function") {
      stack.push({ id: node.type, index: 0 });
      const out = draw(node.type(node.props));
      stack.pop();
      return out;
    }
    const ref = node.props ? node.props.ref : undefined;
    if (typeof ref === "function") ref(mountedStub());
    else if (ref && typeof ref === "object") ref.current = mountedStub();
    return {
      type: node.type,
      props: Object.assign({}, node.props, { children: draw(node.props ? node.props.children : undefined) })
    };
  }

  function run(type, props) {
    do {
      passes += 1;
      // 渲染里直接调 setter 会永远不收敛，早炸早发现。
      if (passes > 50) throw new Error("createMount: setState 循环超过 50 次");
      dirty = false;
      tree = draw({ type: type, props: props });
    } while (dirty);
    return tree;
  }

  return {
    shim: shim,
    mount: function (type, props) {
      hooks.clear();
      passes = 0;
      dirty = true;
      tree = null;
      run(type, props);
      return {
        get tree() { return tree; },
        rerender: function () { dirty = true; run(type, props); return tree; }
      };
    }
  };
}

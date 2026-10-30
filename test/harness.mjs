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

/**
 * 展开函数组件，得到纯宿主元素的树。
 * 垫片里的 hook 都是无状态的，所以直接调用组件函数即可。
 */
export function render(node) {
  if (node === null || node === undefined || typeof node === "boolean") return node;
  if (Array.isArray(node)) return node.map(render);
  if (typeof node !== "object") return node;
  if (typeof node.type === "function") return render(node.type(node.props));
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

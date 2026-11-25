/**
 * 组件工坊：样式提醒（设计方案 §6.3）。
 *
 * 背景：组件包的 `styles.css` 是**预编译**的 Tailwind 产物（CDS 3.0.8 实测：常用类齐全，但 `gap-7` / `mt-7` /
 * `col-span-2` / `max-w-lg` / `grid-cols-[1fr_2fr]` 这类确实没有）。agent 用了不存在的类名不会报错，
 * 只是**样式静默失效**——这是最难发现的一类问题，所以要在 `whales_design_write` 的返回里提示。
 *
 * 口径（P0 审计要求补齐的那几条）：
 *   · **不解析完整 CSS 语法**，只做「类名集合」的粗提取（够用、够快、不会因为 `@layer` / 任意值语法崩）；
 *   · 只检查 `className="..."` 字面量里的类（表达式算出来的不判——判不准就别乱报）；
 *   · **不阻塞**：只给 `styleWarnings`，不影响写入。
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const PROJECT_CSS_BYTES = 64 * 1024;

/** 只读会话工作区内的普通 CSS 文件。预处理过的 Tailwind / Sass 应传编译产物。 */
export function readWorkspaceStyles(workspacePath, files) {
	if (files.length === 0) return "";
	if (typeof workspacePath !== "string" || !isAbsolute(workspacePath)) throw new Error("本会话没有工作区，无法读取项目样式");
	const root = realpathSync(workspacePath);
	const styles = [];
	let size = 0;
	for (const file of new Set(files)) {
		if (typeof file !== "string" || file === "" || isAbsolute(file) || extname(file).toLowerCase() !== ".css") {
			throw new Error("styleFiles 只接受工作区内的相对 .css 路径");
		}
		const target = realpathSync(resolve(root, file));
		const fromRoot = relative(root, target);
		if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(".." + sep) || isAbsolute(fromRoot) || extname(target).toLowerCase() !== ".css") {
			throw new Error("样式文件必须位于会话工作区内");
		}
		const stat = statSync(target);
		if (!stat.isFile() || size + stat.size > PROJECT_CSS_BYTES) throw new Error("项目 CSS 总量上限为 64 KB");
		const css = readFileSync(target, "utf8");
		size += Buffer.byteLength(css, "utf8") + 1;
		if (size > PROJECT_CSS_BYTES) throw new Error("项目 CSS 总量上限为 64 KB");
		styles.push(css);
	}
	return styles.join("\n");
}

/** 从一份 CSS 文本里粗提取类名集合（`.foo` → `foo`；跳过 `\.` 转义与数字开头的转义类）。 */
export function classNamesInCss(css) {
	const out = new Set();
	const text = String(css || "");
	// 匹配 `.name`，name 里允许 Tailwind 的转义与括号（如 `.max-w-\[10px\]`、`.hover\:bg-accent`）
	const re = /\.((?:[A-Za-z0-9_-]|\\.|\[[^\]]*\]|\([^)]*\))+)/g;
	for (const match of text.matchAll(re)) {
		let name = match[1];
		// 去掉 CSS 转义反斜杠：`.hover\:bg-accent` → `hover:bg-accent`
		name = name.replace(/\\(.)/g, "$1");
		if (name === "" || /^\d/.test(name)) continue;
		// 过滤掉明显的伪类 / 保留字（不是类名）
		if (/^(root|before|after|first-child|last-child|hover|focus|active|disabled|dark|empty|checked|required)$/.test(name)) continue;
		out.add(name);
	}
	return out;
}

/** 从一份 TSX 源码里取出所有 `className="..."` 字面量的类名（表达式不取）。 */
export function classNamesInSource(source) {
	const out = new Set();
	const text = String(source || "");
	// className="a b c"（双引号 / 单引号；JSX 里也可能是 {'a b'} 的字符串字面量——覆盖这两种）
	// 只认：className="a b"、className='a b'、className={"a b"}、className={'a b'}
	// **不认**模板字符串（className={`a ${b}`}）——插值算不出来，硬判会误报
	for (const match of text.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)')\s*\})/g)) {
		const value = [match[1], match[2], match[3], match[4]].filter((item) => item !== undefined)[0];
		for (const token of String(value || "").split(/\s+/)) {
			if (token !== "") out.add(token);
		}
	}
	return out;
}

/**
 * 找出「源码里用了、但样式表里没有」的类名。
 * @param {string} source TSX 源码
 * @param {string} css 组件包的 styles.css（可为空）
 * @param {{ extraKnown?: Iterable<string> }} [options] 额外已知可用的类（如宿主侧补充 CSS 生成的）
 * @returns {{ missing: string[], checked: number }} missing 最多 20 个，按出现顺序
 */
export function styleWarnings(source, css, options) {
	const opts = options || {};
	const used = classNamesInSource(source);
	if (used.size === 0) return { missing: [], checked: 0 };
	const known = classNamesInCss(css);
	for (const extra of opts.extraKnown || []) known.add(String(extra));
	const missing = [];
	for (const name of used) {
		if (known.has(name)) continue;
		missing.push(name);
		if (missing.length >= 20) break;
	}
	return { missing: missing, checked: used.size };
}

/** 读一个组件包的 styles.css（读不到返回空串，不抛）。 */
export function readPackCss(packDir) {
	try { return readFileSync(packDir, "utf8"); } catch (error) { return ""; }
}

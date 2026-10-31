/**
 * 元测试：守住「可分发的插件」这层边界。
 *
 * 历史事故：
 *   - cordis.patch.yml 带 UTF-8 BOM → 解析器报「缺少冒号」，整行装不起来
 *   - package.json files 白名单漏了运行期文件 → npm 包里缺 client.js / patch
 *
 * 这里不引入 YAML 第三方依赖（仓库没有 dependencies，测试必须离线可跑），
 * 而是用一个小而严格的「cordis patch 子集解析器」：只接受补丁文件实际使用的
 * 缩进序列格式，遇到 BOM / Tab / 缺冒号 / 重复键立刻失败。格式一旦被写坏，
 * 真实 Loader 解析失败，这里也会失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { pluginDir, clientPath } from "./harness.mjs";

const manifestPath = join(pluginDir, "package.json");
const patchPath = join(pluginDir, "cordis.patch.yml");
const teamPatchPath = join(pluginDir, "cordis.patch.team.yml");
const localeDir = join(pluginDir, "locale");
const assetsDir = join(pluginDir, "assets");
const artJsonPath = join(assetsDir, "art.json");
const artManifestPath = join(assetsDir, "manifest.json");
const testDir = join(pluginDir, "test");
const testFiles = readdirSync(testDir).filter((name) => name.endsWith(".test.mjs"));

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// ── cordis.patch.yml 的子集解析器 ─────────────────────────────────────────

function splitKeyValue(content, lineNumber) {
  const colon = content.indexOf(":");
  if (colon <= 0) {
    throw new Error(`第 ${lineNumber} 行缺少「键: 值」的冒号：${content}`);
  }
  const key = content.slice(0, colon).trim();
  const value = stripInlineComment(content.slice(colon + 1).trim());
  if (key === "") throw new Error(`第 ${lineNumber} 行冒号前没有键名`);
  return { key, value };
}

/** YAML 行尾注释：引号外的「空白 + #」之后全部丢掉。 */
function stripInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }
  return value;
}

function parseScalar(raw) {
  const text = raw.trim();
  if (text === "") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (/^[[]{}&*!|>%@`]/.test(text)) {
    throw new Error("子集解析器不支持 YAML 结构标记：" + text);
  }
  return text;
}

function assignKey(target, key, raw, lineNumber) {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    throw new Error(`第 ${lineNumber} 行出现重复键：${key}`);
  }
  target[key] = parseScalar(raw);
}

/**
 * 解析 cordis patch 的缩进序列子集。返回：
 *   [{ id, disabled? }, { insert: [{ id, name, config? }] }, ...]
 */
function parsePatchYaml(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const patch = [];
  let top = null;
  let insert = null;
  let insertItemIndent = null;
  let item = null;
  let config = null;
  let configIndent = null;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === "" || line.trim().startsWith("#")) return;
    if (line.includes("\t")) throw new Error(`第 ${lineNumber} 行含 Tab；YAML 缩进不能用 Tab`);
    if (line.includes("\uFEFF")) throw new Error(`第 ${lineNumber} 行含 BOM 字符`);

    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    if (indent === 0) {
      if (!content.startsWith("- ")) {
        throw new Error(`第 ${lineNumber} 行顶层必须是「- 条目」：${content}`);
      }
      top = {};
      insert = null;
      insertItemIndent = null;
      item = null;
      config = null;
      configIndent = null;
      patch.push(top);
      const { key, value } = splitKeyValue(content.slice(2), lineNumber);
      if (key === "insert") {
        if (value !== "") throw new Error(`第 ${lineNumber} 行 insert 必须是无值块`);
        insert = [];
        top.insert = insert;
      } else {
        assignKey(top, key, value, lineNumber);
      }
      return;
    }

    if (top === null) throw new Error(`第 ${lineNumber} 行有缩进内容但没有父条目`);

    if (insert !== null) {
      if (content.startsWith("- ")) {
        if (insertItemIndent === null) insertItemIndent = indent;
        if (indent !== insertItemIndent) {
          throw new Error(`第 ${lineNumber} 行 insert 子项缩进不一致（${indent} vs ${insertItemIndent}）`);
        }
        item = {};
        config = null;
        configIndent = null;
        insert.push(item);
        const { key, value } = splitKeyValue(content.slice(2), lineNumber);
        assignKey(item, key, value, lineNumber);
        return;
      }
      if (item === null || indent <= insertItemIndent) {
        throw new Error(`第 ${lineNumber} 行必须是 insert 子项或子项字段：${content}`);
      }
      const { key, value } = splitKeyValue(content, lineNumber);
      if (key === "config" && value === "") {
        if (config !== null) throw new Error(`第 ${lineNumber} 行 config 重复`);
        config = {};
        configIndent = indent;
        item.config = config;
        return;
      }
      if (config !== null && indent > configIndent) {
        assignKey(config, key, value, lineNumber);
      } else {
        config = null;
        configIndent = null;
        assignKey(item, key, value, lineNumber);
      }
      return;
    }

    // 普通顶层条目的续行，例如 `disabled: true`。
    const { key, value } = splitKeyValue(content, lineNumber);
    assignKey(top, key, value, lineNumber);
  });

  return patch;
}

function flattenInsert(patch) {
  const entries = [];
  for (const top of patch) {
    if (top.insert === undefined) continue;
    for (const item of top.insert) entries.push(item);
  }
  return entries;
}

/** files 白名单是否覆盖某个仓库相对路径（支持 `*` 单段通配）。 */
function filesCover(files, relativePath) {
  const normalized = relativePath.replace(/^\.\//, "");
  return files.some((pattern) => {
    if (!pattern.includes("*")) return pattern === normalized;
    const regex = new RegExp(
      "^" + pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$"
    );
    return regex.test(normalized);
  });
}

function shapeOf(value) {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value && typeof value === "object") {
    const shape = {};
    for (const key of Object.keys(value).sort()) shape[key] = shapeOf(value[key]);
    return shape;
  }
  return typeof value;
}

// ── 1. package.json 清单 ──────────────────────────────────────────────────

test("package.json：files 覆盖运行期必需文件与 exports 目标", () => {
  for (const file of ["lib/index.js", "lib/client.js", "cordis.patch.yml", "icon.svg", "README.md", "NOTICE.md"]) {
    assert.ok(manifest.files.includes(file), "files 白名单缺少 " + file);
    assert.ok(existsSync(join(pluginDir, file)), "运行期文件不存在：" + file);
  }
  assert.ok(
    manifest.files.some((entry) => entry === "locale/*.json" || entry.startsWith("locale/")),
    "files 必须覆盖 locale"
  );

  assert.equal(manifest.type, "module");
  assert.equal(manifest.license, "MIT");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "version 必须是 semver");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.dsh.client.platform, "web");
  // 0.21.0 起不再锁 immediately=true：加载策略由分发方决定，但类型必须合法，
  // 且如果 README 明确写了取值，必须与 manifest 一致（防止文档/清单一处 true 一处 false）。
  assert.equal(typeof manifest.dsh.client.immediately, "boolean", "immediately 必须是 boolean");
  const readmeForImmediately = readFileSync(join(pluginDir, "README.md"), "utf8");
  const declaredImmediately = /immediately["'`]?\s*[:=]\s*(true|false)/.exec(readmeForImmediately);
  if (declaredImmediately !== null) {
    assert.equal(
      declaredImmediately[1] === "true",
      manifest.dsh.client.immediately,
      "README 声明的 immediately 必须与 package.json 一致"
    );
  }
  assert.ok(Array.isArray(manifest.dsh.client.inject) && manifest.dsh.client.inject.length > 0);
  for (const name of manifest.dsh.client.inject) {
    assert.equal(typeof name, "string");
    assert.ok(name.length > 0);
  }
  assert.equal(manifest.icon, "./icon.svg");

  for (const [subpath, target] of Object.entries(manifest.exports || {})) {
    if (typeof target !== "string") continue;
    if (target.includes("*")) {
      // "./locale/*.json" 这类通配导出：目录必须存在。
      assert.ok(existsSync(localeDir), "exports[" + subpath + "] 指向的 locale 目录不存在");
      continue;
    }
    assert.ok(existsSync(join(pluginDir, target)), "exports[" + subpath + "] 指向不存在的文件：" + target);
    if (target !== "./package.json") {
      assert.ok(filesCover(manifest.files, target), "files 白名单未覆盖 exports 目标：" + target);
    }
  }
});

test("package.json：素材清单与 webp 必须进包，art.json 不得进包", () => {
  // D1（PRD §34.1）：client.js 只含代码与矢量兜底，精灵图由宿主路由按需提供，
  // 所以 assets/manifest.json + assets/*.webp 是运行期必需文件；art.json 是构建产物。
  assert.ok(manifest.files.includes("assets/manifest.json"), "files 白名单缺少 assets/manifest.json");
  assert.ok(
    manifest.files.some((entry) => entry === "assets/*.webp" || /^assets\/[^/*]+\.webp$/.test(String(entry))),
    "files 白名单必须覆盖 assets/*.webp（否则装到别人机器上全是碎图）"
  );
  assert.equal(
    manifest.files.some((entry) => String(entry).includes("art.json")),
    false,
    "assets/art.json 是构建产物（~465KB），不得进安装包"
  );
  assert.ok(existsSync(artManifestPath), "assets/manifest.json 不存在：先跑 node tools/build-manifest.mjs");
  assert.ok(filesCover(manifest.files, "assets/q-smile.webp"), "files 必须覆盖单张 webp 路径");

  const fileManifest = JSON.parse(readFileSync(artManifestPath, "utf8"));
  assert.equal(fileManifest.version, 1, "清单协议版本必须是 1");
  const keys = Object.keys(fileManifest.keys || {});
  assert.ok(keys.length >= 26, "清单 key 数过少：" + keys.length);
  let declaredBytes = 0;
  for (const key of keys) {
    const entry = fileManifest.keys[key];
    assert.ok(["q", "mature", "classic"].includes(entry.skin), key + " 的 skin 非法");
    assert.ok(Number.isInteger(entry.w) && entry.w > 0, key + " 的 w 非法");
    assert.ok(Number.isInteger(entry.h) && entry.h > 0, key + " 的 h 非法");
    assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, key + " 的 bytes 非法");
    const webpPath = join(assetsDir, key + ".webp");
    assert.ok(existsSync(webpPath), "清单里的 " + key + " 缺少 assets/" + key + ".webp（装到别人机器上会 404）");
    assert.equal(readFileSync(webpPath).length, entry.bytes, key + " 的 webp 字节数必须与清单一致");
    declaredBytes += entry.bytes;
  }
  // 反过来：目录里多出来的顶层 webp 会进包但路由永远取不到，必须清掉或并进 art.json。
  const extras = readdirSync(assetsDir).filter(
    (name) => name.endsWith(".webp") && !keys.includes(name.slice(0, -".webp".length))
  );
  assert.deepEqual(extras, [], "assets/ 里有清单之外的 webp：" + extras.join(", "));
  assert.ok(declaredBytes > 0);
});

test("package.json：prepack 必须生成素材清单，并拦住 client.js 内联回归", () => {
  const prepack = manifest.scripts && manifest.scripts.prepack;
  assert.equal(typeof prepack, "string", "必须声明 prepack");
  assert.match(prepack, /build-manifest\.mjs/, "prepack 必须生成/校验 assets/manifest.json");
  assert.match(prepack, /client\.js/, "prepack 必须检查 client.js 没有回退到内联");
  assert.equal(
    prepack.includes("embed-art.mjs"),
    false,
    "prepack 不得再调用 embed-art.mjs（D1 起它只是 build-manifest 的兼容别名）"
  );
});

test("package.json：内嵌版本声明（如果有）必须与清单版本一致", () => {
  const sources = [
    ["lib/index.js", readFileSync(join(pluginDir, "lib", "index.js"), "utf8")],
    ["lib/client.js", readFileSync(join(pluginDir, "lib", "client.js"), "utf8")]
  ];
  for (const [file, source] of sources) {
    const declared = /\bVERSION\s*=\s*["']([^"']+)["']/.exec(source);
    if (declared !== null) {
      assert.equal(declared[1], manifest.version, file + " 内嵌版本必须与 package.json 一致");
    }
  }
});

test("package.json：npm test 必须跑到全部 *.test.mjs（不能只跑基线）", () => {
  const script = manifest.scripts && manifest.scripts.test;
  assert.equal(typeof script, "string", "必须声明 npm test");
  assert.match(script, /\bnode\s+--test\b/, "npm test 必须走 node 内置 test runner");

  const normalized = script.replace(/["']/g, "");
  if (/node\s+--test\s+(\.\/)?test\/?(\s|$)/.test(normalized)) return; // 目录入口（test/index.js）
  if (normalized.includes("test/index.js")) return; // 显式入口文件
  if (/node\s+--test\s+(\.\/)?test\/\*\.test\.mjs/.test(normalized)) return; // 显式 glob
  for (const file of testFiles) {
    assert.ok(script.includes(file), "npm test 漏了 " + file + "（对抗性用例会被静默跳过）");
  }
});

// ── 2. cordis.patch.yml：BOM、可解析性与 B 语义（团队段默认内置）──────────

test("cordis.patch.yml：没有 BOM、没有 NUL、没有 Tab 缩进", () => {
  const raw = readFileSync(patchPath);
  assert.notDeepEqual(Array.from(raw.subarray(0, 3)), [0xef, 0xbb, 0xbf], "文件头不得有 UTF-8 BOM（历史事故）");

  const text = raw.toString("utf8");
  assert.notEqual(text.charCodeAt(0), 0xfeff, "解码后的第一个字符不得是 BOM");
  assert.equal(text.includes("\uFEFF"), false, "BOM 不得出现在文件任何位置");
  assert.equal(text.includes("\u0000"), false, "不得混入 NUL 字节");
  assert.equal(text.includes("\t"), false, "YAML 缩进不得使用 Tab");
  assert.ok(text.trim().length > 0, "补丁文件不得为空");
});

test("cordis.patch.yml：能被严格子集解析器解析成结构化补丁", () => {
  const text = readFileSync(patchPath, "utf8");
  let patch;
  assert.doesNotThrow(() => { patch = parsePatchYaml(text); }, "补丁必须可解析");

  assert.ok(Array.isArray(patch) && patch.length > 0, "补丁至少有一个条目");
  const disabled = [];
  const inserts = [];

  for (const top of patch) {
    assert.ok(top && typeof top === "object" && !Array.isArray(top), "顶层条目必须是映射");
    if (top.insert !== undefined) {
      assert.ok(Array.isArray(top.insert) && top.insert.length > 0, "insert 必须是非空数组");
      for (const item of top.insert) {
        assert.equal(typeof item.id, "string", "insert 条目必须有字符串 id");
        assert.ok(item.id.length > 0, "insert 条目 id 不得为空");
        assert.equal(typeof item.name, "string", "insert 条目 " + item.id + " 必须有包名");
        assert.ok(item.name.length > 0, "insert 条目 " + item.id + " 包名不得为空");
        if (item.config !== undefined) {
          assert.ok(item.config && typeof item.config === "object" && !Array.isArray(item.config), item.id + ".config 必须是映射");
        }
        inserts.push(item);
      }
    } else {
      assert.equal(typeof top.id, "string", "顶层条目必须有字符串 id");
      assert.ok(top.id.length > 0);
      if (top.disabled !== undefined) {
        assert.equal(top.disabled, true, "disabled 只接受 true");
        disabled.push(top);
      }
    }
  }

  assert.ok(inserts.length > 0, "补丁必须至少插入一个条目");

  // 用户拍板（2026-10-30）：团队能力保留内置。默认补丁 = 插件本体 + 官方
  // agent-team-profile 等价的团队段。期望值来源：desktop runtime app.asar 内官方
  // @deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml，逐字段核对后写死。
  const expectedInserts = ["agent-whales", "agent-team", "tool-agent-team", "ui-agent-team"];
  const expectedDisabled = [
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent",
    "tool-subagent-fork"
  ];
  const expectedConfig = {
    "agent-team": { maxMembers: 8, maxTasks: 256, maxMessageBytes: 65536, disposalTimeoutMs: 5000 },
    "tool-agent-team": { freshProvider: "spawn", forkProvider: "fork" }
  };
  const expectedNames = {
    "agent-whales": manifest.name,
    "agent-team": "@deepseek-ai/dsh-experimental-agent-team",
    "tool-agent-team": "@deepseek-ai/dsh-experimental-tool-agent-team",
    "ui-agent-team": "@deepseek-ai/dsh-experimental-client-ui-agent-team"
  };

  assert.deepEqual(
    [...new Set(inserts.map((item) => item.id))].sort(),
    [...expectedInserts].sort(),
    "默认层 insert 集合必须恰好是插件本体 + 团队三件套"
  );
  assert.deepEqual(
    disabled.map((entry) => entry.id).sort(),
    [...expectedDisabled].sort(),
    "默认层 disabled 集合必须恰好是会被团队工具取代的 4 个官方 subagent 工具"
  );
  for (const item of inserts) {
    assert.equal(item.name, expectedNames[item.id], item.id + " 的包名与官方团队段不一致");
    if (expectedConfig[item.id] === undefined) {
      assert.equal(item.config, undefined, item.id + " 不应带 config");
    } else {
      assert.deepEqual(
        item.config,
        expectedConfig[item.id],
        item.id + ".config 必须与官方 agent-team-profile 逐字段一致"
      );
    }
  }

  const ids = [...disabled.map((entry) => entry.id), ...inserts.map((entry) => entry.id)];
  assert.equal(new Set(ids).size, ids.length, "同一补丁内 id 不得重复：" + ids.join(", "));
});

test("cordis.patch.yml：团队能力已内置，不再单列可选分片", () => {
  assert.equal(existsSync(teamPatchPath), false, "cordis.patch.team.yml 应已删除（团队段内置进默认补丁）");
  assert.equal(
    manifest.files.some((entry) => String(entry).includes("cordis.patch.team")),
    false,
    "files 不得再列 cordis.patch.team.yml"
  );
  for (const [subpath, target] of Object.entries(manifest.exports || {})) {
    if (typeof target === "string") {
      assert.equal(target.includes("cordis.patch.team"), false, "exports[" + subpath + "] 不得再导出分片");
    }
  }
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml", "默认 bundle patch 仍必须是主补丁");
});

test("README：团队段内置的同时必须写明与官方 agent-team-profile 互斥、以及关闭步骤", () => {
  const readme = readFileSync(join(pluginDir, "README.md"), "utf8");
  assert.match(readme, /agent-team-profile/, "README 必须点名官方 agent-team-profile（互斥/重复 id 风险）");
  assert.match(readme, /disabled:\s*true/, "README 必须给出关闭步骤（提到 disabled: true）");
  assert.match(
    readme,
    /(互斥|冲突|重复\s*id|duplicate|不要同时|不能同时)/i,
    "README 必须说明与官方 profile 同时安装的后果"
  );
  assert.match(
    readme,
    /(关掉|关闭|删掉|删去|回滚|移除|禁用)/,
    "README 必须给出关闭/回滚团队段的操作说明"
  );
});

test("cordis.patch.yml：清单指向的文件就是被检查的补丁", () => {
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.ok(existsSync(patchPath));
  assert.ok(manifest.files.includes("cordis.patch.yml"), "patch 必须随包发布");
});

// ── 3. locale / assets ───────────────────────────────────────────────────

test("locale：中英文 JSON 可解析、形状一致、没有编码替换字符", () => {
  const zhRaw = readFileSync(join(localeDir, "zh.json"), "utf8");
  const enRaw = readFileSync(join(localeDir, "en.json"), "utf8");
  for (const [name, raw] of [["zh.json", zhRaw], ["en.json", enRaw]]) {
    assert.equal(raw.includes("\uFFFD"), false, name + " 含替换字符，说明编码坏了");
    assert.equal(raw.includes("\uFEFF"), false, name + " 含 BOM");
  }
  const zh = JSON.parse(zhRaw);
  const en = JSON.parse(enRaw);
  assert.deepEqual(shapeOf(zh), shapeOf(en), "中英文案必须有相同的键结构");
  for (const [name, dict] of [["zh.json", zh], ["en.json", en]]) {
    assert.equal(typeof dict.meta?.title, "string", name + " 缺少 meta.title");
    assert.ok(dict.meta.title.length > 0, name + " 的 meta.title 不得为空");
    assert.equal(typeof dict.meta?.description, "string", name + " 缺少 meta.description");
  }
});

test("assets/art.json：sprites 每项都带内联 WebP 与正尺寸", () => {
  const source = JSON.parse(readFileSync(artJsonPath, "utf8"));
  assert.ok(source.sprites && typeof source.sprites === "object", "art.json 必须有 sprites 表");
  assert.ok(Object.keys(source.sprites).length > 0, "sprites 不得为空");
  for (const [key, sprite] of Object.entries(source.sprites)) {
    assert.match(sprite.uri, /^data:image\/webp;base64,/, key + " 必须是内联 WebP");
    assert.ok(Number.isFinite(sprite.w) && sprite.w > 0, key + " 宽度必须为正");
    assert.ok(Number.isFinite(sprite.h) && sprite.h > 0, key + " 高度必须为正");
    assert.ok(Number.isFinite(sprite.bytes) && sprite.bytes > 0, key + " 字节数必须为正");
  }
});

// ── 3b. client.js：D1 之后不得再内联素材 ────────────────────────────────

test("lib/client.js：D1 起不得再内联 base64 素材，且体积必须 ≤200KB", () => {
  // 产品决策（PRD §34.1 D1，2026-10-30 用户拍板）：client.js 只含代码与矢量兜底，
  // 精灵图由宿主路由 /agent-whales/api/art/* 按当前皮肤按需提供。
  // 这条用例是回归守门：谁再把 base64 内联回来，或者体积重新膨胀，这里立刻红。
  // 注意只查 base64 与体积：client.js 允许保留空的 ART 占位（T-client 用它做
  // 「旧内联构建已就绪」的兼容判断），那不是内联素材。
  const source = readFileSync(clientPath, "utf8");
  assert.equal(
    source.includes("data:image/webp;base64,"),
    false,
    "client.js 不得内联 WebP data URI：素材必须走宿主路由 /agent-whales/api/art/*"
  );
  assert.equal(/data:image\/(?:webp|png|jpeg);base64,/i.test(source), false, "client.js 不得内联任何位图 data URI");
  const bytes = Buffer.byteLength(source, "utf8");
  assert.ok(bytes <= 200 * 1024, "client.js 必须 ≤200KB（只含代码与矢量兜底），实际 " + (bytes / 1024).toFixed(1) + "KB");
});

// ── 4. 测试入口卫生 ─────────────────────────────────────────────────────

test("测试入口：#only / x-test 之类的静默跳过不得进入仓库", () => {
  assert.ok(testFiles.length > 0, "test/ 下必须有用例文件");
  for (const file of testFiles) {
    const source = readFileSync(join(testDir, file), "utf8");
    assert.equal(/\b(?:test|describe|it)\.only\s*\(/.test(source), false, file + " 含 .only");
    assert.equal(/\bx(?:test|describe|it)\s*\(/.test(source), false, file + " 含 x-test");
  }
});

test("测试入口：test/index.js 必须导入全部 *.test.mjs（Node 24 下 node --test test/ 的入口）", () => {
  const entryPath = join(testDir, "index.js");
  assert.ok(existsSync(entryPath), "缺少 test/index.js：Node 24 不接受裸目录参数，需要入口文件汇总用例");
  const entry = readFileSync(entryPath, "utf8");
  for (const file of testFiles) {
    assert.ok(entry.includes("./" + file), "test/index.js 漏了 " + file);
  }
});

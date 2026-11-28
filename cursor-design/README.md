# Whales Design · Cursor 0.2.0

把 DSH 插件里的 TSX 编译器和隔离预览接到 Cursor Agent。Agent 创建或修改画板后，编辑器扩展监听文件变化并尝试自动打开侧栏画布。多张画板可拖动、缩放、连接和交互预览，也可选中元素保存批注。画板和布局保存在当前工作区的 `.whales-design/`。

## 安装发布包

在 [v0.26.0 发布页](https://github.com/mutouwood-hue/dsh-agent-whales/releases/tag/v0.26.0) 下载：

- `whales-design-canvas-0.2.0.vsix`：Cursor 扩展面板选择“从 VSIX 安装”，然后重新加载窗口。
- `whales-cursor-design-0.2.0.zip`：解压到固定目录，提供已打包的 MCP 服务和预览，保留 Node.js 22+，无需安装 npm 依赖。按包内 README 配置 `.cursor/mcp.json`，将 `args` 指向解压目录的 `server.mjs`，`WHALES_WORKSPACE` 指向目标项目。

已有 MCP 配置请合并，更新时保持 `WHALES_WORKSPACE` 不变，画板、批注与布局继续保存在该项目 `.whales-design/`。

0.2.0 两个预览入口均支持「重新渲染」和「全屏」；超时或出错时可直接重试。对话全屏优先请求宿主的全屏显示模式；宿主不支持时，弹窗受当前 MCP 预览区域限制。画布全屏在当前 Webview 内打开，支持关闭按钮和 Escape。支持浏览器的 `moveBefore` 时保留画板内部交互状态；较旧 Webview 在移动 iframe 时会重新渲染。

画布选中画板后，拖动边框控制点可调整外框大小；页面内容保持桌面/手机视口宽度，按外框宽度缩放，较长页面可滚动。尺寸和位置、连线一起保存到 `.whales-design/canvas.json`。

## 准备

需要 Node.js 22 或以上、支持 MCP Apps 的 Cursor，以及本仓库完整源码。先在本仓库根目录安装编译依赖，再构建适配层：

```bash
npm ci
npm ci --prefix cursor-design
npm ci --prefix tools/flow-chunk
npm run build --prefix cursor-design
npm run pack:canvas --prefix cursor-design
npm run pack:standalone --prefix cursor-design
```

在 Cursor 的扩展面板右上角选择“从 VSIX 安装”，选择 `cursor-design/dist/whales-design-canvas-0.2.0.vsix`，安装后重新加载窗口。扩展可从活动栏打开；也可以运行命令“Whales Design: Open Canvas”。

在**要使用画板的项目**中配置 `.cursor/mcp.json`（已有文件时合并 `mcpServers`，不要覆盖已有服务器）：

```json
{
  "mcpServers": {
    "whales-design": {
      "command": "node",
      "args": ["/绝对路径/dsh-agent-whales/cursor-design/server.mjs"],
      "env": { "WHALES_WORKSPACE": "/绝对路径/你的项目" }
    }
  }
}
```

把两个路径替换为本机实际路径。Windows 路径在 JSON 中要写成正斜杠（如 `C:/work/project`）或双反斜杠。`WHALES_WORKSPACE` 必须是绝对路径；每个项目应指向自己的目录。重新加载 Cursor，并在 MCP 设置中确认服务器已连接。若 Cursor 找不到 `node`，将 `command` 改为 Node 可执行文件的绝对路径。

可将 `skill/` 目录复制到项目的 `.cursor/skills/whales-cursor-design/`，让 Agent 在设计请求中更稳定地使用画板。然后在 Cursor 对话中说：

> 用 Whales Design 做一个可交互的发票关联页面，生成画板供我查看。

若没有自动调用，可明确要求使用 `whales_design_write`。选择画板上的「标注修改」，点击设计元素并输入意见，然后点击「保存并复制修改请求」，把复制的请求粘贴到 Cursor 对话。画板标题可以拖动，连接点可以连线；这些布局保存在本地。

## 当前范围

这是设计图适配层：支持拖动、外框缩放、连线、全屏、手动重渲染、交互预览和元素批注；使用 TSX 与 React 生成交互式页面。连线表达画布关系；原型组件可调用 `navigate("目标画板id")`，将视野切换到已有画板。尚不支持 DSH 组件库、`@project` 组件、直接改元素、设计确认或 DSH 团队功能。沙箱不能访问网络，因此外部图片和在线字体不能直接加载。

自动打开依赖 Cursor 对 VS Code 扩展、文件监听及 Webview 的支持；尚需在目标 Cursor 环境实测。若未自动打开，可点击活动栏 Whales Design 图标或运行上述命令，再点「刷新」。如果画布位于较窄的侧栏，可以把视图拖到次要侧栏或放大侧栏。

## 验证

`npm test --prefix cursor-design` 覆盖 MCP 服务连接、写入、读取、编译失败保护、批注及 UI 资源。浏览器模拟宿主检查可运行 `CHROME_PATH="/Chrome/可执行文件的绝对路径" npm run test:ui --prefix cursor-design`。该检查使用 Chromium 和模拟 MCP App 宿主。多画板可用 `CHROME_PATH="/Chrome/可执行文件的绝对路径" npm run test:canvas --prefix cursor-design` 验证。自动打开行为经过模拟扩展宿主测试；Cursor 真机验证需要实际安装 Cursor。

# Whales Design · Cursor 原型

把 DSH 插件里的 TSX 编译器和隔离预览接到 Cursor Agent。Agent 可创建和修改画板；MCP App 在对话中显示交互预览，支持选元素、保存批注并请求 Agent 修改。画板按工作区保存在 `.whales-design/`，请像其他工作文件一样管理它们。

## 准备

需要 Node.js 20 或以上、支持 MCP Apps 的 Cursor，以及本仓库完整源码。先在本仓库根目录安装编译依赖，再构建适配层：

```bash
npm ci
npm ci --prefix cursor-design
npm run build --prefix cursor-design
```

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

若没有自动调用，可明确要求使用 `whales_design_write`。选择「标注」后点击设计元素，输入意见并点击发送；若 Cursor 不支持应用发送消息，意见仍会保存，在对话中说「按画板批注修改」即可。

## 当前范围

这是原型：支持单个画板预览和切换，尚不是 DSH 的多节点自由画布；只支持导入 React，不支持 DSH 的组件库、`@project` 组件、多画板跳转、直接改元素、设计确认或 DSH 团队功能。沙箱不能访问网络，因而外部图片和在线字体不能直接加载。预览高度按内容变化并在对话区域内滚动。画板更新后点击「刷新」取得最新版本。

不同 Cursor 版本对 MCP Apps 的显示和消息发送行为可能不同。若只看见工具文本，检查 Cursor 版本和 MCP Apps 支持；源码仍保存在工作区，不能据此声称界面已验证。

## 验证

`npm test --prefix cursor-design` 覆盖 MCP 服务连接、写入、读取、编译失败保护、批注及 UI 资源。浏览器模拟宿主检查可运行 `CHROME_PATH="/Chrome/可执行文件的绝对路径" npm run test:ui --prefix cursor-design`。该检查使用 Chromium 和模拟 MCP App 宿主；Cursor 真机验证需要实际安装 Cursor。

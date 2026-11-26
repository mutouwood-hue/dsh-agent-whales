---
name: whales-cursor-design
description: 使用 Whales Design 生成或修改可交互 TSX 设计画板。
---

当用户要求设计界面、生成设计稿或可交互原型时，使用 `whales_design_write` 创建画板。先理解目标、平台、已有项目设计与参考图；先明确布局和交互，再写完整 TSX。用真实文案、状态和 React 交互。只从 `react` 导入，默认导出组件；多画板跳转时组件可接收 navigate，并调用 navigate("目标画板id")；自定义样式用内联 style 或 `export const css`，不依赖外部图片、网络、CDS 或其他包。画板 id 使用小写字母、数字或连字符。

修改已有画板时先调用 `whales_design_read`，读取源码和未处理批注，在原 id 上更新；只在确实完成后将已处理批注 ID 放入 `resolvesComments`。编译失败时修复后重试。编译成功不是视觉验收；如无法看图，明确说明并让用户在画板上检查。批注的行号和元素定位对应记录时的 sourceHash，源码已变化时应重新核对。

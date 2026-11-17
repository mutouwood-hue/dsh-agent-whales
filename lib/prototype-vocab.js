/**
 * 通用原型词表（PRD v2.2 九（续）：原型 JSON 只写抽象组件，每个组件包提供「词表 → 自家组件」的适配）。
 * 宿主（校验 agent 写的原型、经 /component-packs 下发）与组件包构建脚本共用这一份。
 * 字段口径 = Puck 字段：text / textarea / number / select / radio / slot。slot 的值是子节点数组。
 */
export const PROTOTYPE_VOCAB = {
	Heading: { label: "标题", fields: { text: { type: "text" }, level: { type: "select", options: ["1", "2", "3"] } }, defaults: { text: "页面标题", level: "2" } },
	Text: { label: "段落", fields: { text: { type: "textarea" }, tone: { type: "select", options: ["default", "muted"] } }, defaults: { text: "一段说明文字", tone: "default" } },
	Button: { label: "按钮", fields: { label: { type: "text" }, variant: { type: "select", options: ["primary", "secondary", "outline", "ghost", "destructive"] } }, defaults: { label: "确定", variant: "primary" } },
	Input: { label: "输入框", fields: { label: { type: "text" }, placeholder: { type: "text" } }, defaults: { label: "名称", placeholder: "请输入" } },
	Textarea: { label: "多行输入", fields: { label: { type: "text" }, placeholder: { type: "text" } }, defaults: { label: "备注", placeholder: "请输入" } },
	Select: { label: "下拉选择", fields: { label: { type: "text" }, options: { type: "text" } }, defaults: { label: "类型", options: "选项一,选项二" } },
	Checkbox: { label: "复选框", fields: { label: { type: "text" }, checked: { type: "radio", options: ["true", "false"] } }, defaults: { label: "我已阅读", checked: "false" } },
	Switch: { label: "开关", fields: { label: { type: "text" }, checked: { type: "radio", options: ["true", "false"] } }, defaults: { label: "启用", checked: "true" } },
	Badge: { label: "标签", fields: { text: { type: "text" }, variant: { type: "select", options: ["default", "secondary", "outline", "destructive"] } }, defaults: { text: "进行中", variant: "default" } },
	Alert: { label: "提示条", fields: { title: { type: "text" }, description: { type: "text" }, variant: { type: "select", options: ["info", "success", "warning", "error"] } }, defaults: { title: "提示", description: "这里是提示内容", variant: "info" } },
	Upload: { label: "上传区", fields: { label: { type: "text" }, hint: { type: "text" } }, defaults: { label: "上传文件", hint: "支持 .xlsx / .json，拖到这里或点击选择" } },
	Table: { label: "表格", fields: { columns: { type: "text" }, rows: { type: "number" } }, defaults: { columns: "名称,状态,更新时间", rows: 3 } },
	Tabs: { label: "页签", fields: { tabs: { type: "text" }, active: { type: "number" } }, defaults: { tabs: "全部,进行中,已完成", active: 0 } },
	Stat: { label: "指标卡", fields: { label: { type: "text" }, value: { type: "text" } }, defaults: { label: "今日新增", value: "128" } },
	Navbar: { label: "顶栏", fields: { brand: { type: "text" }, links: { type: "text" } }, defaults: { brand: "产品名", links: "首页,列表,设置" } },
	Sidebar: { label: "侧边导航", fields: { items: { type: "text" }, active: { type: "number" } }, defaults: { items: "概览,表单,流程,设置", active: 0 } },
	Divider: { label: "分隔线", fields: {}, defaults: {} },
	Image: { label: "图片占位", fields: { alt: { type: "text" }, height: { type: "number" } }, defaults: { alt: "图片", height: 120 } },
	Card: { label: "卡片", fields: { title: { type: "text" }, description: { type: "text" }, content: { type: "slot" } }, defaults: { title: "卡片标题", description: "", content: [] } },
	Section: { label: "区块", fields: { title: { type: "text" }, content: { type: "slot" } }, defaults: { title: "", content: [] } },
	Columns: { label: "两栏", fields: { left: { type: "slot" }, right: { type: "slot" } }, defaults: { left: [], right: [] } },
	Dialog: { label: "弹窗", fields: { title: { type: "text" }, description: { type: "text" }, content: { type: "slot" }, confirmLabel: { type: "text" }, cancelLabel: { type: "text" } }, defaults: { title: "弹窗标题", description: "", content: [], confirmLabel: "确定", cancelLabel: "取消" } }
};

export const PROTOTYPE_VOCAB_NAMES = Object.keys(PROTOTYPE_VOCAB);

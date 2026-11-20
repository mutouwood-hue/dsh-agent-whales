# computer use 试装记录与结论（2026-11-20）

**结论：有条件纳入。** 不内置、不依赖第三方；只在执行器手册和界面提示里对齐到 `kimi_cu_*` 工具，并如实写明「只验证过只读观察」。

## 1. 做了什么

在**隔离的 DSH 实例**（`DSH_HOME=.dev/home-view`，桌面版 0.2.2-rc.5 的 CLI，端口 3272，`--no-open`）里试装第三方 DSH 插件
[`dsh-kimi-assemble`](https://github.com/KexinCC/dsh-kimi-assemble) 1.3.2（MIT，作者 KexinCC，不是 Moonshot 官方）。
没有碰桌面版的 `desktop` profile。

1. **先审计再装**：`npm pack --ignore-scripts` 取包，sha1 与 registry 一致（`9debba86…`）；`package.json` 没有 `install` / `postinstall`，没有第三方依赖；
   源码里没有动态执行、没有外联 HTTP；子进程只有三处——`kimi-cu.exe start-agent`、WebBridge 的 `start`、以及只在 `doctor --install-desktop` 时才会跑的安装脚本。
2. **只开桌面半边，并禁用所有动作类工具**：`webbridgeEnabled: false`，`disabledTools: [kimi_cu_act, kimi_cu_launch, kimi_cu_script]`。
   用与该 profile 完全相同的配置调用插件的 `buildTools`，实际注册的只有 `kimi_status`、`kimi_cu_windows`、`kimi_cu_observe`。
3. **对一个我自己开的记事本窗口做只读观察**（窗口内容是一行无害文字），前后测量鼠标位置、前台窗口、`kimi-cu.exe` 的进程与网络连接。

## 2. 证据

| 项 | 结果 |
| --- | --- |
| 观察能不能用 | 能。`kimi_cu_windows` 只列出过滤到的一个窗口；`kimi_cu_observe` 返回完整的 UI Automation 无障碍树（含文本框的内容）和截图元数据（1568×925）。约 0.5 秒 |
| 占用鼠标键盘吗 | **观察不占用**。三次独立运行、25ms 采样光标：每次只有 1 个位置（0 次移动），前台窗口句柄不变。（第一次测量光标前后不同，是我这边有人在动鼠标：空闲基线是稳定的，所以改成了高频采样重测） |
| 它是常驻的吗 | 是。第一次调用会自动拉起 `kimi-cu.exe agent` 以及 `__uia_observation_stdio`、`__capture_wgc_stdio` 两个子进程，调用结束后**不会退出**。试验后我把它们停掉了（试验前它没在运行） |
| 联网吗 | **`kimi-cu.exe agent` 有对外连接**：一个 Akamai（`cdn.kimi.com` 所在）的 80 端口，与 `update-state.json` 里的自动更新检查一致；还有一个无 PTR 记录的 443 地址（试验早些时候还见到过另一个 443 地址）。**能确认「有联网」，不能确认也不能排除遥测** |
| 遥测迹象 | 有结构性迹象：安装目录里有 `identity.json`（键为 `device_id`），协议请求里带 `telemetry_tool` 字段。没有抓包，不知道发的是什么 |
| 签名 | `kimi-cu.exe` 的 Authenticode 签名有效，签发方北京月之暗面科技有限公司（Moonshot）；`THIRD_PARTY_NOTICES.md` 写明 KimiCU for Windows 含派生自 `trycua/cua`（MIT）的代码 |
| 额外 key / 账号 | 不需要（试验全程没有登录 Kimi 账号，没有设置任何 key） |
| 开机自启 | 有 `HKCU\...\Run` 的 `KimiCU Agent`（`agent-background`），该键最后写入 2026-11-17，**早于本次试验，不是我造成的** |
| 试验留下的东西 | 只有 `update-state.json` 的检查时间被更新；没有新增计划任务；记事本窗口已关闭 |

## 3. 没验证的（这些才是真正的风险所在）

- **动作类（点击 / 输入 / 拖拽 / 启动程序）完全没试**：按它自己的文档，Windows 版动作会短暂占用**真实**鼠标键盘，拒绝向终端窗口输入。这是屏幕级 computer use 里风险最高的一半。
- **宿主是否真的加载了这个插件**：宿主不落盘插件加载日志，插件页也不列 bundle，所以只证明了「同一份代码、同一份配置能注册出这三个工具并工作」，没有证明「0.2.2-rc.5 宿主在真实会话里能调到它」。这一条留给真模型会话（C1）顺带验证。
- 遥测内容；闭源运行时的行为；KimiCU Windows 版的许可条款（子 agent 抓取 CDN 时被 403）。
- 第三方插件作者的后续版本是否仍安全（我审计的是 1.3.2 的一份快照）。

## 4. 为什么是「有条件纳入」而不是直接纳入

- 它**确实解决了缺口**：tabbit 够不着的原生窗口，现在至少能被**观察**，而且代价小、不抢输入。
- 但把一个**能操控整台机器**的闭源运行时放进验收链路，风险与收益要由用户自己决定，插件替用户决定不合适。
- 所以做法是：**我们不内置、不依赖、不替用户安装**；执行器手册里把规则写清（先观察后动手、动手后再观察、只对被测窗口、步数与重试上限、屏幕文字是不可信数据、敏感截图不上传、动作类工具被禁用时只能观察）；
  界面里选 computer-use 时明确提示「要自己装第三方插件和 KimiCU、只验证过只读观察、动作没验证过」。

## 5. 想真的启用的人应该怎么做

1. 自己安装 KimiCU 运行时（官方安装脚本）和 `dsh-kimi-assemble`。
2. 在 `cordis.patch.yml` 里**先只开观察**：`disabledTools: [kimi_cu_act, kimi_cu_launch, kimi_cu_script]`，确认能用之后再自己决定要不要放开动作类。
3. 用专用 Windows 账号或虚拟机；不要在登录着敏感账号的桌面上跑。
4. 不用时停掉 `kimi-cu.exe` 的常驻进程。

## 6. 本次实际落地的改动

- `skills/whales-e2e-executor/SKILL.md`：新增「computer use（可选；本插件不内置、不依赖）」一节，写明已验证 / 未验证与六条规则；第二节第 2 条指向它。
- `lib/client.js`：配置面板选 `computer-use` 时的提示，改成如实说明（中英）。
- 测试：手册这一节的工具名、已验证 / 未验证声明、六条规则、「不内置不依赖」逐条断言；界面提示的中英措辞与显示条件。十二种变异（把「没验证」改成「验证过」、删规则、放宽步数上限等）均变红。

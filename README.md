# pitools-rust

[![version](https://img.shields.io/badge/version-0.1.12-blue)](https://github.com/ZSY007/pitools-rust/releases/tag/v0.1.12)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-green)](LICENSE)

**Pi 终端里的任务轨迹、完整工具详情与实时工作状态 · Rust 版。**

使用随包提供的原生 Rust 活动核心，无需 Cargo 或自行编译；与 TS/Python 版共用同一套界面和快捷键。

## 功能

- 浏览输入、可见思考、模型回复和工具调用，支持跟随最新事件与历史回放。
- 查看概述、原始参数、完整结果、可用的 Schema 和计时；支持搜索、代码高亮、Markdown 与原始 JSON 切换。
- 显示月相动画、阶段短语、可见回复旁白、并行工具和完成统计。
- 宽屏左右分栏、窄屏上下排列，使用 Pi 原生主题，不替换编辑器、页脚或工作行。

三版界面与快捷键一致，**只选一个安装**。版本选择见 [主项目](https://github.com/ZSY007/pitools#选择一个版本)。

## 安装

已安装兼容的 Pi、Node.js ≥ 22.19。当前 Rust binary 另要求宿主 Node 的 Unicode 版本为 16.0，已验证 Node 24.12.0；无需 Python/Rust 工具链。Git 安装方式需要 Git。

### 随包 binary

| 平台 | 架构 | target |
|---|---|---|
| Windows | x64 | `x86_64-pc-windows-msvc` |
| macOS | Apple Silicon / arm64 | `aarch64-apple-darwin` |
| macOS | Intel / x64 | `x86_64-apple-darwin` |
| Linux GNU | x64 | `x86_64-unknown-linux-gnu` |

Linux x64 GNU 要求 **glibc ≥ 2.34**。不包含 musl 或其他未列出的架构。插件按实际 Node 进程架构选择 executable；不支持的平台、Unicode/版本不匹配或启动失败会明确提示并回退 TS，不在运行时下载或编译。


```sh
pi install git:github.com/ZSY007/pitools-rust
```

安装完成后，停止正在进行的生成，再在 Pi 中执行：

```text
/reload
/pitools version
/pitools core status
```

本包默认活动核心为 **Rust**。文件更新不会自动重载当前会话。

### 从旧包迁移 / 换版本

先用 `pi list` 确认来源，移除旧 `git:github.com/ZSY007/pitools` 或另一独立版本，再安装本包。例如从旧共享包迁移：

```sh
pi remove git:github.com/ZSY007/pitools
pi install git:github.com/ZSY007/pitools-rust
```

手工目录 `~/.pi/agent/extensions/pitools` 应先备份并**移出自动发现目录**，不能只在 `extensions` 下改名。不要让旧包与新包同时加载。完整步骤见 [迁移指南](https://github.com/ZSY007/pitools/blob/main/docs/editions.md#从旧-pitools-或另一版迁移)。

### 本地归档安装

在 [Release](https://github.com/ZSY007/pitools-rust/releases/tag/v0.1.12) 下载 `pitools-rust-0.1.12.tgz`，按 `SHA256SUMS` 校验后解压到稳定目录，再 `pi install /absolute/path/pitools-rust`。Windows 使用对应绝对路径；本地目录安装不会自动跟随 Git 更新。请选择具名 `.tgz` 成品包，GitHub 自动生成的源码 ZIP 不包含匹配平台 binary。

## 使用

| 操作 | 快捷键 / 命令 |
|---|---|
| 显示 / 隐藏轨迹 | `Alt+T` |
| 打开列表与详情 | `Alt+I` 或 `/pitools` |
| 选择上一 / 下一事件 | `Alt+,` / `Alt+.` |
| 跟随最新事件 | `/pitools live` |
| 开启 / 关闭轨迹 | `/pitools on` / `/pitools off` |
| 查看帮助 | `/pitools help` |

详情中：`←` / `→` 选事件，`Tab` 换页签，`↑` / `↓` / `PgUp` / `PgDn` 滚动，`/` 搜索，`R` 切换渲染 / 原始 JSON，`Esc` 返回。macOS Option 键可设为 Meta / Esc+，或直接使用命令。

事件颜色：输入蓝、模型紫、工具橙、失败红。隐藏轨迹仍继续记录。

### 工作状态

```text
● 🌗 ⏵ 检查工具结果 · 总21s  │  pitools · 第 3 轮 · 12 个事件
```

活动位于最左侧，文字统一使用主题强调色。只有 `●` 变色：灰色待机/运行、绿色结束、红色最近工具失败或请求错误；红色不一定表示整项任务失败。待机与完成后保持静态。

默认 `moon8` 八帧/120ms，支持 35 套帧和 `random`。旁白只来自可见回复行首的 `⏵`，不读取隐藏思考或签名，不修改原始回复。

```text
/pitools activity help
/pitools activity frames list
/pitools activity frames random
/pitools activity lang zh
/pitools activity lang en
/pitools activity lang auto
/pitools activity narrate off
/pitools activity contract off
/pitools activity phrases off
```

`narrate` 控制旁白显示，`contract` 控制旁白提示词约定，`phrases` 控制阶段短语，均支持 `on` / `off`。`activity on` / `off` 控制整项活动显示。默认中文，活动偏好保存到当前会话分支。

### 活动核心

本包在交互会话开始时自动使用 **Rust** 活动核心，无需设置 `PITOOLS_CORE`。

`/pitools core ts` 可临时关闭 worker 并回退 TS；`/pitools core rust` 可手动启用或重试。重新加载后恢复本包默认核心。不能启动另一个独立版本的 worker，换后端需要换包。

默认使用包内匹配平台的 executable。开发者可用 `PITOOLS_RUST_CORE` 显式指定可信 binary；普通用户无需设置。

启动失败、崩溃、协议/版本不符、超时或超预算时，完整 TS 状态继续工作并提示回退，不自动重启。worker 只计算首行活动状态；轨迹、详情、搜索、主题和渲染仍由 TS/Pi 实现，不代表整体 CPU/内存更低。

## 更新与卸载

```sh
pi update git:github.com/ZSY007/pitools-rust
pi remove git:github.com/ZSY007/pitools-rust
```

更新后手动 `/reload`、`/pitools version`。**不要裸跑 `pi update`：它更新 Pi 自身。** 固定版本可使用 `git:github.com/ZSY007/pitools-rust@v0.1.12`，tag/commit 不随默认分支更新。

## 数据与安全

- 只展示 Pi 提供的思考、Schema、usage 和已记录计时，不补造缺失数据。本地模型计时不是 provider TTFT。
- 从当前会话分支恢复数据，通过 Pi 元数据 API 保存计时与偏好，不读写其他会话文件。
- 内存约保留最近 2,000 个事件，运行中调用不淘汰。原始详情不因 worker/缓存而裁剪；宿主已截断的输出无法恢复，图片仅展示元信息。
- 上屏前清洗终端控制字符与双向文字控制符。长内容高亮失败时保留全文并使用纯文本。
- 运行时不联网、不读凭证、不监听网络，不自动下载/编译/安装运行环境。外部 worker 使用同用户权限，不是安全沙箱。
- 参数/结果可能包含敏感内容，分享截图或 issue 前请检查，没有自动脱敏。

## 文档与许可

共享源码、构建与测试维护于 [ZSY007/pitools](https://github.com/ZSY007/pitools)。更多内容：

- [完整使用说明](https://github.com/ZSY007/pitools#日常使用)
- [三包分发与迁移](https://github.com/ZSY007/pitools/blob/main/docs/editions.md)
- [Python 活动核心](https://github.com/ZSY007/pitools/blob/main/docs/0.1.11-python-activity-core.md)
- [Rust 活动核心](https://github.com/ZSY007/pitools/blob/main/docs/0.1.12-rust-activity-core.md)
- [优化测量与性能边界](https://github.com/ZSY007/pitools/blob/main/docs/0.1.12-rust-optimization-measurement.md)

BSD-3-Clause，见 [LICENSE](LICENSE)。活动数据与派生算法来自 **dsh-working-activity 0.5.1**，Copyright (c) 2026, chimney (ccch1mneyyy)；完整许可见 [data/activity/LICENSE](data/activity/LICENSE)，归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。随包的依赖许可证与 Rust 标准库 copyright 位于 `bin/<target>/licenses/`。不代表上游作者背书。

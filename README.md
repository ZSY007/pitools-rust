# pitools-rust 0.1.12

Pi 终端原生轨迹、完整工具详情、可见思考、搜索与工作状态。三个版本共用完全相同的界面和快捷键，只选一个安装，不是三份备份。

## 安装

```sh
pi install git:github.com/ZSY007/pitools-rust
```

附带匹配平台的 Rust worker：x86_64-pc-windows-msvc, aarch64-apple-darwin, x86_64-apple-darwin, x86_64-unknown-linux-gnu。无需 Python/Cargo；会话开始时启动包内 worker，失败时明确提示并回退 TS。当前 binary 要求宿主 Node 使用 Unicode 16.0；不匹配时不会静默改变字符串语义。 Linux x64 GNU 要求 glibc >= 2.34；不包含 musl 版。

旧包（含 `git:github.com/ZSY007/pitools`）先用 `pi remove <旧来源>` 移除声明，再安装本包；手工目录先备份并移出发现目录。不要同时加载三版。更新只执行 `pi update git:github.com/ZSY007/pitools-rust`，不要裸跑 `pi update` 升级 Pi。完成后在停止生成时手动 `/reload`、`/pitools version`、`/pitools core status`。

下载归档的用户：先解压到稳定目录，再 `pi install /绝对路径/pitools-rust`。本地目录安装不会自动跟随 Git 更新。

## 界面

Alt+T 显示/隐藏，Alt+I 打开完整详情；Tab 换页，R 切换原始 JSON，/ 搜索；输入蓝、模型紫、工具橙、失败红。首行最左侧活动文字统一 accent，只有 ● 变色。三版同样保留完整参数/结果/Schema/签名/usage，不虚构缺失思考或 provider TTFT。

`/pitools core ts` 可临时使用 TS 回退；本包不会启动另一个版本的 worker。换版本应移除当前包再安装目标包，不在三个独立包之间偷偷切换。Python/Rust worker 只计算活动，轨迹/详情/搜索/主题/渲染依然由 TS/Pi 完成；worker 不是权限沙箱。无运行时下载、编译、网络监听或自动重启。

源项目、性能限定与构建记录：https://github.com/ZSY007/pitools 。不宣称 Python/Rust 比 TS 整体更省 CPU。BSD-3-Clause；完整归属见 THIRD_PARTY_NOTICES.md 与 data/activity/LICENSE。

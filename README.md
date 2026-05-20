# Code Terminal

一个面向多项目开发的桌面终端工作台。它把常用项目、本地终端、单 Tab / 多瓦片布局和外观配置放在一个轻量窗口里，适合同时维护多个代码仓库、频繁切换命令行上下文的开发者。

> Built with Tauri, React, TypeScript, Rust and xterm.js.

## 界面预览

![Code Terminal preview](docs/code-terminal-preview.png)

## 下载

- [下载 Windows exe](https://github.com/hh357418341-create/code_terminal/releases/download/app-v0.1.0/code-terminal.exe)
- [查看所有发布文件](https://github.com/hh357418341-create/code_terminal/releases/tag/app-v0.1.0)

当前公开下载优先提供 Windows 版本；macOS / Linux 版本仍在验证中。

## 平台状态

- **Windows**：主力支持平台，当前优先打磨和发布。
- **macOS**：计划支持，已准备自动构建；未配置签名和 notarization 前先作为实验版本。
- **Linux**：计划支持，已准备自动构建；不同发行版依赖和桌面环境仍需要继续验证。

## 适合谁

- 经常在多个项目之间来回切换，需要快速打开不同项目终端的人
- 希望一个窗口里同时看多个命令、日志、构建任务的人
- 想要比系统终端更贴近项目工作流，但又不想引入笨重 IDE 面板的人
- Windows 用户，尤其是习惯直接打开本地 exe 管理多个项目的人

## 亮点

- **项目列表**：保存常用项目目录，支持拖动排序，默认优先打开排在前面的项目。
- **目录快捷打开**：点击项目行里的文件夹图标，可直接在系统文件管理器中打开对应目录。
- **项目复用**：点击项目时，如果对应终端已经存在，会直接切回现有终端；如果当前终端为空，会绑定到当前终端；否则自动新建终端。
- **单 Tab / 多瓦片**：单 Tab 模式只显示当前终端，其他终端保持后台运行；多瓦片模式会把多个终端同时铺开。
- **拖拽停靠布局**：在多瓦片模式下拖动终端标题栏，可把终端停靠到目标瓦片的上、下、左、右或中间，拖拽只调整布局，不会停止终端进程。
- **真实本地 PTY**：后端创建本地伪终端，支持交互式命令、ANSI 颜色、resize 和常规 shell 工作流。
- **项目窗口标题**：窗口标题和左上角显示当前项目文件夹名，任务栏里更容易区分多个项目窗口。
- **外观可调**：内置多套主题，也支持编辑并保存自定义主题；字号和行间距都可以直接输入。
- **图片粘贴桥接**：在界面中粘贴图片后，应用会临时保存图片，让 TUI 或命令行程序读取对应文件路径。
- **多项目入口**：可以从当前应用里打开另一个项目窗口，不用反复手动点 exe。

## 快速开始

```powershell
npm install
npm run dev
```

## 构建 Windows exe

```powershell
npm run build
```

构建完成后，可执行文件位于：

```text
src-tauri/target/release/code-terminal.exe
```

如果需要生成安装包：

```powershell
npm run bundle
```

Windows MSI 打包会下载 WiX 工具链，网络较慢时可能需要重试。

## Linux 服务器和手机访问

服务器模式会在 Linux/Windows/macOS 上启动一个 HTTP Web UI，并在服务器本机创建真实 PTY。手机访问这个页面时，输入会发送到服务器上的 shell，适合用手机临时操作服务器里的 Codex 或其他 TUI。

本机调试：

```bash
npm run server
```

默认监听 `127.0.0.1:8787`，浏览器打开：

```text
http://127.0.0.1:8787/
```

给局域网或手机访问时，需要显式设置 token：

```bash
CODE_TERMINAL_ADDR=0.0.0.0:8787 CODE_TERMINAL_TOKEN=change-this-token npm run server
```

手机打开：

```text
http://<server-ip>:8787/?token=change-this-token
```

也可以先构建服务器二进制：

```bash
npm run build:server
```

构建产物位于：

```text
src-tauri/target/release/code-terminal-server
```

可选环境变量：

- `CODE_TERMINAL_ADDR`：监听地址，默认 `127.0.0.1:8787`。
- `CODE_TERMINAL_TOKEN`：外部访问 token；只要监听地址不是本机回环地址就必须设置。
- `CODE_TERMINAL_STATE`：项目列表和主题配置文件路径，默认 `$HOME/.code-terminal/workbench-state.json`。
- `CODE_TERMINAL_DIST`：前端静态文件目录，默认当前工作目录下的 `dist`。

不要把未加 HTTPS 的服务直接暴露到公网；手机远程访问建议放在 Tailscale、ZeroTier、VPN 或带 HTTPS 的反向代理后面。

## GitHub Release

仓库包含 GitHub Actions 工作流：

- `CI`：在 push 和 pull request 时检查前端构建，并在 Windows、macOS、Linux 上运行 Rust backend `cargo check`。
- `Release`：手动触发或推送 `app-v*` tag 时构建 Windows 安装产物和便携 exe，并发布为 prerelease。

发布一个版本可以这样操作：

```powershell
git tag app-v0.1.0
git push origin app-v0.1.0
```

如果当前网络需要代理：

```powershell
git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin app-v0.1.0
```

## 技术栈

- **Desktop**：Tauri 2
- **Frontend**：React 18、TypeScript、Vite
- **Terminal UI**：xterm.js
- **Backend**：Rust、portable-pty
- **Platform focus**：Windows 优先，macOS/Linux 持续验证

## 本地终端行为

- Windows 默认启动 `powershell.exe -NoLogo`
- macOS/Linux 默认使用 `$SHELL`，没有 `$SHELL` 时使用 `/bin/sh`
- 选中项目后，终端工作目录就是该项目目录；再次点击已打开项目会切回已有终端
- 切换单 Tab / 多瓦片或拖拽调整布局时，隐藏的终端会继续运行
- 关闭应用时，会清理由工作台创建的终端进程

## 还在继续做

- 更完善的发布包和 GitHub Release
- 更多终端主题预设
- 更细的项目分组、启动配置和布局持久化
- 更稳定的跨平台行为验证

## License

当前暂未添加开源许可证；使用或二次开发前，请先联系作者确认授权方式。

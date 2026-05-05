# OpenCode Workbench

一个最小 Tauri 桌面工作台：左侧是项目列表，右侧是绑定项目目录的本地终端。

## 当前能力

- 选择本地项目目录
- 保存最近项目列表
- 左侧按最近打开时间展示项目
- 选中项目后，右侧终端自动切到项目目录
- 右侧是真实本地 PTY 终端，支持交互式命令、ANSI 颜色和 resize
- 可重启或停止当前终端会话
- 退出应用时清理由工作台创建的终端进程

## 运行

```powershell
npm install
npm run dev
```

## 构建

```powershell
npm run build
```

构建后的可执行文件在：

```text
src-tauri/target/release/opencode-workbench.exe
```

如果要生成安装包：

```powershell
npm run bundle
```

Windows MSI 打包需要下载 WiX 工具链，网络慢时可能超时。

## 本地终端

终端通过 Tauri 后端创建本地 PTY：

- Windows 默认启动 `powershell.exe -NoLogo`
- macOS/Linux 默认使用 `$SHELL`，没有 `$SHELL` 时使用 `/bin/sh`
- 如果已选择项目，终端工作目录就是项目目录
- 关闭应用时会清理由工作台创建的终端进程

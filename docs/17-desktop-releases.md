# 桌面构建与发布

网页、桌面程序和独立导出库共用同一套转换与场景导出核心。仓库提供GitHub Actions多平台构建配置，可在对应系统与架构完成打包、运行验证和附件发布。可用下载以实际发布记录为准。

## 发行包与平台选择

| 系统    | 架构                           | 文件                         | 运行入口                |
| ------- | ------------------------------ | ---------------------------- | ----------------------- |
| Windows | x64、ARM64                     | `家园蓝图-Windows-架构.zip`  | `HomelandBlueprint.exe` |
| macOS   | Intel x64、Apple Silicon ARM64 | `家园蓝图-macOS-架构.zip`    | `HomelandBlueprint.app` |
| Linux   | x64、ARM64                     | `家园蓝图-Linux-架构.tar.gz` | `HomelandBlueprint`     |

完整解压应用目录。macOS ZIP保留Framework符号链接，Linux tar.gz保留执行权限及符号链接，不要只拷贝其中的主程序。

发行版没有配置Windows发布者证书，也没有配置Apple Developer ID签名和公证。系统可能提示开发者未验证；可以核对仓库、构建记录和校验值，或自行构建。Linux需要可用图形环境及Electron依赖库，发行包不代表所有发行版都已测试。

## GitHub Actions 构建流程

发布前按根目录 `DEPLOYMENT.md` 配置实际仓库和网页地址。工作流会检查 README 与 `site.config.json` 一致，并核对当前 GitHub 仓库；桌面中的“开源仓库”仅打开已配置的仓库首页。

`.github/workflows/release.yml`由版本标签`vX.Y.Z`触发，也可手动指定已存在标签重跑。标签必须与根目录和桌面`package.json`版本一致，检出的提交必须就是该标签。

```text
源码、类型、核心测试、字段检查和文档示例验证
  → Windows/macOS/Linux × x64/ARM64原生构建
  → 启动各平台打包程序，执行9组真实导出检查
  → 汇总6个客户端、源码ZIP和离线页
  → 计算SHA-256，上传到草稿Release并核对附件
  → 全部通过后公开Release
```

任一平台失败，公开发布步骤不会执行。草稿上传中断可重跑；已公开版本不自动覆盖。日常`main`推送只发布网页，客户端只在版本标签或手动发布任务触发时构建。

临时Actions附件保留1天；正式下载附件保存在Release。`build-verification.json`记录提交、构建入口和各平台运行检查，`checksums.sha256`对应实际下载文件。

## 本地复现

在对应系统与架构安装Node.js和pnpm后执行：

```sh
pnpm install --frozen-lockfile
pnpm build:desktop
pnpm test:packaged
```

脚本默认使用本机平台和架构，并拒绝把跨架构打包当成原生验证。Linux的无界面CI使用虚拟显示服务，按系统要求配置Chromium沙箱；应用保持Chromium沙箱启用。

实际运行检查覆盖PNG/JPG/WebP/GIF输入、EXIF方向、墙面/地面尺寸、Worker、蓝图回读和ZIP内容。它不能替代人工界面验收，也不能证明生成文件已经在游戏中导入保存。

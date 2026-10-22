# GitHub 自动构建与 Cloudflare Pages 部署

项目是纯静态应用，无需数据库或后端服务。GitHub Actions 从 `main` 构建网页并将产物发布至 `page` 分支；Cloudflare Pages 直接托管该分支。桌面客户端使用独立工作流。

## 1. 源码、产物和网页地址

| 项目 | 当前配置 |
| --- | --- |
| 源码仓库 | `https://github.com/gamehomeland/gamehomeland.github.io` |
| 源码分支 | `main` |
| 静态产物分支 | `page`，产物位于分支根目录 |
| 本地构建目录 | `apps/web/dist/` |
| 网页地址 | `https://jx3homeland.com/`，需在 Cloudflare 完成域名绑定 |

修改源码后推送到 `main`，不要直接编辑 `page` 中的文件，下次构建会覆盖产物。发布会保留已有 `page` 分支历史。

站点和仓库链接由 `site.config.json` 管理，修改时运行：

```sh
node scripts/configure-site.mjs --owner gamehomeland --repo gamehomeland.github.io --site https://jx3homeland.com/
node scripts/configure-site.mjs --check
```

命令同步更新 README 顶部的“在线演示”和“源码仓库”链接。重新构建后，网页和桌面版使用同一源码仓库地址。`--check` 检查链接格式、README 一致性，以及 Actions 中的实际仓库；它不检查网站是否上线。

## 2. 本地构建验收

安装 Node.js 24 和 pnpm 11.25.0，在项目根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build:pages
```

`pnpm check` 包含资料校验、类型检查、核心测试、网页与离线文件构建。`pnpm build:pages` 生成用于托管的 `apps/web/dist/`，不包含开发运行检查页。Vite 使用相对资源路径 `base: './'`，请保留完整目录结构，包括 `models/`。

工作流还会检查 Python 工具和蓝图结构示例，可在本地复现：

```sh
python3 -m pip install -r tools/requirements.txt
python3 -m unittest discover -s tests -p '*_test.py'
pnpm example:structure
python3 tools/inspect_blueprint.py artifacts/structure-example/four-cells.blueprintx --output artifacts/structure-example/fields.json
```

`pnpm preview` 提供本地预览，默认地址为 `http://127.0.0.1:5173/`。

## 3. 自动更新 page 分支

`.github/workflows/pages.yml` 在推送到 `main` 或手动触发后依次执行：

1. 检查发布链接与当前仓库是否一致。
2. 按锁文件安装依赖，校验资料、类型、导出核心和 Python 工具。
3. 验证结构示例并运行 `pnpm build:pages`。
4. 将完整静态产物更新到 `page` 分支根目录。

检查或构建失败时不会更新 `page`。工作流只使用仓库提供的 `GITHUB_TOKEN`，发布任务需要 `contents: write`；无需个人令牌、Cloudflare 密钥或 GitHub Pages 配置。仓库的 Actions 策略和分支保护规则必须允许工作流更新 `page`。

可在仓库 **Actions** 中手动运行该工作流，选择 `main`。成功后核对 `page` 最新提交，以及根目录中的 `index.html`、脚本和 `models/`。

## 4. 连接 Cloudflare Pages

在 Cloudflare Pages 创建项目并连接 `gamehomeland/gamehomeland.github.io`，使用以下配置：

| 设置 | 值 |
| --- | --- |
| 生产分支 | `page` |
| 框架预设 | `None` |
| 构建命令 | `exit 0` |
| 构建输出目录 | `/` |
| 根目录 | 留空 |

`page` 已包含构建结果，Cloudflare 无需安装依赖或再次构建源码。自动部署应只跟踪 `page`，预览分支可选择 `None`，避免把 `main` 的源码当作网站部署。设置说明见 [Cloudflare 分支部署控制](https://developers.cloudflare.com/pages/configuration/branch-build-controls/)。

首次部署成功后，在 Pages 项目的 **Custom domains** 添加 `jx3homeland.com`，按 Cloudflare 提示完成域名验证和 DNS 配置。自定义域名操作见 [Cloudflare 自定义域名文档](https://developers.cloudflare.com/pages/configuration/custom-domains/)。仓库中的链接配置不会自动绑定域名或更改 DNS。

## 5. 上线验收

- 核对 GitHub Actions 成功、`page` 已更新，Cloudflare 部署对应同一次产物提交。
- 打开实际部署地址，确认首页、使用说明、技术文档和家园限制可用，网页“开源仓库”打开正确仓库。
- 加载示例，用墙面、长边 8 米生成蓝图，检查预览和下载入口。
- 打开“3D 家园布置”，检查地块选择、地下室编辑、工程保存与恢复。
- 从内置库选择家具并挖掘地下室，确认模型和贴图加载；检查手动导入 GLB 的入口。
- 使用真实原整屋进行合并时，核对原布置只读、新增部分可编辑，完整包包含原整屋和新增工程。
- 浏览器控制台无脚本错误，Worker、脚本和模型均从本次站点正常加载。

当前随附模型约 52.4 MiB，最大 GLB 约 4.3 MiB，按使用情况加载。新增资源后应检查静态文件数量和单文件大小，遵守 [Cloudflare Pages 限制](https://developers.cloudflare.com/pages/platform/limits/)。游戏内导入、保存和重载仍需单独验收。

## 6. 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 发布地址检查失败 | 重新运行地址配置命令，核对 README、`site.config.json` 与实际仓库 |
| `page` 未更新 | 检查 Actions 失败步骤、工作流写入权限和分支保护规则 |
| Cloudflare 部署源码或首页 404 | 确认生产分支为 `page`、构建命令为 `exit 0`、输出目录为 `/`，且分支根目录有 `index.html` |
| 页面打开但脚本、Worker 或模型加载失败 | 确认发布了完整产物，检查资源请求路径和响应 |
| 自定义域名不可访问 | 先检查 Pages 默认地址，再核对域名绑定、DNS 和证书状态 |
| 安装依赖失败 | 使用锁定的 Node/pnpm 版本并查看日志，不要删除锁文件绕过 |

## 7. 可选：发布桌面客户端

网页部署不需要触发桌面发布。需要发行客户端时，先确认根目录和 `apps/desktop/package.json` 版本一致，再创建对应的 `vX.Y.Z` 标签。例如版本均为 `0.1.0` 时：

```sh
git tag v0.1.0
git push origin v0.1.0
```

`Desktop release` 工作流将构建 Windows、macOS、Linux 的 x64/ARM64，运行各平台打包自检，全部通过后发布 Release，附带客户端、源码 ZIP、离线页与校验文件。已有标签或公开版本不要覆盖；具体构建与签名范围见[桌面构建与发布](docs/17-desktop-releases.md)。

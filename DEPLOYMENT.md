# GitHub 源码托管与网页部署

本指南从源码 ZIP 开始，将项目上传至部署者自己的仓库，并通过 GitHub Actions 发布 GitHub Pages。网页为静态应用，无需数据库、后端服务、Cookie 或私有 API。桌面发行包使用独立工作流。

## 1. 确定仓库与网页地址

推荐创建公开的账号主页仓库，取得不含项目路径的地址：

| 项目          | 填写方式                                         |
| ------------- | ------------------------------------------------ |
| GitHub 用户名 | `gamehomeland`，不是显示昵称               |
| 仓库名        | `gamehomeland.github.io`                             |
| 仓库地址      | `https://github.com/gamehomeland/gamehomeland.github.io` |
| 网页地址      | `https://gamehomeland.github.io/`                    |
| 默认分支      | `main`                                           |

账号主页仓库必须按上述规则命名；若该仓库已有内容，应先核对用途。普通项目仓库也可部署，地址会包含仓库名，例如 `https://gamehomeland.github.io/homeland/`。公开仓库可使用 GitHub Free 的 Pages。[GitHub Pages 快速入门](https://docs.github.com/en/pages/quickstart)、[发布来源说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 2. 首次提交前配置链接

解压源码包，进入包含 `package.json` 的 `jx3-homeland-blueprint` 目录。安装 Node.js 24、Git 和 pnpm 11.25.0。

**当前部署账号为 `gamehomeland`。** 下列配置步骤必须早于首次提交；迁移到其他账号时请更新该参数。

```sh
node scripts/configure-site.mjs --owner gamehomeland
node scripts/configure-site.mjs --check
```

配置命令完成两项修改：

- `README.md` 顶部生成实际的“在线演示”和“源码仓库”链接。
- `site.config.json` 保存网页与仓库地址，构建时同步到网页右上角“开源仓库”；桌面版使用同一仓库地址。

普通项目仓库需额外指定名称：

```sh
node scripts/configure-site.mjs --owner gamehomeland --repo homeland
node scripts/configure-site.mjs --check
```

自定义域名可通过 `--site https://实际域名/` 指定。这只更新项目链接，域名仍需在 GitHub Pages 设置与 DNS 中独立配置。未使用自定义域名时无需此参数。

执行后打开 README，核对顶部两个链接。不要直接编辑生成后的网页文件；地址变更后重新运行配置命令并构建。`--check` 检查地址格式、Pages 路径和 README 一致性；Actions 中还会检查是否与当前仓库匹配。该检查不表示网站已经上线。

## 3. 本地构建验收

```sh
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm check
pnpm build:pages
```

`pnpm check` 包含资料校验、类型检查、核心测试、网页与离线文件构建。`pnpm build:pages` 生成适合静态托管的 `apps/web/dist/`，不包含开发运行检查页。使用 `pnpm preview` 可在 `http://127.0.0.1:5173/` 核对当前构建；该端口已有服务时先结束原预览。

工作流还运行 Python 工具检查，本地复现命令：

```sh
python -m pip install -r tools/requirements.txt
python -m unittest discover -s tests -p '*_test.py'
```

Vite 使用相对资源路径 `base: './'`，账号主页和普通项目子路径均使用同一构建配置。请保留整个 `dist/` 目录结构。

## 4. 创建仓库并上传源码

在 GitHub 中选择 **New repository**，填写第 1 节确定的仓库名，选择 **Public**。新仓库不要初始化 README、`.gitignore` 或许可证，这些文件已在源码包中提供。已有非空仓库应另行处理，以下步骤仅用于新建空仓库。

源码 ZIP 不含 `.git`。在解压后的项目根目录执行：

```sh
git init -b main
git config user.name "实际提交者名称"
git config user.email "实际提交邮箱或GitHub提供的隐私邮箱"
node scripts/configure-site.mjs --check
git status --short
git add .
git diff --cached --stat
git commit -m "Initial release"
```

核对暂存清单只包含源码、文档、数值资料、示例与测试。`assets/models/` 是应一同提交的模型资源，`.gitignore` 已排除依赖、构建产物和原始提取目录。不要把整个 `assets` 目录移入忽略列表。

从 `site.config.json` 复制 `repositoryUrl`，用于下面的 `https://github.com/gamehomeland/gamehomeland.github.io`：

```sh
git remote add origin https://github.com/gamehomeland/gamehomeland.github.io.git
git push -u origin main
```

例如地址以仓库名结束，末尾再加 `.git`。认证使用 Git Credential Manager、GitHub CLI 或已配置的 SSH，不要把访问令牌写进项目文件。普通推送即可，不需要强推或改写其他仓库历史。[GitHub：将本地代码加入仓库](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)

## 5. 启用 GitHub Pages

1. 打开仓库 **Settings → Pages**。
2. 在 **Build and deployment → Source** 选择 **GitHub Actions**。
3. 保留源码中已有的 `.github/workflows/pages.yml`，无需再创建模板工作流。
4. 进入 **Actions → GitHub Pages → Run workflow**，选择 `main`。首次推送如果早于 Pages 设置，可在配置完成后手动重跑。
5. 等待 `build` 和 `deploy` 均成功，打开 `github-pages` 部署记录中的实际地址。
6. 仓库主页 **About → Website** 填入同一网页地址。

上述发布入口采用 GitHub 的自定义工作流方式。工作流已为部署任务声明 `pages: write`、`id-token: write` 和 `github-pages` 环境，正常使用无需另外保存个人令牌。[GitHub：自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## 6. 上线验收

- README 的在线演示打开实际网页；网页右上角“开源仓库”可点击并打开本次仓库。
- 首页、使用说明、技术文档和家园限制可正常打开，弹窗关闭按钮可见。
- 加载示例，使用墙面、长边 8 米生成蓝图，检查预览及两个下载入口。
- “3D 家园布置”能打开，地块选择、地下室编辑、工程保存与恢复可用。
- 从内置库选择家具并挖掘地下室，确认模型和贴图自动加载；还应检查手动导入 GLB 的入口。
- 使用真实原整屋进行合并时，核对原布置只读、新增部分可编辑，完整包包含原整屋和新增工程。
- 浏览器控制台没有脚本错误，Worker 与分块资源均从本次网站加载。

源码包包含 `assets/models/` 的 38 份家具模型与 6 份地下室模型包，贴图已内嵌。Pages 和桌面构建自动携带同一套资源，不需要额外资源 ZIP。当前资源约 52.4 MiB，按使用情况加载。新增与压缩流程见[内置模型库](docs/24-model-library.md)。

当前最大 GLB 约 4.3 MiB，可随普通 Git 文件提交，无需为这组资源额外配置 LFS。后续扩充时应检查单文件与站点总大小：GitHub 拒绝超过 100 MiB 的普通 Git 文件，Pages 发布站点不得超过 1 GB。[GitHub 文件大小说明](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)、[Pages 使用限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

## 7. 常见问题

| 现象                               | 检查方法                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| 地址检查失败                       | 重新执行配置命令，核对 README、`site.config.json` 与实际仓库                       |
| `configure-pages` 提示找不到 Pages | 先设置 Pages Source 为 GitHub Actions，再重跑工作流                                |
| 网页 404                           | 确认 `deploy` 成功，使用部署记录中的地址，核对仓库名与项目路径                     |
| 页面能打开但脚本失败               | 检查上传路径是否为完整 `apps/web/dist/`，保留相对资源路径                          |
| 地下室只有结构预览或家具列表为空   | 先检查 `dist/models/` 是否完整上传、网络请求与文件哈希；不在示例库中的资源显示占位 |
| 安装依赖失败                       | 使用锁定的 Node/pnpm 版本，查看失败步骤日志；不要删除锁文件绕过                    |
| 发布权限失败                       | 检查账号权限、仓库 Actions 策略和 `github-pages` 环境限制                          |

## 8. 可选：发布桌面客户端

网页部署不需要触发桌面发布。需要发行客户端时，先确认根目录和 `apps/desktop/package.json` 版本一致，再创建对应的 `vX.Y.Z` 标签。例如版本均为 `0.1.0` 时：

```sh
git tag v0.1.0
git push origin v0.1.0
```

`Desktop release` 工作流将构建 Windows、macOS、Linux 的 x64/ARM64，运行各平台打包自检，全部通过后发布 Release，附带客户端、源码 ZIP、离线页与校验文件。已有标签或公开版本不要覆盖；具体构建与签名范围见[桌面构建与发布](docs/17-desktop-releases.md)。

## 交付记录

部署完成后记录仓库地址、网页地址、实际部署提交、Actions 运行链接及验收结果。客户端发布应另列标签、Release 地址和各平台检查状态；尚未执行的项目明确标为未验证。

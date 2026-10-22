# 参与开发

项目采用 MIT-0 许可。使用、修改、集成、分发和商用均无需署名或向本项目申请授权；引入新依赖也没有额外审批流程。

## 环境配置

安装 Node.js 22.12 或以上版本与 pnpm 11.25.0，然后在工程根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

独立核心调用示例为 `pnpm example:core`。示例会把真实蓝图和完整包写入 `artifacts/core-example/`，不需要启动网页、安装 Python 或配置服务。

工程结构见[技术栈与架构](docs/09-technology-and-architecture.md)，接口与验证要求见[开发者指南](docs/08-developer-guide.md)和[导出流程](docs/05-export-pipeline.md)。

## 工程约定

- 核心算法放在 `packages/core/src/`，保持输入/输出为数值和字节；文件选择、网络、DOM 和窗口逻辑放在应用层。
- 修改 `.ts`、源 Markdown 或 `data/*.json`。不要手改 `*.generated.ts`，通过 `pnpm catalog` 生成。
- 数值资料需保持版本一致，更新时校验对应 manifest。颜色必须能对应真实家具或明确的组合，预览从实际文件回读。
- 同一输入和参数应可重复导出；不要把当前日期、随机数或本机路径混入蓝图文件。
- 参数变动要同步核心校验、网页、使用说明与相关测试。
- 新增依赖需更新 `package.json`、锁文件和第三方说明；不要把 `node_modules` 或平台可执行文件放入源码。
- 用户界面使用简明中文。错误提示说明用户下一步能做什么；技术细节留在开发文档。
- 文档采用客观的功能、格式、流程和验证说明，标题使用明确的主题名称。发布说明不包含对话引用、临时工作进度或未经验证的能力承诺。

## 按变更范围验证

```sh
pnpm check
```

更改颜色或布局时，补测实际图片、黑白线条、透明图、渐变，覆盖墙面/地面和不同尺寸。核对文件、家具清单与回读预览，而不仅是渲染一张截图。记录游戏内导入、保存与重载的实际验收状态。

更改桌面或公共界面时，先 `pnpm build:web`，再 `pnpm test:desktop`。需要检查最终包时运行 `pnpm build:desktop`，并对打包后的程序执行 `--self-test`；自检结果可由 `HOMELAND_TEST_RESULT` 指定写入文件。

`pnpm build:review` 生成八组样例；`pnpm preview` 提供本地制作页和 `/review.html`。网页开发服务与该预览服务都使用 5173 端口，一次启动一个即可。

## 变更说明与交付要求

说明解决的问题、改动范围、验证命令和结果。涉及视觉效果时，附同图、同尺寸对照及对应 `.blueprintx` 文件。游戏光照、容量、视角等尚未实测的部分单独列出。

源码包可用 `pnpm package:source` 生成。包内包含源代码、资料、文档、测试与示例；构建产物另行交付。发布前应从源码包解压到新目录，按 README 安装和构建，避免依赖未打包的本地文件。

更换发布账号或仓库时，在提交前执行 `node scripts/configure-site.mjs --owner 实际用户名`，普通项目仓库另加 `--repo 仓库名`，随后执行 `node scripts/configure-site.mjs --check`。命令同步 README 与 `site.config.json`，构建后的网页和桌面共用该仓库链接。完整操作见根目录 `DEPLOYMENT.md`。

# 技术栈与架构

**网页用于基础功能展示与技术参考，支持基于源码进行功能扩展和效果优化。** 导出核心可独立集成，配色、布局和交互模块可分别扩展。

**MIT-0 开源：可以自由使用、修改、集成、分发和商用，无需署名、无需保留本项目许可声明，也无需申请授权。**

## 项目形态

入门结构见[四格组件示例](15-reading-homeland.md)，操作链见[客户端操作与问题定位](16-client-operations.md)。本章说明运行环境、工程分层、模块入口及构建验证流程。

家园蓝图是一套图片转蓝图与3D家具布置工具：同一份 TypeScript 核心同时服务网页、Windows/macOS/Linux桌面和开发者的 Node.js 程序。网页用原生 HTML/CSS 和 DOM 事件构建界面，使用 Vite 打包；桌面用 Electron 加载相同页面。

解析与模型能力的详细状态见[覆盖范围与在线3D扩展](18-coverage-and-3d.md)。家具索引、字段解析、场景编辑和游戏内验收分别记录支持范围。

转换计算运行在本机 CPU。网页将工作交给 Web Worker；选图、进度和取消操作保留在主线程。3D查看使用本机WebGL2，按需加载，静止时不持续重绘。导出不依赖3D能力，也不依赖服务器、数据库、登录或远程转换服务。

## 技术与版本

下列版本对应仓库的 `package.json`。完整依赖及精确解析结果以 `pnpm-lock.yaml` 为准。

| 技术                                  | 版本或约束 | 使用位置与用途                                |
| ------------------------------------- | ---------- | --------------------------------------------- |
| TypeScript                            | 7.0.2      | 严格类型检查；核心和网页源代码                |
| Vite                                  | 8.3.5      | 网页开发服务、ES2022 产物、Worker 打包        |
| 原生 HTML/CSS                         | 浏览器标准 | 表单、响应式布局、原生 dialog、可访问性状态   |
| Web Worker / TypedArray               | 浏览器标准 | 后台计算与像素、文件字节传输                  |
| Three.js / OrbitControls / GLTFLoader | 0.186.1    | 拼布实例化显示、自包含GLB与相机控制           |
| Electron                              | 45.0.0     | Chromium 桌面渲染器，隔离的主进程             |
| @electron/packager                    | 20.3.0     | 三个桌面系统、两种架构的应用打包              |
| fflate                                | 0.8.3      | PNG zlib 数据和 ZIP 打包                      |
| spark-md5                             | 3.0.2      | 蓝图格式要求的 MD5 摘要；不用于密码或身份认证 |
| Node.js                               | ≥ 22.12    | 构建、脚本、测试，以及脱离界面的核心调用      |
| pnpm                                  | 11.25.0    | workspace、依赖安装、锁文件                   |
| tsx                                   | 4.23.15    | 执行 TypeScript 示例与 Node.js 测试           |
| markdown-it                           | 15.0.3     | 构建时把项目文档转成内嵌 HTML                 |
| Prettier                              | 3.9.10     | 统一源文件格式                                |

选图和导出不需要安装 Node.js。开发者构建项目需要 Node.js 与 pnpm。Python和C++工具用于离线生成数值目录、转换模型和核查文件；网页及桌面直接读取已生成的数据。

## 分层和依赖方向

```text
apps/web                         apps/desktop
  HTML / CSS / TypeScript         Electron 主进程
  文件选择、图片解码               只读资源协议、窗口、下载
          │                         │
          └──── 同一套网页界面 ──────┘
                       │
               export.worker.ts
                       │
                  packages/core
        采样 → 配色 → 排布 → 编码 → 回读 → 打包
                       ↑
                catalog.generated.ts
                       ↑
            scripts/build-catalog.mjs
                       ↑
                    data/*.json
```

图像转换核心接收RGBA字节与导出参数；家具编辑核心接收资源绑定、实例变换和地块选择。两者均不依赖DOM、Electron、文件路径或网络。应用层负责输入、交互与保存，核心负责验证和序列化。

家具编辑调用关系：

```text
furniture-panel / land-panel
          ↓
      scene-panel → SceneHistory
          ├─ scene-viewer → Three.js / GLB / 材质
          └─ editor.ts / land.ts / basement.ts → 校验 → 局部或整屋蓝图
```

资源绑定、地块坐标分别由`editor_catalog.json`和`land_catalog.json`提供，GLB承载显示模型与材质。`basement_models.json`记录地下室模型形态及地板挂面，`basement.ts`维护网格和连通关系，`basement-assets.ts`加载并复用模型与贴图。含地下室时导出整屋蓝图，验证边界见对应专题。

`blueprint-structure.ts` 按 `blueprint_resources.json` 记录的资源缩放布局遍历原整屋。`blueprint-merge.ts` 追加新增布置，保留地表、植被与未受影响节点的字节；`blueprint-connect.ts` 更新相接房间的形态、挂面及必要的子挂件局部变换，核对原家具世界变换与内部挂接。原布置只读显示，缺少 GLB 时使用位置标记，不影响原数据保留。

`catalog.generated.ts`、`experimental.generated.ts` 和 `content.generated.ts` 是构建产物，不手工编辑。运行 `pnpm catalog` 从资料和 Markdown 重新生成。

## 导出模块与调用关系

| 步骤     | 文件                                            | 关键行为                                                       |
| -------- | ----------------------------------------------- | -------------------------------------------------------------- |
| 输入     | `apps/web/src/upload.ts`、`gif.ts`              | 校验文件头和尺寸；GIF 固定使用第一帧                           |
| 界面状态 | `apps/web/src/main.ts`                          | 参数版本、进度、取消、更换图片、下载链接回收                   |
| 线程边界 | `apps/web/src/export.worker.ts`                 | 接收 RGBA 和参数，返回进度及结果；ArrayBuffer 转移避免额外复制 |
| 导出调度 | `packages/core/src/engine.ts`                   | 产生候选，按效果与实际家具预算选优                             |
| 网格     | `packages/core/src/image.ts`                    | 面积采样、像素画保护、留白、格数与实体尺寸                     |
| 颜色     | `packages/core/src/color.ts`、`math.ts`         | Lab/CIEDE2000 匹配、暗部和灰阶保护、质量评分                   |
| 试验材质 | `packages/core/src/experimental.ts`、`glass.ts` | 分区选色、异形轮廓、透明覆盖与完整基础方案回退                 |
| 几何     | `packages/core/src/layout.ts`、`component.ts`   | 家具规格、缩放、四元数、普通/微缩布局和挂接树                  |
| 蓝图文件 | `packages/core/src/codec.ts`                    | V7 二进制字段、摘要及重新解码                                  |
| 结果文件 | `packages/core/src/png.ts`、`bundle.ts`         | 从文件回读的效果预览、清单、说明与 ZIP                         |

保存前会重新读取实际 `.blueprintx`，验证家具资源、数量、缩放、坐标与朝向。微缩布局还做可见性采样。文件验证与游戏内实际摆放验证是两项不同的检查。

## 三种使用方式

### 网页开发

在工程根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://127.0.0.1:5173/`。默认只监听本机地址。`pnpm build:web` 生成 `apps/web/dist/` 和 `artifacts/家园蓝图-离线版.html`；静态托管使用整个 `dist/` 目录。

### 桌面应用

```sh
pnpm desktop
pnpm build:desktop
```

`pnpm desktop`构建并启动桌面程序；`pnpm build:desktop`生成当前系统与架构的发行包。仓库提供六个目标的GitHub原生构建及打包自检配置，见[桌面构建与发布](17-desktop-releases.md)。桌面页面开启 `sandbox`、`contextIsolation`，关闭 `nodeIntegration`。主进程使用 `homeland://app/` 只读协议，页面没有任意文件读写或执行命令的接口。

### 核心库二次开发

```sh
pnpm example:core
pnpm build:core
```

示例在 `examples/export-blueprint.ts`：创建 RGBA 图像、调用 `exportImage`，再调用 `createPackage` 保存真实蓝图、PNG、清单与 ZIP。输出在 `artifacts/core-example/`。

`pnpm build:core` 生成 ESM JavaScript 和 `.d.ts` 类型声明。在 workspace 中添加 `@jx3-homeland/blueprint-core: workspace:*` 依赖后，从包入口导入；其他工程可先以本地包方式接入。导出核心使用workspace或本地包方式集成。

核心调用是同步 CPU 任务。交互应用应放进 Worker；Node.js 大批量任务可以由调用方使用 `worker_threads` 调度。项目提供独立导出库。

## 模块修改与验证要求

家园机制的系统入口见 [家园系统与扩展路线](12-homeland-development-map.md)，材质到最终显示的关系见 [光照与场景](11-lighting-and-scene.md)，容量和导入边界见 [家园限制](10-game-limits.md)。

| 变更范围   | 入口                                               | 应检查的结果                               |
| ---------- | -------------------------------------------------- | ------------------------------------------ |
| 界面与文案 | `apps/web/index.html`、`src/main.ts`、`src/ui.css` | 小屏布局、切换参数后旧下载失效、取消任务   |
| 图片格式   | `upload.ts`、`gif.ts`                              | 损坏文件、透明图、EXIF 方向、GIF 首帧      |
| 配色       | `color.ts`、`catalog.ts`                           | 轮廓、灰阶、渐变、照片，且文件回读预览相同 |
| 尺寸与摆放 | `image.ts`、`layout.ts`                            | 墙面/地面、小尺寸、大尺寸、预算与遮挡      |
| 文件格式   | `codec.ts`                                         | 已知字节约定、损坏输入拒绝、编解码一致性   |
| 桌面行为   | `apps/desktop/main.cjs`、`policy.cjs`              | 协议范围、导航、下载、真实 Electron 自检   |

运行 `pnpm check` 执行资料校验、类型检查、单元测试及网页构建。`pnpm test:desktop` 使用已构建网页做真实 Electron/Worker 导出测试；`pnpm build:review` 生成更多样例。具体开发约定见仓库的 `CONTRIBUTING.md` 和 `docs/08-developer-guide.md`。

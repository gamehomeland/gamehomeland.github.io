# 家园蓝图

<!-- project-links:start -->

[在线演示](https://gamehomeland.github.io/) · [源码仓库](https://github.com/gamehomeland/gamehomeland.github.io)
<!-- project-links:end -->

将图片转换为剑网3家园拼布组件，或在 3D 场景中布置家具与地下室，导出 `.blueprintx` 蓝图、工程文件和家具清单。

**网页仅展示基础功能和部分家具、地下室组件，未覆盖全部家园能力。提供实现思路与技术参考，功能扩展和效果优化可通过二次开发完成。** 项目提供网页、Windows/macOS/Linux桌面应用、可独立调用的 TypeScript 核心，以及家园机制和蓝图格式文档。

[使用说明](docs/00-user-guide.md) · [技术与开发](docs/09-technology-and-architecture.md) · [家园限制](docs/10-game-limits.md)

## 功能

| 功能       | 说明                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| 图片输入   | PNG、JPG、静态 WebP、GIF；文件不超过50 MiB、800万像素，GIF只取第一帧               |
| 墙面与地面 | 墙面长边1～96米，地面长边1～200米，保持图片比例                                    |
| 自动适配   | 自动选择采样格数、拼布规格、配色与布局；可填写包含基座的家具预算                   |
| 拼布配色   | 71种不透明底色；普通叠层提供426个配方；微缩布局保留精细轮廓                        |
| 试验材质   | 六类彩色透明材料参与可关闭的墙面配色试验，综合评分改善时采用                       |
| 文件回读   | 从导出的蓝图核对资源、数量、缩放、方向和遮挡，再生成效果预览                       |
| 蓝图3D     | 回读实际文件显示拼布实体，旋转、缩放、切换视角和查看结构线                         |
| 家具3D     | 内置部分家具 GLB 与贴图，支持染色、尺寸、结构线及额外模型导入                      |
| 在线布置   | 已绑定36件家具；移动、旋转、缩放、复制删除、撤销重做、保存工程、导出及重新导入蓝图 |
| 地块范围   | 七档设计规格、五个社区108处地块、私宅七个分区；检查完整水平投影                    |
| 地下室     | 4米与8米组件、六种资源、144个模型形态；挖掘、回填、分层查看及地下家具挂接          |
| 导出文件集 | 图片包包含蓝图、预览、清单和说明；布置包包含蓝图、工程、清单和说明                 |
| 独立核心   | 网页、桌面和Node.js共用同一套导出逻辑，便于集成或替换界面                          |

网页为纯静态应用，转换在CPU Worker中执行。图片不上传，不依赖服务器、数据库或账号系统。

地块范围参与编辑、导入与导出校验。坐标、面积及适用边界见[地块布局说明](docs/22-land-layouts.md)。

地下室采用专用级联笔刷与地形洞口，地下家具按地板挂接并随整屋蓝图导出。同规格新增房间可与原房间横向或上下连通，合并时保留原家具的世界位置与内部挂接。资源与实现范围见[地下室组件说明](docs/23-basement-and-terrain.md)。

源码包同时提供 `assets/models/` 中的 38 份家具模型和 6 份地下室模型包，贴图内嵌在 GLB 中。网页与桌面构建直接包含这些资源，选择家具或使用地下室材质时按需加载。36 件家具支持布置导出，另外 2 份仅供单件预览。接入、压缩和新增家具步骤见[内置模型库](docs/24-model-library.md)。

## 使用

顶部“图片转蓝图”和“3D家园布置”是独立工作区；“3D家园布置”进入家具编辑器，左侧添加家具，选中后拖动操作轴或填写数值，再导出蓝图/完整包。保存工程可继续编辑，当前标签页刷新可恢复暂存。详见[在线布置与导出](docs/20-scene-editor.md)。

图片制作流程：

1. 选择图片，或点击“加载示例”。
2. 选择墙面画或地面图案，填写成品长边。
3. 点击“生成蓝图”，查看效果和家具数量。
4. 下载完整包，按清单准备家具，在游戏的局部组件入口导入。

“更多选项”可设置家具预算、整体操作基座和试验配色。试验配色默认关闭；它使用中性材质模型，游戏内的光照、纹理和透明效果需要实景核对。

已有家园的扩建流程：

1. 在“3D 家园布置”中选择对应户型或分区，点击“载入原整屋”。
2. 点击“连通原房间”，选择相同的 4 米或 8 米规格及工作层，再点击绿色扩建格。
3. 原房间与原家具只读显示，新增房间和家具可编辑；模型缺失时显示位置或结构标记。
4. 使用“合并导出蓝图”或“导出完整包”，从游戏整屋入口导入并核对。

家具布置不含地下室且未载入原整屋时导出局部组件；地下室使用整屋蓝图。合并保留原有家具、地下室、灯光、地表涂绘和植被，再加入新增布置。选择“新建整屋”会替换整个家园，选择私宅分区也不改变这一范围。工程 JSON 保存新增编辑数据，合并完整包另附原始整屋；刷新后需重新选择原始整屋作为底图。

### 网页与离线文件

静态托管使用完整的 `apps/web/dist/` 目录。`artifacts/家园蓝图-离线版.html` 将脚本、示例和资料内嵌为一个文件。单文件 HTML 不内嵌整套模型，可手动打开 GLB；完整离线模型库使用桌面版。浏览器若限制本地页面的 Worker，可使用本地静态服务器或桌面应用。

### 桌面客户端

桌面构建支持Windows、macOS、Linux的x64与ARM64版本，选择与设备匹配的产物。Windows/macOS使用ZIP，Linux使用tar.gz。完整解压后运行对应应用，保留应用目录中的其他文件。安装与签名范围见[桌面构建与发布](docs/17-desktop-releases.md)。

## 技术栈

| 层级     | 技术                                | 用途                                          |
| -------- | ----------------------------------- | --------------------------------------------- |
| 网页     | TypeScript、原生HTML/CSS、Vite      | 表单、预览、下载和静态构建                    |
| 图片输入 | File、Canvas、ImageBitmap、GIF解析  | 格式检查与RGBA解码                            |
| 计算     | Web Worker、TypedArray              | 配色与几何计算，支持取消                      |
| 三维显示 | Three.js、OrbitControls、GLTFLoader | 拼布实例化与家具GLB查看，按需加载             |
| 导出核心 | TypeScript                          | 采样、Lab/CIEDE2000配色、布局、V7编解码和回读 |
| 文件处理 | fflate、spark-md5、PNG编码器        | ZIP/zlib、格式摘要和预览文件                  |
| 桌面     | Electron、@electron/packager        | 复用网页的Windows/macOS/Linux应用             |
| 工程     | pnpm workspace、Node.js、TypeScript | 依赖、类型检查、构建和测试                    |
| 资料工具 | Python、NumPy、Pillow、C++17        | 离线整理数值资料；不参与应用日常运行          |

依赖版本和模块入口见[技术栈与架构](docs/09-technology-and-architecture.md)，精确依赖以 `pnpm-lock.yaml` 为准。

家具模型的来源、Mesh字节布局、GLB转换和网页加载过程见[从资源到家具3D](docs/19-model-to-glb.md)；蓝图字段与未确认部分见[字段字典](docs/13-blueprint-field-reference.md)。预览范围、资源索引和在线编辑路线见[解析覆盖与3D扩展](docs/18-coverage-and-3d.md)。

## 开发与构建

环境要求：Node.js ≥22.12、pnpm 11.25.0。安装依赖需要网络；转换功能不需要联网。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

开发地址为 `http://127.0.0.1:5173/`，默认只监听本机。

```sh
pnpm check          # 资料校验、类型检查、测试、网页与离线页构建
pnpm build:pages    # 生成GitHub Pages静态页面
pnpm build:core     # 可复用的JavaScript与类型声明
pnpm desktop        # 构建并运行桌面应用
pnpm build:desktop  # 当前系统与架构的桌面应用和发行包
pnpm test:desktop   # Electron渲染器与Worker导出自检
pnpm test:packaged  # 启动已打包客户端，验证真实导出
pnpm example:core   # 直接调用核心，生成蓝图与ZIP
pnpm example:structure # 四格小例子，查看节点树和实际文件
pnpm samples        # 尺寸、方向、透明背景等样例
pnpm build:review   # 样例和原理预览页
pnpm preview        # 本地静态制作与预览服务
pnpm package:source # 源码ZIP
```

研究工具的补充检查：

```sh
python -m pip install -r tools/requirements.txt
python -m unittest discover -s tests -p "*_test.py"
node --import tsx examples/export-material-board.ts
```

打包后的桌面程序支持 `--self-test`；可通过 `HOMELAND_TEST_RESULT` 指定JSON结果文件。开发约定见[贡献指南](CONTRIBUTING.md)。

## 核心流程

```text
图片 → 格式与尺寸检查 → GIF首帧 / RGBA解码
                       ↓
             网格和预算 → 配色 → 家具布局
                       ↓
                  .blueprintx
                       ↓
            文件回读 → 几何、数量与可见性校验
                       ↓
                预览、清单和ZIP
```

`packages/core` 不依赖DOM或Electron。调用方提供RGBA和导出参数，即可取得蓝图字节及验证结果；[核心调用示例](examples/export-blueprint.ts) 可直接运行。

## 目录

| 目录            | 内容                                     |
| --------------- | ---------------------------------------- |
| `packages/core` | 配色、几何、蓝图编解码、回读、PNG与ZIP   |
| `assets/models` | 随附家具与地下室 GLB、内嵌贴图及资源清单 |
| `apps/web`      | 网页界面、图片解码与Worker               |
| `apps/desktop`  | 桌面窗口、资源协议与下载策略             |
| `data`          | 家具、配色、试验材质数值及校验信息       |
| `tools`         | 资料生成与只读蓝图检查工具               |
| `tests`         | 文件、几何、图片输入和运行策略测试       |
| `docs`          | 使用、开发、家园机制与格式文档           |
| `examples`      | 示例图、核心调用与材质试色板             |
| `scripts`       | 资料编译、样例和打包入口                 |

## 文档

[解析覆盖与三维扩展](docs/18-coverage-and-3d.md)列出字段读写范围、未确认语义及资源关联规则。源码包含9302行家具目录和17879行表现资源元数据；在线编辑器支持已绑定的36件普通家具、地块范围，以及6种地下室组件的挖掘、回填、原始模型贴图预览、地下家具摆放和整屋蓝图导出。复杂预制体、完整地形材质与碰撞不在模拟范围内。随附的部分家具、地下室模型及内嵌贴图与源码一同提供。

文档阅读顺序：**[四格组件示例与术语](docs/15-reading-homeland.md) → [客户端操作与排错](docs/16-client-operations.md) → [系统地图](docs/12-homeland-development-map.md) → 对应专题**。四格组件示例生成蓝图文件和逐节点JSON，可与字段检查器输出的字节偏移交叉验证。

| 主题                                               | 内容                                       |
| -------------------------------------------------- | ------------------------------------------ |
| [覆盖范围与在线3D](docs/18-coverage-and-3d.md)     | 解析支持表、家具索引、模型现状及扩展步骤   |
| [家具模型与GLB](docs/19-model-to-glb.md)           | 几何解码、资源关联与模型加载               |
| [家具布置与导出](docs/20-scene-editor.md)          | 编辑操作、历史记录、工程与蓝图写回         |
| [贴图与材质](docs/21-furniture-materials.md)       | 高清纹理、PBR映射、染色方案与验证          |
| [地块布局](docs/22-land-layouts.md)                | 户型尺寸、社区四角、私宅分区与边界约束     |
| [地下室与洞口](docs/23-basement-and-terrain.md)    | 专用笔刷、地形洞口、局部高度与支持范围     |
| [桌面构建与发布](docs/17-desktop-releases.md)      | 六个平台构建、实际运行检查、下载及签名范围 |
| [入门与四格组件示例](docs/15-reading-homeland.md)  | 从5件家具、17个节点理解资源、坐标与文件    |
| [客户端操作与排错](docs/16-client-operations.md)   | 回调阶段、导入状态、分组区别与故障定位     |
| [家园系统](docs/12-homeland-development-map.md)    | 系统分层、资源关系和开发入口               |
| [家具与挂接](docs/01-homeland-model.md)            | 模型、尺寸、父子关系和整体操作             |
| [编辑与保存](docs/07-editor-lifecycle.md)          | 导入、撤销、家具核算和保存流程             |
| [配色原理](docs/02-rendering-and-color.md)         | 材质、显示变换、透明叠层和选色             |
| [透明材料](docs/14-material-expansion.md)          | 候选材料、分区配色、试色与验证范围         |
| [光照与场景](docs/11-lighting-and-scene.md)        | 天气、时辰、光源、反射和后处理             |
| [蓝图格式](docs/03-blueprint-format.md)            | V7文件、节点树和摘要                       |
| [字段字典](docs/13-blueprint-field-reference.md)   | 全局块、全部节点、参数偏移与未确认语义     |
| [资源资料](docs/04-client-resources.md)            | 资源链、挂点与资料生成                     |
| [导出流程](docs/05-export-pipeline.md)             | 采样、预算、普通与微缩布局                 |
| [验证方法](docs/06-verification.md)                | 自动检查、复现和游戏内验收                 |
| [开发指南](docs/08-developer-guide.md)             | 扩展核心、资料与输出能力                   |
| [技术架构](docs/09-technology-and-architecture.md) | 技术版本、模块和调用关系                   |
| [家园限制](docs/10-game-limits.md)                 | 库存、容量、缩放、保存与工具边界           |

网页左上角“技术与开发”提供内嵌文档，打开页面时默认显示；关闭后即可制作。

## 使用边界

- 图像配色使用固定中性显示基准；家具预览使用内嵌材质与中性照明。游戏画质、天气、时辰和观察角度可能影响显示结果。
- 图片拼布和不含地下室的家具布置导出局部组件；含地下室的布置导出整屋蓝图。库存、剩余容量和保存权限由游戏检查。
- 文件校验、几何回读和游戏内导入是不同的验证阶段。实景摆放、保存和重载未纳入自动验收。
- 编解码核心支持拼布、绑定家具及地下室地板挂接所需的节点；只读检查器覆盖更多结构。任意场景的通用编辑与写回不在支持范围内。
- 技术文档对未确认的字段语义明确标注，不用推测补齐协议。

## 许可

项目代码采用 [MIT-0](LICENSE)：可以自由使用、修改、集成、分发和商用，无需署名、保留本项目许可声明或申请授权。第三方依赖分别遵循其许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## GitHub Pages

部署操作见[GitHub Pages 部署指南](DEPLOYMENT.md)。

优先使用 `gamehomeland.github.io` 仓库，网页地址为 `https://gamehomeland.github.io/`。**首次提交前填写实际账号并运行：**

```sh
node scripts/configure-site.mjs --owner gamehomeland
node scripts/configure-site.mjs --check
```

当前部署账号为 `gamehomeland`；迁移到其他账号时请更新该参数。命令同步更新本页顶部的在线演示、源码仓库链接和 `site.config.json`；重新构建后，网页右上角“开源仓库”使用同一地址。尚未设置地址时保留入口，本地功能仍可使用。

`.github/workflows/pages.yml` 在推送到 `main` 或手动触发时检查发布地址、资料、类型和测试，再构建并发布 `apps/web/dist`。仓库的 Settings → Pages → Source 选择 **GitHub Actions**。发布检查会拒绝缺失地址、README 链接不一致或与当前仓库不符的配置。

谢绝 txjydps.online/pindou2jx3/ 的作者及相关开发团队浏览本网站，以及使用、复制、修改或再发布本项目源码与衍生版本。其他开发者可自由使用、修改和二次开发。实现思路公开分享，不必把一项功能当作独家珍宝。会做的人，不止你们。

# 开发者指南

技术选型、依赖版本和分层关系见 [技术栈与架构](09-technology-and-architecture.md)。工程约定见 [贡献指南](../CONTRIBUTING.md)。

## 核心接口与依赖边界

`packages/core` 提供图片转换、场景编辑校验和蓝图编解码。图片接口接收宽、高及RGBA字节；场景接口接收家具、地下室和地块数据。核心不读取DOM、文件路径、账号或网络，应用层负责输入解码与保存结果。

```ts
import { exportImage, createPackage } from '@jx3-homeland/blueprint-core';

const result = exportImage(
  { width, height, rgba },
  { orientation: 'wall', longEdgeM: 8, maxFurniture: 10000 },
  (progress) => console.log(progress.stage, progress.fraction),
);
const files = createPackage(result);
// result.blueprint: Uint8Array，真实蓝图。
// result.preview: 从实际蓝图回读的 RGBA 网格。
// result.materials: 家具编号、名称、数量。
// files.zip: 完整包；files.png: 可直接保存的效果预览。
```

先运行 `pnpm build:core` 生成 `dist`；在同一 workspace 内声明对该包的依赖即可导入。也可以直接从源文件入口构建自己的应用。

完整可运行示例见 [examples/export-blueprint.ts](../examples/export-blueprint.ts)。在根目录执行 `pnpm example:core`，即可在 `artifacts/core-example/` 得到蓝图、预览、清单、说明和 ZIP。

## 模块职责

| 模块                                             | 负责                                   | 修改后的关键检查                         |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------------- |
| `image.ts`                                       | 输入约束、画像分类、画布留白和网格预算 | 长图、透明图、1 米与大尺寸               |
| `math.ts`                                        | 颜色空间、感知色差、四元数与取整       | 色差标准样例、旋转次序                   |
| `color.ts`                                       | 配方匹配、质量评分和邻域优化           | 黑白轮廓、灰色保护、渐变与照片           |
| `layout.ts`                                      | 普通合并、微缩、几何回读与可见性       | 墙面/地面、奇偶网格、多层遮挡            |
| `component.ts`                                   | 基座树、挂接和导入朝向                 | 分组边界、父子偏移、整体移动             |
| `codec.ts`                                       | V7 编解码和完整性校验                  | 字节约定、损坏/未知格式拒绝              |
| `engine.ts`                                      | 候选选择、实际文件校验和最终材料统计   | 超预算、输出与预览的一致性               |
| `bundle.ts`、`png.ts`                            | 图片完整包与预览文件                   | ZIP内容、PNG解码一致性                   |
| `editor.ts`                                      | 家具与地下室场景、工程、蓝图及完整包   | 世界/局部变换、挂接与清单                |
| `blueprint-merge.ts`                             | 既有整屋的结构检查与追加合并           | 未受影响块保留、实例编号、范围与冲突检查 |
| `blueprint-structure.ts`                         | 原整屋结构遍历与只读预览数据           | 可变块长度、节点布局、资源缩放维数       |
| `blueprint-connect.ts`、`blueprint-transform.ts` | 原房间连通、挂面匹配和坐标转换         | 原家具世界矩阵、内部挂接、非变换字段保留 |
| `land.ts`、`basement.ts`                         | 地块范围、组件网格、连通与地板定义     | 水平边界、回填、形态与挂面               |

## 应用层的任务生命周期

整屋扩建先调用 `exportSceneBlueprint(document, { forMerge: true })` 生成新增片段，再用 `mergeWholeBlueprintDetailed(base, addition)` 得到最终蓝图与连通报告。依赖原房间接通地表的片段不能单独导入游戏。`readWholeBlueprintPreview(result.blueprint)` 读取合并结果，供原房间与原家具的只读预览使用。详细流程见[场景编辑器](20-scene-editor.md)。

网页给每次设置变化一个递增版本号。旧任务即使晚返回，也不能写入当前页面。Worker 只接收图像像素和导出参数；取消直接终止 Worker，不让重型计算阻塞主页面。

结果链接使用 Blob URL。更换输入、重新生成或页面离开时回收旧 URL，避免长期使用占用内存。下载文件名会移除路径分隔符和控制字符。

桌面程序不向页面开放 Node.js，不提供任意 IPC 或文件读写接口。它使用 `homeland://app/` 只读协议加载构建产物；图片通过用户文件选择读取，结果通过下载保存。协议拒绝跨目录路径、软链接逃逸及不支持的文件类型。

## 资料生成

游戏资源在工程中以数值索引与哈希记录。生成步骤需要本机安装的客户端和 Windows C++ 编译环境：

```powershell
cl /std:c++17 /EHsc /utf-8 tools/read_client_assets.cpp /Fe:read_client_assets.exe
python -m pip install -r tools/requirements.txt
python tools/extract_client_palette.py --game-root "D:/Games/JX3" --reader ./read_client_assets.exe --output ./client-extract
$clientDataVersion = ((Select-String '^Sword3\.version=' ./client-extract/assets/client/version.cfg).Line -split '=', 2)[1].Trim()
python tools/build_client_palette.py --assets ./client-extract/assets --client-version $clientDataVersion --output ./catalog-candidate
```

实际版本以客户端为准。先对比 `catalog-candidate` 的四份数据，确认变化，再整体更新 `data`，执行 `pnpm check`。`--verify` 可核对生成结果与给定输出是否逐字节一致。

游戏资料中的颜色或规格发生变化时，生成器的72色/144规格检查会失败。应先核实分类和资源，再调整相应断言与回归样例；不要绕过校验把缺项输出当完整更新。

## 功能扩展要求

新增导出参数应优先留在应用层简化选择，由核心校验具体数值。新增家具类型需要完整补齐：家具编号、模型编号、合法缩放、挂点、材质规则、清单核算、几何检查和游戏内验收。名称和图标仅用于展示，导出支持以完整资源映射和验证结果为准。

新增蓝图节点类型应先从客户端加载/保存代码核对字段、可变长度和子节点顺序，再增加 round-trip 与拒绝畸形输入测试。未知节点必须停止解析。文件未提供通用节点长度，跳过未知结构可能造成后续字段错位。

## 平台范围

网页使用标准 File、Canvas、Blob 和 Web Worker。Windows、macOS、Linux的x64与ARM64使用各自原生构建环境，打包后运行9组导出自检；开发者证书签名与macOS公证需另行配置。流程与下载方式见[桌面构建与发布](17-desktop-releases.md)。

计算运行在CPU Worker。引入GPU实现时，必须保持文件结果可回读、能力探测和 CPU 路径；GPU实现须保持颜色与几何语义，并以实际导出文件验证显示结果。

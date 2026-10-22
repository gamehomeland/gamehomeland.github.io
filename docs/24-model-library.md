# 内置模型库、网页压缩与新增家具

## 提供内容

项目提供 38 份家具 GLB，其中 36 件已建立布置导出绑定；另有 6 份地下室模型包，共 144 个连通形态。模型与内嵌贴图放在同一仓库、同一源码 ZIP 中。它们用于基础功能展示，不覆盖游戏全部家具、材质和家园功能。

```text
assets/models/
├─ furniture/
│  ├─ manifest.json          名称、分类、资源编号、文件名、SHA-256
│  └─ *.glb                  家具几何、内嵌贴图和材质样式
└─ basement/
   └─ basement-编号.glb     每个包包含同材质的 24 个形态

data/editor_catalog.json    家具的游戏资源、变换限制和模型绑定
data/basement_models.json   地下室编号、形态、挂面、地板和模型绑定
```

GLB 中已包含纹理，不需要再下载独立图片包。蓝图文件只记录游戏资源编号、样式和变换，不把 GLB 或纹理写进游戏。模型显示和游戏蓝图身份分别维护。

## 构建与加载过程

1. `pnpm catalog` 校验资料、GLB、内嵌贴图、文件 SHA-256 与资源绑定。`pnpm check:models` 可单独检查模型库。
2. Vite 的 `publicDir` 指向 `assets/`，将模型复制到 `apps/web/dist/models/`。Pages 发布整个 `dist`，桌面打包也复制同一目录。
3. 页面进入“3D 家园布置”时读取家具清单；选择家具后才请求对应 GLB。地下室只加载已使用的材质包。
4. 请求路径相对页面目录解析，支持账号主页、项目子路径和 `homeland://app/` 桌面协议。文件 URL 附带 SHA-256，资源更新后使用新的缓存地址。
5. GLTFLoader 读取几何、贴图和材质样式，资源编号与哈希决定是否允许加入布置。未经绑定的模型只能单件预览。

模型不会在首页一次性全部下载。重复家具复用场景内的几何与材质，地下室同材质的多个单元共享模型包。贴图仍需要解码与显存，文件压缩率不等于显存压缩率。

桌面协议仅开放应用内的只读资源目录，不开放任意本机路径。单文件离线 HTML 不内嵌整套模型，可手动选择随源码提供的 GLB；完整离线模型库随桌面程序提供。

## 网页压缩策略

随附 44 份模型从约 248.6 MiB 压缩至 52.4 MiB，减少约 78.9%；最大单文件约 4.3 MiB。原最大模型从约 21.2 MiB 压缩至 3.4 MiB。逐文件几何一致性、纹理尺寸、编码与哈希记录见 `model-library-optimization.json`。

`tools/optimize_glb.py` 只处理内嵌贴图与缓冲区打包：

- 网页预设将贴图长边限制为 512 像素，保持比例。
- 底色与自发光贴图比较 WebP 无损和质量 90 编码，只有后者显著更小时采用有损编码。
- 法线、粗糙度、金属等数据贴图使用 WebP 无损编码；同一图片兼用于颜色和数据时也采用无损编码。
- 透明通道在缩放后逐像素核对，编码过程不得改变透明值。小图转换后反而更大时保留原编码。
- 保留几何缓冲区、顶点、索引、UV、切线、节点、材质参数和样式映射，逐项比较后才输出。

512 像素预设会减少远高于展示需求的纹理细节，不属于全流程无损。报告记录原尺寸、目标尺寸、编码方式、颜色误差与前后哈希。需要更高精度时，从原始转换结果生成 1024 像素版本；不要反复压缩已有的有损结果。

WebP 使用 `EXT_texture_webp`，无需外部解码服务。资源不附加重复的 PNG 回退，因此声明该扩展为必需；浏览器与桌面加载器均支持此扩展。[Khronos 扩展规范](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Vendor/EXT_texture_webp)

## 新增一件家具

### 1. 确认资源身份

在 `docs/furniture-index.json` 中确认家具类型、家具 ID、表现资源 ID、Mesh 路径、默认 Detail、可用样式与缩放范围。三种编号不可互换。只截取 Prefab 内部网格不足以恢复完整家具；未完成装配的资源应仅作为预览项。

所需原始资源包括 Mesh、相应 jsonAP、材质包 jsoninspack、jsondef、着色器和 DDS/HDD 纹理。资源读取、材质路径与转换规则见[模型转换](19-model-to-glb.md)和[贴图材质](21-furniture-materials.md)。新增型号不在索引中时，先更新家具索引与蓝图资源缩放目录。

### 2. 转换带贴图的 GLB

先创建独立的 `model-work` 目录，将下列路径替换为实际资源路径：

```sh
python -m pip install -r tools/requirements.txt
python tools/export_textured_glb.py --mesh ./client-extract/家具.Mesh --material-pack data/source/实际路径/家具.jsoninspack --assets ./client-extract --glb ./model-work/original.glb --report ./model-work/materials.json --max-texture 1024
python tools/optimize_glb.py --input ./model-work/original.glb --output ./model-work/furniture-12345.glb --report ./model-work/compression.json --max-texture 512 --quality 90
```

`12345` 仅为文件命名示例，应换为真实表现资源 ID。`--detail` 可为材质转换器指定默认样式；默认值及可用样式必须与资源目录一致。保留原转换结果用于质量对照，提交供网页使用的压缩结果。

### 3. 加入清单

在压缩 GLB 的同一目录创建 `manifest.json`。将示例编号和名称替换为真实数据：

```json
[
  {
    "file": "furniture-12345.glb",
    "name": "家具名称",
    "category": "桌椅",
    "resourceId": 12345,
    "note": "内嵌贴图与材质样式，采用网页中性照明。"
  }
]
```

执行：

```sh
node scripts/prepare-furniture.mjs ./model-work/manifest.json
python tools/build_editor_catalog.py --index docs/furniture-index.json --manifest assets/models/furniture/manifest.json --previous data/editor_catalog.json --output data/editor_catalog.json
pnpm check:models
pnpm check
```

准备脚本按文件名新增或更新，不清空现有模型库，并计算 SHA-256。更新同一资源应沿用原文件名，避免重复资源编号。仅用于预览的条目省略 `resourceId`；不要填写猜测的编号。

生成编辑目录时必须传入**合并后的完整清单**，不能只用新加入的一项。`--previous` 在源 Mesh 不变时保留旧模型哈希别名，使原 GLB 仍可识别。修改显示模型不得改变已有工程的家具资源或变换规则。

### 4. 核对与提交范围

核对模型颜色、透明处、不同 Detail、多个方向和实际尺寸；测试加入布置、移动、缩放、撤销、工程保存、蓝图导出与回读。最后在游戏中导入、保存、重新进入核对。

提交对应 GLB、完整 `manifest.json` 和 `editor_catalog.json`。若新增资源类型或格式规则，还需提交资料、代码及相关测试。原始提取目录、转换临时文件和玩家蓝图不加入项目。

## 地下室资源更新

地下室 GLB 不能按普通家具处理：每包包含 24 个形态，节点的 `basementVariant` 与数值目录一一对应。挂面索引、连通掩码和地板变换来自模型定义。

```sh
python tools/build_basement_models.py --assets ./client-extract --reference docs/basement-reference.json --output ./model-work/basement --catalog ./model-work/basement_models.json --report ./model-work/basement-report.json
```

随后使用批量压缩工具，将候选家具库、地下室模型及目录一起处理：

```sh
python tools/optimize_model_library.py --models ./model-work/models --editor data/editor_catalog.json --basement ./model-work/basement_models.json --output ./model-candidate --max-texture 512 --quality 90
```

`--models` 下必须同时存在 `furniture/manifest.json`、家具 GLB 和 `basement/` 六份模型。可复制当前 `assets/models` 作为候选，再替换新生成的地下室。输出包括 `models/`、两个更新后的绑定目录及压缩报告。核对后，将模型目录和对应数值目录一起更新，运行 `pnpm check:models` 与 `pnpm check`。

保留旧模型的 SHA-256 别名，仅用于兼容已经核对的同源版本；不要把任意哈希加入白名单。地下室更新还需覆盖挖掘、回填、横向及上下连通、地下家具挂接、原整屋合并和实际游戏导入。

## 维护边界

工具可扩展的范围包括更多家具、完整预制体、动画、天气和场景光照。目录中存在资源不等于已完成其显示与导出；每项新增能力均应记录验证范围。代码许可与游戏美术资源的权属分别见项目许可证和第三方说明。

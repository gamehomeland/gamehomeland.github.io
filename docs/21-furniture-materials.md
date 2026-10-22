# 家具贴图、材质与样式

家具显示颜色依据材质定义、纹理和场景照明计算。蓝图只保存资源ID、Detail样式和摆放数据；GLB负责网页显示，两者分别校验。

## 资源链

```text
家具 type / furnitureId → 表现资源ID → Mesh
                                   └→ 同名 jsoninspack
                                        └→ LOD[0].Group[Detail].Subset[材质槽]
                                             ├→ Info.RefPath 指向 jsondef
                                             ├→ Param 覆盖默认参数
                                             └→ RenderState 覆盖默认绘制状态
```

`jsondef`给出着色器及默认参数。同名参数按材质实例优先合并，不能只读取实例里出现的项。Group是样式方案，Subset是同一模型的材质分区，两者不能互换。

本项目的材质转换器接受已核对的六类着色器。工具保存其SHA256，内容变化时停止转换，要求重新核对公式；不能按相同文件名套用旧公式。

## DDS与HDD高清纹理层

材质参数常使用`.tga`逻辑名，已核对的本机资源实际存储为同路径`.dds`和连续的`.hdd1`～`.hdd9`分层。处理规则来自纹理加载路径中的`GetTextureHddFileName`、`_GetHddInfo_NoUpdateFileState`和`_MergeHddTextures`：第0层是原文件，后续层替换扩展名；遇到第一个缺失层即结束。

基础DDS可能只有32或64像素。仅使用基础层会限制贴图分辨率。工具选取连续链中的最高可用层，再按网页预算缩小，默认长边1024像素，参数允许64～2048。每份转换报告记录实际使用文件、原尺寸、输出尺寸、字节数和SHA256。

普通DDS由Pillow读取；`Hx`标记的CRN采用`texture2ddecoder`解包，当前限定单面、BC1/BC3。解码器返回BGRA字节，需要转换为RGBA。纹理尺寸、文件大小和路径都受边界检查；未知压缩格式停止转换，并报告对应资源。

## 材质分区与UV

在已支持HSEM布局中，`u32 @ 0x98`为材质槽数，`u32 @ 0xb8`指向每三角形一个`uint16`材质槽索引。37份核对样本中，每个Group的Subset数量均与槽数相同，逐三角形索引都在范围内。工具同时检查该流与顶点/法线/UVW/三角索引流不重叠。

位置除以100换算米，轴顺序保留。已核对资源使用顺时针正面，GLTF要求逆时针正面；工具通过面积加权的几何面与资源法线点积确认约定，统一交换每个三角形的后两个索引。极薄倒角可能使用平滑法线，不按单个面的法线任意翻转拓扑。UVW前两列写入`TEXCOORD_0`。按材质槽拆成多个primitive，保留原始几何拓扑。切线由编码后的float32位置、法线、UV及三角索引计算；退化UV使用与法线正交的有限回退向量。

## 从着色器映射到网页PBR

| 数据     | 转换方法                                                                      |
| -------- | ----------------------------------------------------------------------------- |
| 基础色   | 按已核对着色器的`pow(abs(sample), 2.2)`还原运算空间；输出PNG前编码为标准sRGB  |
| Alpha    | 保留材质的透明与裁切规则；不对透明度套sRGB输出编码                            |
| MRE      | 按着色器读取R/G作金属、粗糙及分区调整；B/A在不同着色器中用于自发光或染色遮罩  |
| 法线     | RG映射到[-1,1]，重建正Z；作为线性数据纹理写入                                 |
| 单层染色 | 按亮度、饱和度、对比度与颜色参数运算，再用MRE.A混合                           |
| 双层染色 | 用MRE.B/A分别控制两区；颜色和粗糙度分区计算                                   |
| 高度渐变 | 将局部Y按真实三角形栅格化到UV；重叠UV的高度冲突在报告中明确列出               |
| 自发光   | 输出静态发光纹理；超出1的强度使用`KHR_materials_emissive_strength`            |
| 透明状态 | Blend 0为OPAQUE、1为MASK并使用AlphaRef、12为BLEND；其他已核对模式明确报告近似 |

颜色贴图和自发光贴图按sRGB解码，法线、金属和粗糙度按线性数据读取。把所有贴图都当颜色或都当线性数据，会造成发灰、偏暗或反光不正确。

水面依赖场景深度、时间、折射和反射；GLB仅使用其静态颜色与粗糙度近似。视角相关边缘发光、部分混合模式、特效单层材质和UV渐变冲突都写入报告的`approximation`，不把这些结果描述成完整游戏渲染。

## GLB与网页显示

材质转换阶段将 PNG 内嵌在 GLB 的 BIN 中，单文件内相同 PNG 按哈希去重；网页资源再经贴图压缩，支持内嵌 WebP，几何和材质参数保持不变。每个材质槽对应一个primitive，所有Group保留为可选扩展`KHR_materials_variants`，样式名称保留在扩展中。没有把这些扩展声明为必需解码器。

`model-assets.ts`按需载入所选材质。同一家具的不同实例可以使用不同Detail；异步切换只应用最后一次请求。旧灰模文件的哈希作为资源别名保留，在同源Mesh绑定下可继续打开已有工程。加载高清材质版后不会被旧灰模覆盖。更换显示模型不会改写资源ID、位置、四元数、缩放或导出字节。

网页用中性棚光环境、方向光、半球光、ACES色调映射和sRGB输出。地面网格只作定位。当前显示不包含游戏天气、环境探针、灯光布局、阴影和后处理的完整重放。

## 复现转换

Python工具只在准备模型时使用，网页和桌面运行无需Python。

```sh
python -m pip install numpy Pillow texture2ddecoder
python tools/export_textured_glb.py --mesh ./input/chair.Mesh --material-pack data/source/path/chair.jsoninspack --assets ./extracted --glb ./output/chair.glb --report ./output/chair-materials.json --max-texture 1024
```

输出目录与输入资源目录分开。`--detail`选择默认样式，默认为0；样式编号必须存在。转换报告包含源几何哈希、所用材质和纹理、样式名、近似项及GLB哈希。

将GLB与清单放在同一目录，再用`node scripts/prepare-furniture.mjs 清单.json`加入或更新内置模型库。更新可编辑目录时使用：

```sh
python tools/build_editor_catalog.py --index docs/furniture-index.json --manifest assets/models/furniture/manifest.json --previous data/editor_catalog.json --output data/editor_catalog.json
pnpm catalog
```

样本清单中的`resourceId`必须能唯一关联到普通Mesh家具；未知Prefab只可查看，不猜测导出身份。`--previous`只在源Mesh哈希一致时保留旧GLB别名。

## 验证范围

材质转换基准中的 38 份家具 GLB 和 6 份地下室模型包经过 Khronos Validator 检查，错误和警告均为 0；报告核对内嵌 PNG、纹理尺寸、材质样式、源几何一致性及无外部 URI。随附网页压缩版另行核对几何缓冲区、节点与材质参数不变，并在网页和 Electron 中实际加载内嵌 WebP。压缩前后哈希与像素检查见 `model-library-optimization.json`。网页回归涵盖单件查看、染色切换、多个同资源实例和旧工程加载。

这些检查证明文件格式与本工具的显示、导出链路。完整Prefab装配、骨骼动画、未覆盖的压缩布局、动态水面、真实场景照明以及更多家具的游戏导入与保存，仍需各自的样本与实测。

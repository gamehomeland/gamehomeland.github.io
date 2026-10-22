# 第三方依赖与资料

## 软件依赖

| 依赖                                         | 用途                                   | 许可                              |
| -------------------------------------------- | -------------------------------------- | --------------------------------- |
| fflate                                       | ZIP、PNG 数据压缩                      | MIT                               |
| spark-md5                                    | 蓝图完整性校验计算                     | MIT                               |
| Three.js、OrbitControls                      | 蓝图组件的 3D 预览与相机操作           | MIT                               |
| Electron                                     | Windows/macOS/Linux桌面运行环境        | MIT；随包保留 Chromium 等依赖许可 |
| Vite、TypeScript、tsx、Prettier、markdown-it | 构建、类型检查、测试、格式化和文档生成 | 以各依赖包的许可证为准            |
| NumPy、Pillow、texture2ddecoder              | 开发者离线整理客户端资料               | 以各依赖包及底层组件许可证为准    |

依赖通过包管理器安装，锁定版本见 `pnpm-lock.yaml`。桌面发行目录中的 `LICENSE`、`LICENSES.chromium.html` 和其他运行时许可文件应随程序保留。

## 客户端资料

游戏名称、家具名称、资源格式及相关游戏内容的权利属于相应权利人。工程内的数值索引用于蓝图互操作；项目代码的 MIT-0 许可不对游戏资源另行授权。工程随附经过转换与网页压缩的部分家具、地下室 GLB 及内嵌贴图，存放于 `assets/models/`。游戏美术资源的权属不因格式转换而改变。

资源读取器的导出接口调用说明参考 [PakV4-Extract](https://github.com/jx3pak/PakV4-Extract)。读取器代码位于 `tools/read_client_assets.cpp`；客户端版本、输入哈希和生成规则位于 `data` 与 `docs`。

`examples/` 中的图片用于演示，代码的 MIT-0 许可不对示例图片另行授予许可。`pnpm samples` 的几何测试图由本工程代码生成。

## Three.js 许可原文

The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

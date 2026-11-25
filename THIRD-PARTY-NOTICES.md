# 第三方组件声明

下列组件保留各自的版权和上游许可。部署产物、离线分发包及独立安装脚本应随附适用的声明和许可文本。

| 组件 | 仓库中的分发位置 | 许可与核验 |
| --- | --- | --- |
| [jsQR 1.4.0](https://registry.npmjs.org/jsqr/-/jsqr-1.4.0.tgz) | 二维码解码器 | Apache-2.0。分发文件与 npm 包一致，包内随附 [许可](qr-code-tool/vendor/LICENSE-jsQR.txt)。 |
| [qrcode-generator 1.4.4](https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-1.4.4.tgz) | 二维码生成器 | MIT。保留上游版权及 [许可](qr-code-tool/vendor/LICENSE-qrcode-generator.txt)。AIOZ 版修改了 Canvas 绘制的行列坐标顺序。 |
| [ExcelJS 4.3.0](https://registry.npmjs.org/exceljs/-/exceljs-4.3.0.tgz) | 工作簿批量合并及图片转换 | 使用与上游 npm 包一致的浏览器 bundle。ExcelJS 本体采用 MIT，随附 [上游许可](xlsx-workbook-merger/vendor/LICENSE.exceljs.txt)。[传递依赖声明](xlsx-workbook-merger/vendor/THIRD-PARTY-EXCELJS.txt)覆盖上游源码映射中的 73 个包名和多份依赖副本。文件列出上游许可来源及版本核验边界。 |
| fflate 0.8.3、@xmldom/xmldom 0.9.12、Acorn 8.18.0、parse5 8.0.1、entities 8.1.0 | 工作簿脱敏工具的 UI 与 Worker | 前四项为 MIT，entities 为 BSD-2-Clause。随构建生成 [完整许可文本](xlsx-desensitizer/dist/THIRD-PARTY-LICENSES.txt)，依赖版本见锁文件。 |
| fflate 0.8.3 | Amazon 类目洞察数据采集器 | MIT，随附 [版权与许可](tampermonkey-scripts/amazon-category-insights-json-capture/LICENSE-fflate.txt)。 |
| [SheetJS CE 0.20.3](https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz) | Amazon 类目节点映射采集器 | Apache-2.0。内嵌的完整 bundle 与上游发布包一致，随附 [分发许可](tampermonkey-scripts/amazon-category-node-mapper/LICENSE-SheetJS.txt)。 |

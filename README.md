# tools.aioz.cc

团队内部工具集合，部署于 Cloudflare Pages，访问地址：<https://tools.aioz.cc>

## 目录结构

| 路径 | 说明 |
|---|---|
| `index.html` | 总导航页，列出所有工具 |
| `xlsx-desensitizer/` | 工作簿脱敏、工作簿恢复、HTML 报告解密（全程浏览器内存处理） |
| `xlsx-workbook-merger/` | XLSX 工作簿批量合并工具（按表头对齐、纯前端本地处理） |
| `xlsx-image-link-to-image-tool/` | XLSX 图片链接转图片工具（纯前端，本地处理） |
| `tampermonkey-scripts/` | 篡改猴（Tampermonkey）用户脚本合集及其导航页 |
| `scripts/build-manifest.mjs` | 构建脚本：扫描 `*.user.js` 元数据生成 `manifest.json` |

## 添加 / 更新篡改猴脚本

1. 在 `tampermonkey-scripts/<脚本英文名>/` 下放置 `<脚本英文名>.user.js`（**文件名固定，不带版本号**）。
2. 脚本头部必须包含 `@name`、`@version`、`@description`，以及指向自身固定 URL 的 `@updateURL` 和 `@downloadURL`：
   ```
   // @updateURL    https://tools.aioz.cc/tampermonkey-scripts/<脚本英文名>/<脚本英文名>.user.js
   // @downloadURL  https://tools.aioz.cc/tampermonkey-scripts/<脚本英文名>/<脚本英文名>.user.js
   ```
3. 每次修改脚本内容时**必须递增 `@version`**（如 `1.2.0` → `1.2.1`），否则已安装用户不会收到更新。
4. 提交并 push 到 `main`，Cloudflare Pages 会自动构建部署；导航页清单（`manifest.json`）在构建时自动重新生成，无需手工维护。

已安装脚本的用户由篡改猴自动检查更新（默认每天一次），检测到新版本后按各自设置自动更新或弹出确认。

脚本卡片的更新日期取自该 `.user.js` 文件最后一次 Git 提交的日期，沿用提交中的时区；不使用部署时间或文件检出时间。构建器遇到浅克隆会先从 `origin` 补齐历史，补齐失败则停止构建，避免把所有脚本误标为最近部署日。无 Git 历史的源码副本或尚未提交的新脚本显示“更新日期未知”。GitHub Actions 使用完整历史检出；Cloudflare Pages 继续使用原构建命令即可。

## 本地预览

```bash
npm ci                 # Node.js 22+，使用锁定依赖
npm run typecheck
npm run build          # 生成清单和脱敏工具浏览器包
npm test               # 既有合并工具测试 + 脱敏/恢复边界测试
npm run dev            # http://127.0.0.1:4175/xlsx-desensitizer/
```

## 工作簿脱敏与恢复

入口：`/xlsx-desensitizer/`。三个功能共用同一种带版本、批次与 SHA-256 完整性检查的 XLSX 字典。

- **数据脱敏**：默认处理第 1 个工作表，表头在第 1 行，实际扫描所有已存储单元格，不仅依赖前 5 行和抽样。展示列类型、示例、空白数量和可调整策略。输出 ZIP，仅含一个脱敏工作簿（仅含第 1 个工作表）和一个字典工作簿。
- **工作簿恢复**：以完整编码匹配原值，支持排序或筛选后的数据子集；恢复名称、原工作表名。按用户确认，舍入后的数值、转换后的真实日期与已清理的真空白不回退。输出一个 XLSX。
- **报告解密**：接受 UTF-8 HTML 和对应字典，恢复正文、普通属性、内嵌 JSON、JavaScript 字符串中的编码。按语法上下文转义，不执行报告。JSON 只替换字符串片段，保留原数值文本与其精度。输出一个 HTML。

文件名：`原输入文件名_已脱密_YYYYMMDD-HHmmss-SSS.zip/.xlsx`、`原输入文件名_脱密字典_时间戳.xlsx`、`当前输入文件名_已解密_时间戳.xlsx/.html`。恢复使用当前传入文件的名称，所以原有后缀也会保留。

规则：

1. `销售员`、所有以 `销售员` 开头的字段、`IPD`、`GTM` 共用人名映射；编码为简短直观的 `人1`、`人2`…，跨列共享映射；按完整原文匹配，不擅自删除姓名内外空格或拆分多人字符串。
2. `店铺` 按完整原值去重，编码格式为「列号 + 递增序号 + 原末尾 3 个字符」（例如 `B1-US`、`B2_DE`、`B3旗舰店`）；不足 3 个保留全部。相同后缀的不同店铺序号不同，绝不混淆。
3. 其他列脱敏取对应的「列字母 + 递增序号」（例如 A 列第 1 个不同值为 `A1`、第 2 个为 `A2`；C 列为 `C1`、`C2`…）。不同列之间列字母不同，编码绝不重复。若原表格中已存在该字符串，则自动递增序号跳过，确保绝不与原表已有字符冲突。
4. 默认只处理工作簿的第 1 个工作表，输出的脱敏后工作簿也仅保留这 1 个工作表，工作表名脱敏为 `工作表1`（解密时自动恢复为原表名）。
5. 数值不脱敏；按底层值四舍五入到 2 位，半值远离零（`1.005 → 1.01`、`-1.005 → -1.01`），比例 `0.1372 → 0.14`。数值字符串只在确定为数值列时转换；前导零、长数字文本和标识字段按文本处理。原始数字已丢失的前导零无法推断补回。
6. 日期列不脱敏；明确且合法的年/月/日或 ISO 风格文本日期转为 Excel 数值日期，支持 1900/1904 日期系统。`03/04/2024`、无效日期、含时区日期等保留并提示。纯空字符串、空格、NBSP、零宽空白清为真空白；`0`、`false`、`NULL`、`N/A` 不当作空白。
7. 共享字符串全部展开到单元格后清除缓存，删除作者/人员/自定义属性、页眉页脚、自定义名称等可能残留明文的位置；仅添加无敏感内容的批次标记。保持列宽、行高、冻结窗格、筛选和普通样式；富文本恢复为普通文本。**文件名、表头、数值和店铺后缀仍保留原意，分享前需检查。**

字典含 `字典信息`、`映射字典`、`工作表对应` 三张表。字典里是原始明文，应与脱敏文件分开保管，不能将整个 ZIP 对外发送。SHA-256 用来检查内容损坏/误改，不是对抗蓄意篡改的签名。报告使用的编码必须完整；字典不匹配、未知批次、冲突映射、已识别的残缺编码等会报错，不生成部分成功的结果。

兼容范围：单文件 50 MB，HTML 20 MB，XLSX 解压后 250 MB，最多 2,000,000 个已存储单元格。仅支持标准 `.xlsx` 数据表；公式、合并、超链接、数据验证、条件格式、保护、图表、透视缓存、嵌入对象等会明确拒绝，需先在 Excel 中导出值表。绘图、批注等非数据辅助部件将自动安全清理。HTML 图片文字、外部脚本数据、Base64/压缩数据、跨标签编码、CSS/URL 中的编码及带插值的模板文字不自动恢复。纯数值工作簿可通过批次标记恢复表名。

实现：TypeScript strict、fflate ZIP/CRC 校验、xmldom OOXML 定向修改、parse5/Acorn HTML 与脚本字符串解析。CPU 密集任务在 Web Worker 运行，可取消；文件只保存在会话内存，没有上传 API、远程依赖、遥测、localStorage 或 IndexedDB。页面及 Worker 的 CSP 设定 `connect-src 'none'`。页面加载后，三项功能可以断网运行；刷新页面仍需要静态资源。

验证命令（测试源、解密结果均不得提交到仓库）：

```bash
# 自带的 Node 单元/集成测试使用合成数据。
npm test
# 真实样本回归，默认读取仓库旁“自动脱敏工作簿”目录中的指定样本。
npm run test:sample
# 也可显式传入源文件和本地输出目录。
npm run test:sample -- "/path/to/input.xlsx" "/path/to/test-results"
# 浏览器实测：首次需要安装 Chromium；已有 Chrome 时可设置 AIOZ_BROWSER_CHANNEL=chrome。
npx playwright install chromium
npm run test:browser -- "/path/to/input.xlsx"
# 独立读回与数值核验：Python 3.11+，需要 openpyxl。
python3 scripts/verify-desensitizer-output.py "/path/to/test-results"
```

`test:browser` 验证三项真实下载、断网运行、无上传请求、控制台、390px 布局、清空、拖放和取消。浏览器证据默认存入已忽略的 `.test-output/`。`test:sample` 的源文件与输出位于仓库外，不修改原始样本。当前验收记录见 `xlsx-desensitizer/VALIDATION.md`。

## Cloudflare Pages 构建配置

- 构建命令：`node scripts/build-manifest.mjs`
- 构建输出目录：`/`（仓库根目录）

保持现有 Pages 构建配置可直接发布：`xlsx-desensitizer/dist/` 的浏览器包和组件许可已纳入 Git，开发修改后必须先 `npm run build` 并提交生成包。无需生产服务器解析任何 XLSX/HTML。Pages 的 `node_modules` 排除行为参见 [官方上传实现](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/pages/validate.ts)；隐私响应头由根目录 `_headers` 仅作用于新工具路由，参见 [Cloudflare Pages headers 文档](https://developers.cloudflare.com/pages/configuration/headers/)。

# tools.aioz.cc

团队内部工具集合，部署于 Cloudflare Pages，访问地址：<https://tools.aioz.cc>

## 目录结构

| 路径 | 说明 |
|---|---|
| `index.html` | 总导航页，列出所有工具 |
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

## 本地预览

```bash
npm run build          # 生成 tampermonkey-scripts/manifest.json
npx serve .            # 或任意静态服务器
```

## Cloudflare Pages 构建配置

- 构建命令：`node scripts/build-manifest.mjs`
- 构建输出目录：`/`（仓库根目录）

# Amazon 类目节点映射采集器 · 1.2.1

在美国 Seller Central 的类目洞察页面采集商店、类别、商品类型、关键词与节点映射。

## 安装与升级

- 安装本目录的 `amazon-category-node-mapper.user.js`；升级可在原 Tampermonkey 编辑器中完整替换并保存。
- 显示名称已去掉版本后缀。检查只启用一份 Mapper，刷新 Amazon 页面。
- 保留原 namespace、IndexedDB 名称、偏好及任务锁标识，继续使用原浏览器、同一站点下的历史数据和检查点。
- 平台发布后的固定安装地址：`https://tools.aioz.cc/tampermonkey-scripts/amazon-category-node-mapper/amazon-category-node-mapper.user.js`。
- 后续更新由 Tampermonkey 按用户设置检查 `@updateURL` 并从 `@downloadURL` 下载。此文件的本地适配不代表地址已经发布或真实升级已验证。

## 使用

1. 打开 `https://sellercentral.amazon.com/selection/category-insights`，选择商店、类别、商品类型。
2. 默认仅循环商品类型；需要时勾选类别、商店循环。起点为当前项，后续父级从子目录首项开始。
3. 点击“新建任务”；页面加载时只监听，不自动发起遍历。默认随机间隔 5–25 秒，重试 3 次。
4. 每个商品类型完成后触发独立 XLSX 下载，主表严格八列：站点、站点代码、类别、类别代码、商品类型、类型代码、商品类型关键词、节点ID；标识均按文本输出。
5. 浏览器需允许多个文件下载。触发下载不等于文件已落盘；可使用历史重导补下载。
6. 中断后使用“继续未完成任务”，或导入检查点。连续两次 429 会终止并保留待续跑分支；401/403 不自动反复请求。

本次仅适配固定平台地址、稳定中文显示名称和 1.2.1 版本；采集、分批导出与存储行为沿用 1.2.0。

同页面可以安装两个脚本，但请勿同时启动两者的自动遍历。此版本仍只匹配 `.amazon.com` 美国站页面，不扩展其他站点。

SheetJS 0.20.3 已内置，许可证见 `LICENSE-SheetJS.txt`。

#!/usr/bin/env node
// 扫描 tampermonkey-scripts/*/ 下的 *.user.js，解析元数据头，
// 结合 git 最后提交日期生成 tampermonkey-scripts/manifest.json。
// 用法：node scripts/build-manifest.mjs（在仓库根目录执行，或由 Cloudflare Pages 构建命令执行）

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = join(root, 'tampermonkey-scripts');

function parseMeta(source) {
  const meta = {};
  const block = source.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
  if (!block) return meta;
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\/\/\s*@(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    const [, key, value] = m;
    if (meta[key]) {
      meta[key] = [].concat(meta[key], value);
    } else {
      meta[key] = value;
    }
  }
  return meta;
}

function lastUpdated(filePath) {
  try {
    const out = execSync(`git log -1 --format=%cs -- "${filePath}"`, {
      cwd: root, encoding: 'utf8',
    }).trim();
    if (out) return out;
  } catch { /* 非 git 环境（如 CI 浅克隆异常）时退回文件修改时间 */ }
  return new Date(statSync(filePath).mtime).toISOString().slice(0, 10);
}

const entries = [];
for (const dir of readdirSync(scriptsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const folder = join(scriptsDir, dir.name);
  const userJs = readdirSync(folder).find((f) => f.endsWith('.user.js'));
  if (!userJs) continue;
  const filePath = join(folder, userJs);
  const meta = parseMeta(readFileSync(filePath, 'utf8'));
  entries.push({
    id: dir.name,
    name: meta.name ?? dir.name,
    version: meta.version ?? '0.0.0',
    description: meta.description ?? '',
    updated: lastUpdated(filePath),
    file: `${dir.name}/${userJs}`,
    match: [].concat(meta.match ?? []),
  });
}

entries.sort((a, b) => a.id.localeCompare(b.id));
const manifest = { generatedAt: new Date().toISOString(), scripts: entries };
writeFileSync(join(scriptsDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json 已生成，共 ${entries.length} 个脚本`);

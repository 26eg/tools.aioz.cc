#!/usr/bin/env node
// 扫描 tampermonkey-scripts/*/ 下的 *.user.js，解析元数据头，
// 结合 git 最后提交日期生成 tampermonkey-scripts/manifest.json。
// 用法：node scripts/build-manifest.mjs（在仓库根目录执行，或由 Cloudflare Pages 构建命令执行）

import { readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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

function git(args, timeout = 30_000) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function prepareHistory() {
  let top;
  try {
    top = git(['rev-parse', '--show-toplevel']);
  } catch {
    console.warn('没有可用的 Git 历史：脚本更新日期将标记为未知，不使用检出时间。');
    return false;
  }
  if (realpathSync(top) !== realpathSync(root)) return false;
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
    console.log('检测到浅克隆，补齐历史后再计算各脚本的更新日期。');
    try {
      git(['fetch', '--unshallow', '--no-tags', 'origin'], 120_000);
    } catch {
      throw new Error('无法补齐 Git 历史，停止生成清单，避免发布错误的脚本更新日期。');
    }
    if (git(['rev-parse', '--is-shallow-repository']) !== 'false') {
      throw new Error('Git 历史仍不完整，停止生成清单。');
    }
  }
  return true;
}

function lastUpdated(filePath, hasHistory) {
  if (!hasHistory) return null;
  const date = git(['log', '-1', '--format=%cs', '--', relative(root, filePath)]);
  if (!date) return null; // New, uncommitted scripts have no publication date yet.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Git 返回了无效的脚本更新日期。');
  return date;
}

const hasHistory = prepareHistory();
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
    updated: lastUpdated(filePath, hasHistory),
    file: `${dir.name}/${userJs}`,
    match: [].concat(meta.match ?? []),
  });
}

entries.sort((a, b) => a.id.localeCompare(b.id));
const manifest = { generatedAt: new Date().toISOString(), scripts: entries };
writeFileSync(join(scriptsDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json 已生成，共 ${entries.length} 个脚本`);

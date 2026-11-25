import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scripts = {
  'amazon-signin-blocker': 'LICENSE',
  'gas-spring-scraper': 'LICENSE',
  'amazon-category-insights-json-capture': 'tampermonkey-scripts/amazon-category-insights-json-capture/LICENSE-fflate.txt',
  'amazon-category-node-mapper': 'tampermonkey-scripts/amazon-category-node-mapper/LICENSE-SheetJS.txt',
};

export function prepareLicenseAssets(root, revision) {
  const page = join(root, 'licenses.html');
  const sourceLink = /<a id="corresponding-source" href="[^"]+">查看[^<]+<\/a>/;
  const html = readFileSync(page, 'utf8');
  if (!sourceLink.test(html)) throw new Error('Missing corresponding source link.');
  if (revision) {
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Expected a full Git commit SHA for the deployed source.');
    writeFileSync(page, html.replace(sourceLink, `<a id="corresponding-source" href="https://github.com/26eg/tools.aioz.cc/tree/${revision}">查看此部署版本的对应源码</a>`));
  }

  for (const [id, licensePath] of Object.entries(scripts)) {
    const target = join(root, 'tampermonkey-scripts', id, `${id}.user.js`);
    const source = readFileSync(target, 'utf8');
    const license = readFileSync(join(root, licensePath), 'utf8');
    if (license.includes('*/')) throw new Error(`Cannot embed the license for ${id} as a JavaScript comment.`);
    const marker = '\n/* AIOZ_DISTRIBUTION_LICENSE\n';
    const content = source.split(marker)[0];
    writeFileSync(target, `${content.trimEnd()}${marker}${license.trimEnd()}\n*/\n`);
  }
}

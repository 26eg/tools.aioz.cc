import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.AIOZ_PREVIEW_URL ?? 'http://127.0.0.1:4175';
const output = process.env.AIOZ_BROWSER_OUTPUT ?? '.test-output/pages-preview';
const routes = [
  '/', '/tampermonkey-scripts/', '/qr-code-tool/', '/xlsx-image-link-to-image-tool/',
  '/xlsx-workbook-merger/', '/xlsx-desensitizer/',
];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.AIOZ_BROWSER_CHANNEL ?? 'chrome' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      assert.equal((await page.goto(base + route)).status(), 200, route);
      assert.equal(await page.locator('.aioz-footer p').count(), 3, route);
      assert.equal(await page.locator('.aioz-footer p').last().textContent(), 'Designed by 26eg · AI-assisted development');
      assert.equal(await page.getByRole('link', { name: 'GitHub 仓库' }).getAttribute('href'), 'https://github.com/26eg/tools.aioz.cc');
      if (route !== '/') assert.equal(await page.locator('.aioz-back').getAttribute('href'), '/');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} overflows at ${width}px`);
      await page.screenshot({ path: `${output}/${route.split('/')[1] || 'home'}-${width}.png`, fullPage: true });
      if (route === '/xlsx-desensitizer/') {
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        const footer = await page.locator('.aioz-footer').boundingBox();
        const dock = await page.locator('.action-dock').boundingBox();
        assert.ok(footer.y + footer.height <= dock.y, `Footer overlaps action dock at ${width}px`);
      }
    }
  }
  await page.goto(base + '/tampermonkey-scripts/');
  const install = page.getByRole('link', { name: '安装脚本' });
  await install.last().waitFor();
  assert.equal(await install.count(), 4);
  for (const href of await install.evaluateAll((items) => items.map((item) => item.href))) {
    const response = await page.request.get(href);
    assert.equal(response.status(), 200);
    assert.match(await response.text(), /==UserScript==/);
  }

  await page.goto(base + '/qr-code-tool/');
  const initialQr = await page.locator('#genCanvas').evaluate((canvas) => canvas.toDataURL());
  await page.locator('#genInput').fill('AIOZ preview');
  await page.waitForFunction((before) => document.querySelector('#genCanvas').toDataURL() !== before, initialQr);
  const png = await page.locator('#genCanvas').evaluate((canvas) => canvas.toDataURL('image/png').split(',')[1]);
  const decode = page.getByRole('button', { name: '识别 / 解码' });
  await decode.focus();
  await decode.press('Enter');
  assert.equal(await decode.getAttribute('aria-pressed'), 'true');
  await page.locator('#fileInput').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => document.querySelector('#decText').value === 'AIOZ preview');

  await page.goto(base + '/xlsx-image-link-to-image-tool/');
  const rowBuffer = await page.evaluate(async () => {
    const workbook = new window.ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sample');
    sheet.addRow(['ID', 'Image']);
    sheet.addRow([1, 'https://images.example.test/ok.png']);
    sheet.addRow([2, 'https://images.example.test/missing.png']);
    return Array.from(new Uint8Array(await workbook.xlsx.writeBuffer()));
  });
  await page.route('https://images.example.test/**', (route) => route.request().url().endsWith('/ok.png')
    ? route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64'), headers: { 'Access-Control-Allow-Origin': '*' } })
    : route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' } }));
  const workbook = (name) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(rowBuffer) });
  await page.locator('#fileInput').setInputFiles(workbook('image-sample.xlsx'));
  await page.locator('#processButton').click();
  await page.getByRole('link', { name: '下载处理好的文件' }).waitFor();
  assert.match(await page.locator('#status').textContent(), /1\/2.*1 个链接/);

  await page.goto(base + '/xlsx-workbook-merger/');
  await page.locator('#fileInput').setInputFiles([workbook('merge-a.xlsx'), workbook('merge-b.xlsx')]);
  await page.locator('#mergeButton').click();
  await page.locator('#downloadLink').waitFor();
  assert.equal(await page.locator('#reportBody tr').count(), 2);

  const redirect = await page.request.get(base + '/xlsx-image-link-to-image-tool.html', { maxRedirects: 0 });
  assert.equal(redirect.status(), 301);
  assert.equal(redirect.headers().location, '/xlsx-image-link-to-image-tool/');
  for (const path of ['/README.md', '/package.json', '/scripts/test-pages-browser.mjs', '/.git/config', '/xlsx-desensitizer/VALIDATION.md', '/xlsx-desensitizer/src/app.ts']) {
    assert.equal((await page.request.get(base + path)).status(), 404, path);
  }
  assert.match((await page.request.get(base + '/xlsx-desensitizer/')).headers()['content-security-policy'], /connect-src 'none'/);
  assert.deepEqual(errors, []);
  console.log('Six pages × four widths, script routes, QR round trip, image conversion, workbook merge, and publication boundaries passed.');
} finally {
  await browser.close();
}

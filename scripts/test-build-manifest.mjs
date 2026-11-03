import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const generator = join(dirname(fileURLToPath(import.meta.url)), 'build-manifest.mjs');
const temp = mkdtempSync(join(tmpdir(), 'aioz-manifest-tests-'));
const config = join(temp, 'empty.gitconfig');
writeFileSync(config, '');
const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

function command(cwd, executable, args, extraEnv = {}, ok = true) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 20_000 });
  if (ok) assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result;
}
const git = (cwd, args, extraEnv) => command(cwd, 'git', args, extraEnv).stdout.trim();
function commit(repo, date) {
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}
function addScript(repo, name) {
  const directory = join(repo, 'tampermonkey-scripts', name);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${name}.user.js`);
  writeFileSync(file, `// ==UserScript==\n// @name ${name}\n// @version 1.0.0\n// @description fixture\n// @match https://example.invalid/*\n// ==/UserScript==\n(() => {})();\n`);
  return file;
}
function fixture() {
  const repo = mkdtempSync(join(temp, 'full-'));
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(generator, join(repo, 'scripts/build-manifest.mjs'));
  git(repo, ['init', '-q']);
  addScript(repo, 'alpha'); commit(repo, '2020-01-02T20:00:00-07:00');
  addScript(repo, 'beta'); commit(repo, '2020-02-03T20:00:00-07:00');
  writeFileSync(join(repo, 'tampermonkey-scripts/alpha/README.md'), 'documentation only');
  commit(repo, '2020-03-04T20:00:00-07:00');
  return repo;
}
function shallow(origin) {
  const copy = join(mkdtempSync(join(temp, 'clone-')), 'repo');
  git(temp, ['clone', '--quiet', '--depth=1', pathToFileURL(origin).href, copy]);
  assert.equal(git(copy, ['rev-parse', '--is-shallow-repository']), 'true');
  return copy;
}
function build(repo, ok = true) {
  return command(repo, process.execPath, ['scripts/build-manifest.mjs'], {}, ok);
}
const manifest = repo => JSON.parse(readFileSync(join(repo, 'tampermonkey-scripts/manifest.json'), 'utf8'));
const dates = repo => Object.fromEntries(manifest(repo).scripts.map(s => [s.id, s.updated]));

test('full history uses individual script commits, not folder commits or checkout mtimes', () => {
  const repo = fixture();
  for (const slug of ['alpha', 'beta']) utimesSync(join(repo, `tampermonkey-scripts/${slug}/${slug}.user.js`), new Date(), new Date());
  build(repo);
  assert.deepEqual(dates(repo), { alpha: '2020-01-02', beta: '2020-02-03' });
});

test('depth=1 clone reproduces wrong Git dates, then builder fetches history and corrects them', () => {
  const repo = shallow(fixture());
  assert.equal(git(repo, ['log', '-1', '--format=%cs', '--', 'tampermonkey-scripts/alpha/alpha.user.js']), '2020-03-04');
  build(repo);
  assert.equal(git(repo, ['rev-parse', '--is-shallow-repository']), 'false');
  assert.deepEqual(dates(repo), { alpha: '2020-01-02', beta: '2020-02-03' });
});

test('unavailable history fails the build without overwriting the existing manifest', () => {
  const repo = shallow(fixture());
  git(repo, ['remote', 'set-url', 'origin', join(temp, 'does-not-exist')]);
  const file = join(repo, 'tampermonkey-scripts/manifest.json');
  const previous = '{"preserve":"previous manifest"}\n';
  writeFileSync(file, previous);
  const result = build(repo, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /无法补齐 Git 历史/);
  assert.equal(readFileSync(file, 'utf8'), previous);
});

test('source archive without Git uses null dates instead of file modification dates', () => {
  const repo = mkdtempSync(join(temp, 'archive-'));
  mkdirSync(join(repo, 'scripts')); copyFileSync(generator, join(repo, 'scripts/build-manifest.mjs'));
  addScript(repo, 'alpha');
  build(repo);
  assert.deepEqual(dates(repo), { alpha: null });
});

test('uncommitted script has an unknown date while existing script dates stay unchanged', () => {
  const repo = fixture(); addScript(repo, 'new-script'); build(repo);
  assert.deepEqual(dates(repo), { alpha: '2020-01-02', beta: '2020-02-03', 'new-script': null });
});

test('script paths containing spaces and shell syntax are passed literally to Git', () => {
  const repo = fixture(); const slug = 'space $(not-a-command)'; addScript(repo, slug);
  commit(repo, '2020-04-05T20:00:00-07:00'); build(repo);
  assert.equal(dates(repo)[slug], '2020-04-05');
  assert.deepEqual(manifest(repo).scripts.find(s => s.id === slug).match, ['https://example.invalid/*']);
});

test('navigation renders per-script dates and explicitly labels unknown dates', async () => {
  const page = readFileSync(join(dirname(generator), '../tampermonkey-scripts/index.html'), 'utf8');
  const inline = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inline);
  const list = { innerHTML: '' };
  const scripts = ['2020-01-02', '2020-02-03', null, undefined].map((updated, i) => ({
    id: String(i), name: 'Fixture', version: '1.0.0', description: '', match: [], file: 'fixture.user.js', updated,
  }));
  await runInNewContext(inline, {
    document: { getElementById: () => list },
    fetch: async () => ({ ok: true, json: async () => ({ scripts }) }),
  });
  assert.deepEqual([...list.innerHTML.matchAll(/<span class="date">([^<]*)<\/span>/g)].map(m => m[1]), [
    '更新于 2020-01-02', '更新于 2020-02-03', '更新日期未知', '更新日期未知',
  ]);
});

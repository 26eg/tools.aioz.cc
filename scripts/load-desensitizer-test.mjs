import { build } from 'esbuild';
const result = await build({
  stdin: { contents: "export * from './xlsx-desensitizer/src/core.ts'; export * from './xlsx-desensitizer/src/ooxml.ts'; export * from './xlsx-desensitizer/src/report.ts';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', target: 'es2022', write: false,
});
export const engine = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

import { build, context } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
manifest.version = pkg.version;
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
const common = {
  bundle: true,
  target: 'chrome116',
  sourcemap: watch,
  logLevel: 'info',
};
const jobs = [
  {
    ...common,
    entryPoints: ['src/content/acm-main.ts'],
    outfile: 'dist/acm-main.js',
    format: 'iife',
  },
  {
    ...common,
    entryPoints: ['src/background/index.ts'],
    outfile: 'dist/background.js',
    format: 'esm',
  },
  {
    ...common,
    entryPoints: ['src/ui/main.ts'],
    outfile: 'dist/popup.js',
    format: 'esm',
  },
  {
    ...common,
    entryPoints: ['src/content/index.ts'],
    outfile: 'dist/content.js',
    format: 'iife',
    globalName: 'AutofferContent',
  },
];
if (watch) {
  for (const job of jobs) await (await context(job)).watch();
  console.log(
    'Watching TypeScript. Reload the extension after changes. public/ changes require restarting this command.',
  );
} else {
  await Promise.all(jobs.map((job) => build(job)));
}

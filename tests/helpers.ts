import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { scanPage } from '../src/platforms/registry';

export const fixture = readFileSync(
  new URL('./fixtures/demo.html', import.meta.url),
  'utf8',
);
export function demoDocument() {
  return new JSDOM(fixture, { url: 'http://localhost:4173/demo.html' }).window
    .document;
}
export function demoScan() {
  return scanPage({
    document: demoDocument(),
    url: new URL('http://localhost:4173/demo.html'),
  });
}

// Writes deploy/security-headers.conf and deploy/widget-security-headers.conf from apps/web/security-headers.ts, the
// single definition of the web app's security headers. Run after changing that policy and commit the result:
//   node deploy/render-security-headers.mjs           write the files
//   node deploy/render-security-headers.mjs --check   exit 1 when a committed file is stale (CI)
// Node 22.18+ loads the .ts module directly (type stripping). apps/web/src/security-headers.nginx.test.ts
// also fails on drift, and checks that every content location of deploy/nginx.conf sends exactly these headers.
import { readFileSync, writeFileSync } from 'node:fs';
import { nginxSecurityHeadersConf, nginxWidgetHeadersConf } from '../apps/web/security-headers.ts';

const files = [
  ['deploy/security-headers.conf', new URL('./security-headers.conf', import.meta.url), nginxSecurityHeadersConf()],
  ['deploy/widget-security-headers.conf', new URL('./widget-security-headers.conf', import.meta.url), nginxWidgetHeadersConf()],
];
if (process.argv.includes('--check')) {
  let stale = false;
  for (const [name, target, text] of files) {
    let current;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      current = '';
    }
    if (current !== text) {
      console.error(`${name} is stale: run node deploy/render-security-headers.mjs`);
      stale = true;
    }
  }
  if (stale) process.exit(1);
} else {
  for (const [, target, text] of files) writeFileSync(target, text);
}

// D5a architecture scans (R-MMS-1, R-MMS-6): media URLs are set only on the one send path (comms/dispatch.ts) and in the
// provider adapters; message_media rows are written only by inbound MMS (comms/media.ts) and outbound photo texts
// (comms/outboundMedia.ts).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : sourceFiles(p);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) && !/testing\.ts$/.test(n) ? [p] : [];
  });
}
const files = () => sourceFiles(API_SRC).map((f) => relative(API_SRC, f).replaceAll('\\', '/'));
const text = (f: string) => readFileSync(join(API_SRC, f), 'utf8');

describe('R-MMS-1 / R-MMS-6: where media enter a send', () => {
  it('R-MMS-1: `mediaUrls` is set only in comms/dispatch.ts and providers/**', () => {
    const setters = files().filter((f) => /\bmediaUrls\s*[:=]|\{\s*mediaUrls\s*\}/.test(text(f)));
    expect(setters.filter((f) => f !== 'comms/dispatch.ts' && !f.startsWith('providers/'))).toEqual([]);
    expect(setters).toContain('comms/dispatch.ts');
  });

  it('R-MMS-1: `INSERT INTO message_media` appears only in comms/media.ts and comms/outboundMedia.ts', () => {
    const writers = files().filter((f) => /INSERT\s+INTO\s+(public\.)?message_media\b(?!_)/i.test(text(f)));
    expect(writers.sort()).toEqual(['comms/media.ts', 'comms/outboundMedia.ts']);
  });

  it('R-MMS-1: no automated path names media: queueOutboundInTx\'s QueueSpec, the approve and bulk inputs carry no media field', () => {
    const compose = text('comms/compose.ts');
    const spec = compose.slice(compose.indexOf('export interface QueueSpec'), compose.indexOf('export type QueueResult'));
    expect(spec).not.toMatch(/media/i);
    expect(text('assistant/schemas.ts')).not.toMatch(/mediaIds/);
    for (const f of files().filter((x) => x.startsWith('bulk/'))) expect(text(f), f).not.toMatch(/mediaIds/);
  });
});

// Architecture test for core/copilot (CP-1, CP-10): no send, dial, stage-change, reassignment or write path,
// and no I/O import. Like voice/architecture.test.ts, node:fs is loaded through a dynamic import with a
// non-literal specifier (packages/core is pure; tests are excluded from the build).
import { describe, expect, it } from 'vitest';

interface FileUrl {
  readonly pathname: string;
}
const Url = (globalThis as unknown as { URL: new (path: string, base: string | FileUrl) => FileUrl }).URL;
interface FsLike {
  readdirSync(p: FileUrl): string[];
  readFileSync(p: FileUrl, enc: 'utf8'): string;
}
const NODE_FS = 'node:fs';
const fs = (await import(NODE_FS)) as FsLike;
const HERE = new Url('./', (import.meta as unknown as { url: string }).url);

describe('core/copilot architecture', () => {
  it('CP-1 no send, dial, stage-change or reassignment call and no I/O import in any source file', () => {
    const files = fs.readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = fs.readFileSync(new Url(f, HERE), 'utf8');
      expect(src, f).not.toMatch(/\b(sendSms|sendEmail|dialCall|dispatch|updateStage|setStage|reassign)\s*\(/);
      expect(src, f).not.toMatch(/from '@realty\/(db|api)|from '(pg|kysely|fastify|@anthropic-ai)/);
    }
  });
});

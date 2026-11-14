// Architecture of the AI ISA seller part (ISA-3; R-ISA-18, R-ISA-20, R-PRED-4, R-GMAIL-14; E536). Read as text.
//   - the comps pipeline and V2-A's statement rules are re-exported only by cmaSeam.ts and called only in comps.ts;
//   - no other non-test isa file names the sold fields, soldCandidates, prepareCma or clientSoldView;
//   - nothing in isa/** inserts a cma_reports row or imports homeowner/**, providers/publicRecords/**, predict/** or mailSync;
//   - the adapter `satisfies` ISA-1's IsaCompView; the seam's statement rules are cma/statement.ts's own (batch 16:
//     no stand-in is left in the seam).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ISA = fileURLToPath(new URL('..', import.meta.url));
const SELLER = fileURLToPath(new URL('.', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('testing.ts') ? [p] : [];
  });
}
const all = files(ISA);
const text = (p: string) => readFileSync(p, 'utf8');
const rel = (p: string) => relative(ISA, p);

describe('isa/seller architecture (R-ISA-18)', () => {
  it('R-ISA-18 E536: compsForSubjectInTx is re-exported only by cmaSeam.ts and called only in comps.ts', () => {
    const naming = all.filter((p) => /compsForSubjectInTx/.test(text(p))).map(rel).sort();
    expect(naming).toEqual(['seller/cmaSeam.ts', 'seller/comps.ts']);
    expect(text(join(SELLER, 'comps.ts')).match(/compsForSubjectInTx\(/g)).toHaveLength(1);
  });

  it('R-ISA-18: no other non-test isa file names close_price_cents, closePriceCents, close_date, closeDate, soldCandidates, prepareCma or clientSoldView', () => {
    const banned = /close_price_cents|closePriceCents|close_date|closeDate|soldCandidates|prepareCma|clientSoldView/;
    const naming = all.filter((p) => banned.test(text(p))).map(rel).sort();
    expect(naming).toEqual(['seller/cmaSeam.ts', 'seller/comps.ts']);
  });

  it('R-CMA-6 R-PRED-4 R-GMAIL-14: no INSERT INTO cma_reports; no import of homeowner, public records, predictions or mail sync', () => {
    for (const p of all) {
      const t = text(p);
      expect(t, rel(p)).not.toMatch(/INSERT\s+INTO\s+cma_reports/i);
      expect(t, rel(p)).not.toMatch(/from '[^']*(homeowner\/|providers\/publicRecords|\/predict\/|mailSync)[^']*'/);
    }
  });

  it('R-ISA-18: the adapter satisfies IsaCompView; the seller files import core/isa only through isa1Seam and ISA-2 only through isa2Seam', () => {
    expect(text(join(SELLER, 'comps.ts'))).toMatch(/\} satisfies IsaCompView;/);
    for (const p of files(SELLER)) {
      const t = text(p);
      if (!p.endsWith('isa1Seam.ts')) expect(t, rel(p)).not.toMatch(/from '@realty\/core\/isa'/);
      if (!p.endsWith('isa2Seam.ts')) expect(t, rel(p)).not.toMatch(/from '\.\.\/(repo|effects|controls|turn|send)\.js'/);
      if (!p.endsWith('cmaSeam.ts')) expect(t, rel(p)).not.toMatch(/from '\.\.\/\.\.\/cma\//);
    }
  });

  it('R-ISA-18 R-CMA-9: the statement rules are cma/statement.ts\'s own, imported only by cmaSeam.ts and applied only in comps.ts; no stand-in is left', () => {
    const seam = text(join(SELLER, 'cmaSeam.ts'));
    expect(seam).toMatch(/import \{[^}]*\bprintable\b[^}]*\} from '\.\.\/\.\.\/cma\/statement\.js';/);
    expect(seam).toMatch(/import \{[^}]*\bemailStatementOk\b[^}]*\} from '\.\.\/\.\.\/cma\/statement\.js';/);
    expect(seam).toMatch(/import \{[^}]*\bstatementProminence\b[^}]*\} from '\.\.\/\.\.\/cma\/statement\.js';/);
    // no local printable/statementProminence (the batch 15 stand-ins refused every statement)
    expect(seam).not.toMatch(/function (printable|statementProminence|emailStatementOk)\b|STUB\(V2-A\)/);
    const naming = all.filter((p) => /emailStatementRendering/.test(text(p))).map(rel).sort();
    expect(naming).toEqual(['seller/cmaSeam.ts', 'seller/comps.ts']);
    expect(text(join(SELLER, 'comps.ts')).match(/emailStatementRendering\(/g)).toHaveLength(1);
    // no seller file judges a statement itself or reaches V2-A's report or share code
    for (const p of all.filter((x) => !x.endsWith('cmaSeam.ts'))) expect(text(p), rel(p)).not.toMatch(/cma\/(statement|report|share)\.js|\b(printable|statementProminence|emailStatementOk)\(/);
  });
});

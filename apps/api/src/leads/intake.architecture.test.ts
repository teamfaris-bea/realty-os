// R-LSRC-6 (module 22): every channel creates or attaches a lead only through ingestInquiryInTx. A source scan:
//   - only leads/intake.ts, leads/repos/intake.ts and load/** (the scale generator) insert lead_inquiries or create a
//     contact `via 'intake'` (tests and test helpers excluded)
//   - the channels (Google lead forms, lead email, web chat, partner feeds, tracked numbers in comms/inbound) import the
//     intake module's ingestInquiryInTx (and its pure helpers), never its repository
//   - the new modules of this lane import no provider send (R-GATE-2; D1: every send goes through comms/dispatch.ts)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const isTest = (rel: string) => /\.test\.ts$/.test(rel) || /(^|\/)testing\.ts$/.test(rel) || /(^|\/)testing\//.test(rel);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const all = files(SRC).map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }));

describe('R-LSRC-6 one intake path', () => {
  it('R-LSRC-6: only the intake (and the load generator) inserts lead_inquiries or creates a contact via intake', () => {
    const hits = all.filter((f) => !isTest(f.rel) && (/INSERT INTO lead_inquiries/i.test(f.text) || /via:\s*'intake'/.test(f.text))).map((f) => f.rel);
    expect(hits.filter((r) => !['leads/intake.ts', 'leads/repos/intake.ts'].includes(r) && !r.startsWith('load/'))).toEqual([]);
    expect(hits).toContain('leads/intake.ts');
  });

  it('R-LSRC-6: the channels reach the intake only through ingestInquiryInTx, never its repository', () => {
    const channels = all.filter((f) => !isTest(f.rel) && (f.rel.startsWith('leadForms/') || ['leadEmail/service.ts', 'channels/webchat.ts', 'channels/feedPoll.ts', 'comms/inbound.ts'].includes(f.rel)));
    expect(channels.map((f) => f.rel)).toEqual(expect.arrayContaining(['leadEmail/service.ts', 'channels/webchat.ts', 'channels/feedPoll.ts', 'comms/inbound.ts']));
    for (const f of channels) {
      expect(f.text, f.rel).not.toMatch(/leads\/repos\/intake/);
      expect(f.text, f.rel).not.toMatch(/applyOwnershipCommandInTx\([^)]*\{\s*kind:\s*'create',\s*via:\s*'intake'/);
    }
    for (const rel of ['leadEmail/service.ts', 'channels/webchat.ts', 'channels/feedPoll.ts', 'comms/inbound.ts']) {
      expect(all.find((f) => f.rel === rel)!.text, rel).toMatch(/ingestInquiryInTx/);
    }
    const forms = channels.filter((f) => f.rel.startsWith('leadForms/'));
    if (forms.length > 0) expect(forms.some((f) => /ingestInquiryInTx/.test(f.text))).toBe(true);
  });

  it('R-LSRC-6 R-GATE-2: the lane\'s new modules import no provider send', () => {
    const lane = all.filter((f) => !isTest(f.rel) && (f.rel.startsWith('leadForms/') || ['leads/sources.ts', 'leads/sourcesSchemas.ts', 'leads/webhookAuth.ts'].includes(f.rel)));
    expect(lane.length).toBeGreaterThanOrEqual(3);
    for (const f of lane) expect(f.text, f.rel).not.toMatch(/\.(sendSms|sendEmail|sendMms|placeCall|dial)\(|providers\/(twilio|email|fake)\//);
  });

  it('R-GMAIL-14: Gmail sync still never reaches the intake', () => {
    for (const f of all.filter((x) => x.rel.startsWith('mailSync/') && !isTest(x.rel))) expect(f.text, f.rel).not.toMatch(/leads\/intake|ingestInquiry/);
  });
});

// Fake providers behave deterministically; createProviders fails fast on adapters Phase 1 lacks.
import { buildPrompt, verifyQuote } from '@realty/core/assistant';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testConfig } from '../auth/testHarness.js';
import { FAKE_BAD_QUOTE, ProviderConfigError, ProviderError, createFakeProviders, createProviders, parseFakeSources } from './index.js';
import { LocalFsStorage, StorageKeyError } from './storage.js';

const clock = { now: () => 1_794_300_000_000 as never };
const account = { accountRef: 'AC1', secret: 's' };
const T = '01a1c4ba-0000-7000-8000-0000000000aa';

describe('fake providers are deterministic', () => {
  it('telephony: same inputs ⇒ same refs and numbers across instances; a repeated idempotency key never sends twice', async () => {
    const a = createFakeProviders({ clock }).telephony;
    const b = createFakeProviders({ clock }).telephony;
    const req = { account, from: '+18435550001', to: '+18435550100', body: 'Hi', idempotencyKey: 'msg-1' };
    const ra = await a.sendSms(req);
    expect(ra).toEqual(await b.sendSms(req));
    expect(await a.sendSms({ ...req, body: 'changed' })).toEqual(ra);
    expect(a.sms).toHaveLength(1);
    expect(await a.lookupMessage(account, 'msg-1')).toEqual(ra);
    expect(await a.lookupMessage(account, 'msg-unknown')).toBeNull();
    expect(await a.purchaseNumber(account, { areaCode: '843' })).toEqual(await b.purchaseNumber(account, { areaCode: '843' }));
    expect(await a.createSubaccount(T, 'x')).toEqual(await b.createSubaccount(T, 'y'));
    expect(await a.fetchRecording(account, 'RE1')).toEqual(await b.fetchRecording(account, 'RE1'));
  });

  it('telephony: injected failures; timeout_after_submit records the submit but throws (the dispatch_unknown case)', async () => {
    const t = createFakeProviders({ clock }).telephony;
    t.failNext('rejected');
    await expect(t.sendSms({ account, from: '+1', to: '+2', body: 'x', idempotencyKey: 'k1' })).rejects.toMatchObject({ kind: 'rejected' });
    expect(t.sms).toHaveLength(0);
    t.failNext('timeout_after_submit');
    await expect(t.sendSms({ account, from: '+1', to: '+2', body: 'x', idempotencyKey: 'k2' })).rejects.toBeInstanceOf(ProviderError);
    expect(t.sms).toHaveLength(1);
    expect(await t.lookupMessage(account, 'k2')).toMatchObject({ status: 'queued' });
    // reconciliation then sees the same message; a retry with the same key does not duplicate it
    await t.sendSms({ account, from: '+1', to: '+2', body: 'x', idempotencyKey: 'k2' });
    expect(t.sms).toHaveLength(1);
  });

  it('email, DNC, carrier, MLS, AVM, transcription and push fakes are pure functions of their inputs', async () => {
    const a = createFakeProviders({ clock });
    const b = createFakeProviders({ clock });
    const e = { from: { address: 'a@x.test', name: 'A' }, to: 'b@x.test', subject: 's', text: 't', idempotencyKey: 'e1' };
    expect(await a.email.sendEmail(e)).toEqual(await b.email.sendEmail(e));
    expect(await a.email.verifyDomain('Harbor.test')).toEqual(await b.email.verifyDomain('harbor.test'));
    expect((await a.dnc.scrub(['+18435550199', '+18435550100'])).map((r) => r.listed)).toEqual([true, false]);
    expect(await a.dnc.scrub(['+18435550100'])).toEqual(await b.dnc.scrub(['+18435550100']));
    expect((await a.carrier.lookup('+18435550100')).lineType).toBe('mobile');
    expect((await a.carrier.lookup('+18435558100')).lineType).toBe('landline');
    expect((await a.carrier.lookup('+18435557100')).lineType).toBe('voip');
    expect(await a.carrier.lookup('+18435556100')).toEqual(await b.carrier.lookup('+18435556100'));
    const p1 = await a.mls.changes(null, 2);
    expect(p1.listings).toHaveLength(2);
    expect(await a.mls.changes(p1.cursor, 10)).toEqual(await b.mls.changes(p1.cursor, 10));
    expect(await a.avm.estimate({ line1: 'x', city: 'y', region: 'SC', postalCode: '29401' })).toEqual({ available: false });
    const audio = new Uint8Array([1, 2, 3]);
    expect(await a.transcription.transcribe({ audio, contentType: 'audio/wav' })).toEqual(await b.transcription.transcribe({ audio, contentType: 'audio/wav' }));
    a.push.gone.add('https://push.example.test/gone');
    expect(await a.push.deliverPush({ endpoint: 'https://push.example.test/gone', keys: { p256dh: 'x', auth: 'y' } }, { title: 't', body: 'b' })).toEqual({ status: 'gone' });
  });

  it('AI fake: answers the core output contract; one quote verifies against its source and one is deliberately bad (E33 exercised)', async () => {
    const contactId = '01a1c4ba-0000-7000-8000-0000000000c1';
    const at = 1_794_300_000_000 as never;
    const spec = buildPrompt({
      purpose: 'draft',
      contact: {
        contact: { id: contactId, firstName: 'Jane', lastName: 'Doe', zone: 'America/New_York' as never, stage: 'new', attributes: [], inquiry: null },
        messages: [{ id: 'm1', contactId, direction: 'inbound', channel: 'sms', author: 'client', body: 'Can we see the Harbor View house on Saturday morning?', at }],
        calls: [],
        notes: [],
        deals: [],
        listings: [],
        behaviorEvents: [],
      } as never,
      identity: { brokerageLegalName: 'Harbor Realty LLC', teamName: 'Harbor Team', agentFirstName: 'Sam', scope: 'agent', allowedLinkHosts: [], brokeragePostalAddress: null },
      voiceSamples: [],
    });
    const ai = createFakeProviders({ clock }).ai;
    const r1 = await ai.complete({ templateKey: spec.templateKey, system: spec.system, user: spec.user, maxOutputTokens: spec.maxOutputTokens });
    const r2 = await createFakeProviders({ clock }).ai.complete({ templateKey: spec.templateKey, system: spec.system, user: spec.user, maxOutputTokens: spec.maxOutputTokens });
    expect(r1).toEqual(r2);
    const out = JSON.parse(r1.text) as { claims: { evidence: { source: string; snippet: string }[] }[]; draft: { body: string }; explanation: string };
    expect(out.claims).toHaveLength(2);
    expect(JSON.stringify(out)).not.toMatch(/confidence/i);
    const src = spec.sources.find((s) => s.handle === out.claims[0]!.evidence[0]!.source)!;
    expect(src).toBeDefined();
    const ref = (snippet: string) => ({ sourceType: src.sourceType, sourceId: src.sourceId, locator: { kind: 'message' as const }, snippet });
    expect(verifyQuote(src, ref(out.claims[0]!.evidence[0]!.snippet) as never).verified).toBe(true);
    expect(out.claims[1]!.evidence[0]!.snippet).toBe(FAKE_BAD_QUOTE);
    expect(verifyQuote(src, ref(FAKE_BAD_QUOTE) as never).verified).toBe(false);
    expect(parseFakeSources(spec.user).map((s) => s.handle)).toEqual(['S1']);
  });
});

describe('createProviders', () => {
  it('defaults to fakes; refuses to start with a real adapter Phase 1 does not have (no silent fake)', () => {
    const p = createProviders(testConfig(), { clock });
    expect(p.telephony.constructor.name).toBe('FakeTelephony');
    expect(() => createProviders(testConfig({}, { TELEPHONY_PROVIDER: 'real' }), { clock })).toThrow(ProviderConfigError);
    expect(() => createProviders(testConfig({}, { EMAIL_PROVIDER: 'real' }), { clock })).toThrow(ProviderConfigError);
    expect(() => createProviders(testConfig({}, { AI_PROVIDER: 'anthropic' }), { clock })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createProviders(testConfig({}, { PUSH_PROVIDER: 'webpush' }), { clock })).toThrow(/VAPID/);
    const real = createProviders(testConfig({}, { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' }), { clock });
    expect(real.ai.constructor.name).not.toBe('FakeAi');
  });
});

describe('local encrypted FS storage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'realty-storage-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes under the tenant prefix, refuses traversal and foreign prefixes', async () => {
    const s = new LocalFsStorage(dir);
    const key = `tenants/${T}/recording/01a1c4ba-0000-7000-8000-0000000000d1`;
    await s.put(key, new Uint8Array([9, 8, 7]), { contentType: 'audio/wav' });
    expect(await s.exists(key)).toBe(true);
    expect(Array.from((await s.get(key))!)).toEqual([9, 8, 7]);
    expect(readdirSync(join(dir, 'tenants'))).toEqual([T]);
    expect(readFileSync(join(dir, key))).toHaveLength(3);
    await expect(s.put('tenants/../../etc/passwd', new Uint8Array(1), { contentType: 'x' })).rejects.toThrow(StorageKeyError);
    await expect(s.put(`tenants/${T}/../x`, new Uint8Array(1), { contentType: 'x' })).rejects.toThrow(StorageKeyError);
    await expect(s.get('other/x')).rejects.toThrow(StorageKeyError);
    await s.delete(key);
    expect(await s.get(key)).toBeNull();
  });
});

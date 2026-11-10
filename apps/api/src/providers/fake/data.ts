// Deterministic fakes for data providers: MLS feed, AVM (interface only in Phase 1), DNC scrub,
// carrier line-type lookup, transcription and web push. All outputs are pure functions of inputs.
import { createHash } from 'node:crypto';
import type {
  AvmProvider,
  CarrierLookup,
  DncProvider,
  DncResult,
  LineType,
  MlsFeed,
  MlsListing,
  PushProvider,
  PushTarget,
  TranscriptionProvider,
} from '../types.js';

const h = (s: string | Uint8Array) => createHash('sha256').update(s).digest();

// ---- MLS --------------------------------------------------------------------------------------

/** A small fixed catalogue; `changes(since)` pages through it by updatedAt. */
export const FAKE_MLS_LISTINGS: readonly MlsListing[] = [
  { mlsId: 'FAKE-1001', status: 'active', addressLine1: '12 Harbor View Dr', city: 'Charleston', region: 'SC', postalCode: '29401', listPriceCents: 625_000_00, beds: 3, bathsX10: 25, sqft: 1850, propertyType: 'single_family', updatedAt: '2026-10-01T14:00:00.000Z' },
  { mlsId: 'FAKE-1002', status: 'active', addressLine1: '400 King St Unit 5B', city: 'Charleston', region: 'SC', postalCode: '29403', listPriceCents: 410_000_00, beds: 2, bathsX10: 20, sqft: 1100, propertyType: 'condo', updatedAt: '2026-10-02T09:30:00.000Z' },
  { mlsId: 'FAKE-1003', status: 'pending', addressLine1: '77 Oak Hollow Ln', city: 'Mount Pleasant', region: 'SC', postalCode: '29464', listPriceCents: 789_000_00, beds: 4, bathsX10: 30, sqft: 2600, propertyType: 'single_family', updatedAt: '2026-10-03T16:45:00.000Z' },
  { mlsId: 'FAKE-1004', status: 'active', addressLine1: '9 Marsh Edge Ct', city: 'Summerville', region: 'SC', postalCode: '29485', listPriceCents: 355_000_00, beds: 3, bathsX10: 20, sqft: 1500, propertyType: 'townhouse', updatedAt: '2026-10-04T11:15:00.000Z' },
];

export class FakeMls implements MlsFeed {
  constructor(private readonly listings: readonly MlsListing[] = FAKE_MLS_LISTINGS) {}
  async changes(since: string | null, limit: number) {
    const sorted = [...this.listings].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.mlsId.localeCompare(b.mlsId));
    const page = sorted.filter((l) => since === null || l.updatedAt > since).slice(0, Math.max(1, limit));
    return { listings: page, cursor: page.length > 0 ? page[page.length - 1]!.updatedAt : since };
  }
}

// ---- AVM (Phase 2) ----------------------------------------------------------------------------

export class FakeAvm implements AvmProvider {
  async estimate(address: { line1: string; city: string; region: string; postalCode: string }) {
    void address;
    return { available: false as const };
  }
}

// ---- DNC --------------------------------------------------------------------------------------

/**
 * Listed on the national registry iff the subscriber number ends in "99" (so tests can pick listed
 * and unlisted numbers on purpose). Valid for 31 days (jurisdiction pack default, VERIFY WITH
 * COUNSEL). `checkedAt` is injected so results are deterministic.
 */
export class FakeDnc implements DncProvider {
  constructor(private readonly now: () => number) {}
  async scrub(phones: readonly string[]): Promise<DncResult[]> {
    const t = this.now();
    return phones.map((phone) => ({
      phone,
      registry: 'us_national' as const,
      listed: /99$/.test(phone),
      checkedAt: new Date(t).toISOString(),
      validUntil: new Date(t + 31 * 86_400_000).toISOString(),
    }));
  }
}

// ---- carrier ----------------------------------------------------------------------------------

/** Line numbers (last 4 digits) starting with 8 are landlines, 7 VoIP, 6 unknown; everything else mobile. */
export class FakeCarrier implements CarrierLookup {
  async lookup(e164: string): Promise<{ lineType: LineType; carrier: string | null }> {
    const sub = /^\+1\d{3}\d{3}(\d)\d{3}$/.exec(e164)?.[1];
    const lineType: LineType = sub === '8' ? 'landline' : sub === '7' ? 'voip' : sub === '6' ? 'unknown' : 'mobile';
    return { lineType, carrier: lineType === 'unknown' ? null : `FakeCarrier-${(h(e164)[0]! % 3) + 1}` };
  }
}

// ---- transcription ----------------------------------------------------------------------------

export class FakeTranscription implements TranscriptionProvider {
  async transcribe(r: { audio: Uint8Array; contentType: string; durationMs?: number; languageHint?: string }) {
    const d = h(Buffer.from(r.audio)).toString('hex').slice(0, 6);
    const end = Math.max(4_000, Math.min(r.durationMs ?? 8_000, 8_000));
    return {
      language: 'en',
      segments: [
        { startMs: 0, endMs: Math.floor(end / 2), speaker: 'agent', text: `Hi, thanks for taking my call (${d}).` },
        { startMs: Math.floor(end / 2), endMs: end, speaker: 'client', text: 'Sure. Can you call me back tomorrow afternoon?' },
      ],
    };
  }
}

// ---- web push ---------------------------------------------------------------------------------

export class FakePush implements PushProvider {
  readonly vapidPublicKey = null;
  readonly delivered: { target: PushTarget; payload: { title: string; body: string; url?: string; tag?: string } }[] = [];
  /** endpoints that answer 410 Gone */
  readonly gone = new Set<string>();
  async deliverPush(target: PushTarget, payload: { title: string; body: string; url?: string; tag?: string }) {
    if (this.gone.has(target.endpoint)) return { status: 'gone' as const };
    this.delivered.push({ target, payload });
    return { status: 'sent' as const };
  }
}

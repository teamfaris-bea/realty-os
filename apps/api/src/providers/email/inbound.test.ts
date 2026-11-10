// Vendor inbound/event formats normalize conservatively: unknown events are 'ignored', never guessed.
import { describe, expect, it } from 'vitest';
import { addressList, parseHeaderBlock, parsePostmarkEvent, parsePostmarkInbound, parseSendgridEvents, parseSendgridInbound } from './inbound.js';

describe('vendor email formats', () => {
  it('Postmark events: hard bounces, complaints and suppressions map; soft bounces and unknown records are ignored', () => {
    const ev = (o: Record<string, unknown>) => parsePostmarkEvent({ MessageID: 'm1', Metadata: { realty_ref: 'REF' }, ...o })!;
    expect(ev({ RecordType: 'Bounce', ID: 5, Type: 'HardBounce', BouncedAt: '2026-11-10T10:00:00Z' })).toEqual({ eventId: 'postmark:Bounce:m1:5', ref: 'REF', type: 'bounced', occurredAt: '2026-11-10T10:00:00.000Z' });
    expect(ev({ RecordType: 'Bounce', ID: 6, Type: 'SoftBounce' }).type).toBe('ignored');
    expect(ev({ RecordType: 'Bounce', ID: 7, Type: 'SpamNotification' }).type).toBe('complained');
    expect(ev({ RecordType: 'SpamComplaint', ID: 8 }).type).toBe('complained');
    expect(ev({ RecordType: 'Delivery', DeliveredAt: '2026-11-10T10:00:00Z' }).type).toBe('delivered');
    expect(ev({ RecordType: 'SubscriptionChange', SuppressSending: true, SuppressionReason: 'ManualSuppression', ChangedAt: '2026-11-10T10:00:00Z' }).type).toBe('unsubscribed');
    expect(ev({ RecordType: 'SubscriptionChange', SuppressSending: false, ChangedAt: '2026-11-10T10:00:00Z' }).type).toBe('ignored');
    expect(ev({ RecordType: 'SomethingNew' }).type).toBe('ignored');
    expect(parsePostmarkEvent([])).toBeNull();
    expect(parsePostmarkEvent({ RecordType: 'Bounce' })).toBeNull();
  });

  it('SendGrid events: bounce vs blocked, dropped, spam report, unsubscribe; events without an id are skipped', () => {
    const out = parseSendgridEvents([
      { event: 'bounce', type: 'bounce', sg_event_id: 'a', timestamp: 1794300000, realty_ref: 'R' },
      { event: 'bounce', type: 'blocked', sg_event_id: 'b' },
      { event: 'dropped', sg_event_id: 'c' },
      { event: 'spamreport', sg_event_id: 'd' },
      { event: 'group_unsubscribe', sg_event_id: 'e' },
      { event: 'deferred', sg_event_id: 'f' },
      { event: 'delivered' },
    ])!;
    expect(out.map((e) => e.type)).toEqual(['bounced', 'ignored', 'failed', 'complained', 'unsubscribed', 'ignored']);
    expect(out[0]).toEqual({ eventId: 'sendgrid:a', ref: 'R', type: 'bounced', occurredAt: new Date(1794300000 * 1000).toISOString() });
    expect(parseSendgridEvents({})).toBeNull();
  });

  it('inbound: recipients come from every field (best first); headers unfold; HTML-only bodies become text', () => {
    const pm = parsePostmarkInbound({ MessageID: 'x', FromFull: { Email: 'a@b.test' }, OriginalRecipient: 'r+tok@in.x', ToFull: [{ Email: 'other@x' }], HtmlBody: '<p>Hi&nbsp;there</p><script>x()</script>', Headers: [{ Name: 'Auto-Submitted', Value: 'auto-replied' }] })!;
    expect(pm).toEqual({ eventId: 'postmark:x', from: 'a@b.test', recipients: ['r+tok@in.x', 'other@x'], subject: null, text: 'Hi there', headers: { 'Auto-Submitted': 'auto-replied' } });
    expect(parseHeaderBlock('Subject: a\r\n  b\r\nX-A: 1\r\nX-A: 2')).toEqual({ Subject: 'a b', 'X-A': '1' });
    expect(addressList('"Doe, Jane" <j@x.test>, k@y.test, nonsense')).toEqual(['j@x.test', 'k@y.test']);
    const sg = parseSendgridInbound({ from: 'Jane <j@x.test>', to: 'r+tok@in.x', text: 'yes', headers: 'Message-ID: <abc@x>' })!;
    expect(sg.eventId).toBe('sendgrid:<abc@x>');
    expect(parseSendgridInbound({ to: 'r+tok@in.x' })).toBeNull();
  });
});

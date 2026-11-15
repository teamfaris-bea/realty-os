// b18 round 3 item 8 (R-PORTAL-20, R-ISA-20; after b18 review item 5c): the AI ISA turn loads message bodies by its own
// queries (isa/turn.ts turnInbounds and prepare), not through the assistant's contactBundle, so a quoted portal sign-in
// token in a record stored before 0093 (an inbound body was not redacted then, and an outbound body never is) reached
// the turn machine and the model prompt. Both loaders now hide it (hideForDisplay); the stored records are not
// rewritten. Synthetic tokens and fictional numbers only; the fake ISA model; nothing real.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { inboundSms } from '../comms/testing.js';
import { portalLinkUrl } from '../portal/shared/copy.js';
import { SIGNIN_TOKEN_HIDDEN } from '../portal/shared/redact.js';
import { type IsaWorld, aiMessages, assignmentOf, isaLead, isaWorld, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;
let origin: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
  origin = h.config.webOrigins[0]!;
});
afterAll(async () => {
  await h?.close();
});

const newToken = () => randomBytes(32).toString('base64url');
const bodyOf = async (id: string) => (await h.su.query<{ body: string }>('SELECT body FROM messages WHERE id = $1', [id])).rows[0]!.body;

describe('R-PORTAL-20 R-ISA-20 (b18 round 3 item 8): the AI ISA turn never carries a sign-in token from a message stored before 0093', () => {
  it('R-PORTAL-20 R-ISA-20: an inbound and an earlier team message stored with a token: the model prompt and the turn\'s stored state have neither token, the prompt shows them hidden, and the stored messages are not rewritten', async () => {
    const agent = w.agents[0]!;
    const l = await isaLead(h, agent);
    expect((await startCare(agent, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    // the client writes and the AI answers: that answer is the team message an older record would hold
    expect((await inboundSms(h, l.phone, w.mainNumber, 'Hi, we want to buy a home this spring.')).statusCode).toBe(200);
    await runIsa(h, w.tenantId, 6);
    const first = (await aiMessages(h, l.id)).find((m) => m.status === 'sent' || m.status === 'delivered')!;
    expect(first).toBeDefined();
    // fixture only, as the booking tests do: runIsa ages inbound instants by minutes, so the care's start and the
    // answer's dispatch instant move back with them (an inbound older than the start is not this care's to read)
    await h.su.query(`SET session_replication_role = replica; UPDATE ai_isa_assignments SET started_at = started_at - interval '2 hours' WHERE contact_id = '${l.id}' AND ended_at IS NULL; SET session_replication_role = origin`);
    await h.su.query(`UPDATE messages SET dispatched_at = dispatched_at - interval '30 minutes' WHERE contact_id = $1 AND direction = 'outbound' AND dispatched_at IS NOT NULL`, [l.id]);
    // the client replies again; before the turn runs, both records are made what batch 17 stored (fixture only: no
    // application path writes an inbound body with a token any more)
    expect((await inboundSms(h, l.phone, w.mainNumber, 'Thanks. We are looking in the north end.')).statusCode).toBe(200);
    const inbound = (await h.su.query<{ id: string }>("SELECT id FROM messages WHERE contact_id = $1 AND direction = 'inbound' ORDER BY created_at DESC, id DESC LIMIT 1", [l.id])).rows[0]!.id;
    expect(await bodyOf(inbound)).toBe('Thanks. We are looking in the north end.');
    const [tIn, tOut] = [newToken(), newToken()];
    const oldInbound = `Thanks. We are looking in the north end. Is this the page you meant? ${portalLinkUrl(origin, tIn)}`;
    const oldOutbound = `${await bodyOf(first.id)} ${portalLinkUrl(origin, tOut)}`;
    await h.su.query('UPDATE messages SET body = $2 WHERE id = $1', [inbound, oldInbound]);
    await h.su.query('UPDATE messages SET body = $2 WHERE id = $1', [first.id, oldOutbound]);
    w.ai.calls.length = 0;
    await runIsa(h, w.tenantId, 6);
    // the model was asked, with both messages among its sources
    expect(w.ai.calls.length).toBeGreaterThan(0);
    const prompts = w.ai.calls.map((c) => `${c.system}\n${c.user}`).join('\n');
    expect(prompts).toContain('We are looking in the north end.');
    expect(prompts).not.toContain(tIn);
    expect(prompts).not.toContain(tOut);
    expect(prompts.split(SIGNIN_TOKEN_HIDDEN).length - 1).toBeGreaterThanOrEqual(2);
    // what the turn stored about it (the machine, the turns, its actions and claims) has no token either
    const a = (await assignmentOf(h, l.id))!;
    const stored = await h.su.query<{ t: string }>(
      `SELECT machine::text AS t FROM ai_isa_assignments WHERE id = $1
       UNION ALL SELECT row_to_json(t)::text FROM ai_isa_turns t WHERE t.assignment_id = $1
       UNION ALL SELECT row_to_json(x)::text FROM assistant_actions x WHERE x.contact_id = $2
       UNION ALL SELECT c.text FROM assistant_claims c JOIN assistant_actions x ON x.id = c.action_id WHERE x.contact_id = $2
       UNION ALL SELECT m.body FROM messages m WHERE m.contact_id = $2 AND m.id <> ALL ($3::uuid[])`, [a.id, l.id, [inbound, first.id]]);
    for (const r of stored.rows) {
      expect(r.t).not.toContain(tIn);
      expect(r.t).not.toContain(tOut);
    }
    // the stored records keep what they held (hidden where read, never rewritten)
    expect(await bodyOf(inbound)).toBe(oldInbound);
    expect(await bodyOf(first.id)).toBe(oldOutbound);
  });
});

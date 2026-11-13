// A grant's published copy (R-PORTAL-18; finding F6): title, scope and the contact card, written to
// portal_grants.display by a writer at invite and by the system when the card's facts change. Never a personal phone:
// textTo is the team number the client is texted from (the conversation's sticky number, else the team main line);
// emailTo is the conversation's reply address, only once an email send set its reply token. VERIFY WITH COUNSEL
// (Q-PORTAL-6, VERIFY 5): what the client sees.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { replyAddress, replyToken } from '../../comms/render.js';
import { DEFAULT_TITLES, type GrantDisplay, type Scope } from '../shared/view.js';

export interface CardDeps {
  linkSecret: Uint8Array;
  publicBaseUrl: string;
}

export type PartyRole = 'primary' | 'buyer' | 'seller' | 'co_buyer' | 'co_seller';

/** purchase or sale for a deal party: the role says it; a primary contact only follows the deal's side (dual: purchase). */
export function dealScope(side: string, role: PartyRole): 'purchase' | 'sale' {
  if (role === 'buyer' || role === 'co_buyer') return 'purchase';
  if (role === 'seller' || role === 'co_seller') return 'sale';
  return side === 'sell' ? 'sale' : 'purchase';
}

/** The contact card fields for a client (team number, reply address) and an agent name. */
export async function cardFor(tx: Tx, d: CardDeps, tenantId: string, contactId: string, agentUserId: string | null): Promise<Pick<GrantDisplay, 'agentName' | 'textTo' | 'emailTo'>> {
  const out: Pick<GrantDisplay, 'agentName' | 'textTo' | 'emailTo'> = {};
  if (agentUserId) {
    const n = await sql<{ n: string }>`SELECT display_name AS n FROM users WHERE id = ${agentUserId}`.execute(tx);
    const name = (n.rows[0]?.n ?? '').replace(/\p{Cc}/gu, ' ').trim().slice(0, 120);
    if (name) out.agentName = name;
  }
  const conv = await sql<{ id: string; reply_token_hash: Buffer | null; sticky: string | null }>`
    SELECT c.id, c.reply_token_hash, n.e164 AS sticky
      FROM conversations c LEFT JOIN phone_numbers n ON n.tenant_id = c.tenant_id AND n.id = c.sticky_phone_number_id AND n.released_at IS NULL
     WHERE c.tenant_id = app.tenant_id() AND c.contact_id = ${contactId}`.execute(tx);
  const c = conv.rows[0];
  let textTo = c?.sticky ?? null;
  if (!textTo) {
    const main = await sql<{ e164: string }>`
      SELECT e164 FROM phone_numbers WHERE tenant_id = app.tenant_id() AND purpose = 'team_main' AND released_at IS NULL AND sms_capable
       ORDER BY acquired_at, id LIMIT 1`.execute(tx);
    textTo = main.rows[0]?.e164 ?? null;
  }
  if (textTo && /^\+[1-9][0-9]{6,14}$/.test(textTo)) out.textTo = textTo;
  if (c?.reply_token_hash) {
    const addr = replyAddress(d.publicBaseUrl, replyToken(d.linkSecret, tenantId, c.id));
    if (addr.length <= 320) out.emailTo = addr;
  }
  return out;
}

export interface DisplayFacts {
  scope: Scope;
  title: string;
}

/** The title and scope of a new grant: the person's title, else "Your home purchase/sale", else the listing's street line. */
export function titleAndScope(o: { kind: 'deal'; side: string; role: PartyRole; title?: string | undefined } | { kind: 'listing'; line1: string; title?: string | undefined }): DisplayFacts {
  if (o.kind === 'deal') {
    const scope = dealScope(o.side, o.role);
    return { scope, title: o.title ?? DEFAULT_TITLES[scope] };
  }
  const line = o.line1.replace(/\p{Cc}/gu, ' ').trim().slice(0, 120);
  return { scope: 'listing', title: o.title ?? (line || DEFAULT_TITLES.listing) };
}

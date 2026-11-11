// Fixtures for the portal auth tests (module 43). Everything a client can later reach is written through the
// staff application paths as app_user under RLS (contact via the ownership engine, the point, deal, account,
// grant, document and item by the agent; the scan result by the system actor), exactly as modules 42/45 will.
// The superuser is used only to flip the platform:portal clearance (platform data has no application writer),
// to age rows past their expiry (the definers compare with the database clock) and to read state back.
import { randomBytes } from 'node:crypto';
import type { ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { consumePortalLogin, type PortalSignIn, requestPortalLogin } from '../src/portalTx.js';
import { withTenantTx } from '../src/tenantTx.js';
import { type Harness, type Member, selfCreated, uuid, type World } from './world.js';

export interface Party {
  contactId: ContactId;
  pointId: string;
  email: string;
  dealId: string;
  accountId: string;
  grantId: string;
  documentId: string;
  objectId: string;
  itemId: string;
  agent: Member;
}

export async function setPortalCleared(h: Harness, cleared: boolean): Promise<void> {
  await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = ${cleared ? 'now()' : 'NULL'} WHERE key = 'platform:portal' AND status = 'published'`);
}

export async function addEmailPoint(h: Harness, agent: Member, contactId: string, email: string): Promise<string> {
  const id = uuid();
  await withTenantTx(agent.actor, (tx) => sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
    VALUES (${agent.actor.tenantId}, ${id}, ${contactId}, 'email', ${email}, ${randomBytes(32)})`.execute(tx), { db: h.app });
  return id;
}

/** A clean, shared document of the deal and its published portal item on the grant. */
export async function publishDocument(h: Harness, w: World, agent: Member, dealId: string, grantId: string, name = 'Contract.pdf'): Promise<{ documentId: string; objectId: string; itemId: string }> {
  const t = w.tenantId;
  const objectId = uuid();
  const documentId = uuid();
  const itemId = uuid();
  await withTenantTx(agent.actor, async (tx) => {
    await sql`INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, key_version, dek_wrapped, created_by_user_id)
      VALUES (${t}, ${objectId}, 'document', ${`tenants/${t}/doc/${objectId}`}, 'application/pdf', 1234, ${randomBytes(32)}, 1, '\\x01'::bytea, ${agent.id})`.execute(tx);
    await sql`INSERT INTO documents (tenant_id, id, deal_id, object_id, kind, display_name, uploaded_by_user_id)
      VALUES (${t}, ${documentId}, ${dealId}, ${objectId}, 'purchase_contract', ${name}, ${agent.id})`.execute(tx);
  }, { db: h.app });
  await withTenantTx(w.system('worker'), (tx) => sql`UPDATE documents SET scan_status = 'clean' WHERE id = ${documentId}`.execute(tx), { db: h.app });
  await withTenantTx(agent.actor, async (tx) => {
    await sql`UPDATE documents SET shared_to_portal = true WHERE id = ${documentId}`.execute(tx);
    await sql`INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, source_type, source_id, document_id, published_by_kind, published_by_user_id, published_at)
      VALUES (${t}, ${itemId}, ${grantId}, 'document', ${name}, 'document', ${documentId}, ${documentId}, 'user', ${agent.id}, now())`.execute(tx);
  }, { db: h.app });
  return { documentId, objectId, itemId };
}

/** A buyer with an email, a deal they are the primary contact of, an invited portal account and a grant. */
export async function createParty(h: Harness, w: World, agent: Member, name = 'Jane Buyer', email?: string): Promise<Party> {
  const t = w.tenantId;
  const contactId = await selfCreated(h.app, w, agent, name);
  const addr = email ?? `${name.toLowerCase().replace(/[^a-z]/g, '')}-${randomBytes(3).toString('hex')}@example.test`;
  const pointId = await addEmailPoint(h, agent, contactId, addr);
  const dealId = uuid();
  const accountId = uuid();
  const grantId = uuid();
  await withTenantTx(agent.actor, async (tx) => {
    await sql`INSERT INTO deals (tenant_id, id, name, side, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id)
      VALUES (${t}, ${dealId}, ${name + ' purchase'}, 'buy', now(), ${contactId}, ${agent.id}, ${agent.id})`.execute(tx);
    await sql`INSERT INTO portal_accounts (tenant_id, id, contact_id, login_point_id, status, invited_by_user_id)
      VALUES (${t}, ${accountId}, ${contactId}, ${pointId}, 'invited', ${agent.id})`.execute(tx);
    await sql`INSERT INTO portal_grants (tenant_id, id, portal_account_id, deal_id, granted_by_user_id, granted_at)
      VALUES (${t}, ${grantId}, ${accountId}, ${dealId}, ${agent.id}, now())`.execute(tx);
  }, { db: h.app });
  const doc = await publishDocument(h, w, agent, dealId, grantId, `${name} contract.pdf`);
  return { contactId, pointId, email: addr, dealId, accountId, grantId, agent, ...doc };
}

export async function signIn(h: Harness, w: World, p: Party): Promise<PortalSignIn> {
  // tests sign the same client in many times: age that account's earlier links out of the 5-per-hour throttle
  // window (the throttle itself is tested with requestPortalLogin directly)
  await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours'
                     WHERE portal_account_id = $1`, [p.accountId]);
  const links = await requestPortalLogin(w.slug, p.email, { db: h.app });
  const link = links.find((l) => l.portalAccountId === p.accountId);
  if (!link) throw new Error('no magic link issued');
  const s = await consumePortalLogin(link.token, { ip: '203.0.113.7', userAgent: 'vitest' }, { db: h.app });
  if (!s) throw new Error('sign-in refused');
  return s;
}

// pnpm seed [--reset]: a demo tenant in the dev database (realty_dev), built THROUGH THE REAL API.
//
// The real Fastify server runs in this process (buildServer + app.inject) against DATABASE_URL as the
// RLS-bound app_user, with the dev .env keys (KEK, session and webhook secrets) and the deterministic
// fake providers, so everything it writes is readable by `pnpm dev:api` / `pnpm dev:worker` afterwards.
// Users sign up / are invited and accept through the API; leads arrive through the signed intake
// webhook; texts through the signed telephony webhook; consent, contacts, deals, listings, tasks,
// playbooks, enrollments and drafts through their routes; jobs (timers, follow-ups, exception
// recompute) run through the real worker loop and handler list.
//
// The superuser connection (MIGRATION_DATABASE_URL) is used ONLY where Phase 1 has no application
// path, and each such fixture says so below:
//   - clock fixtures: moving stored deadlines / appointment times into the past (Postgres' clock
//     cannot be faked), the same fixtures the module tests use;
//   - a recorded, transcribed call (provider webhooks + transcription write these in production);
//   - one contact's California address (no address-edit route in Phase 1; CSV/FUB import writes them);
//   - resetting the TOTP replay guard between the Owner's codes in one 30-second window.
//
// --reset drops and recreates realty_dev and re-applies the migrations first (stop dev servers first).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type TenantId, instant, uuidv7Generator } from '@realty/core/foundation';
import { closeDefaultDatabase, configureDatabase, withTenantTx } from '@realty/db';
import { migrate } from '@realty/db/migrate';
import { sql } from 'kysely';
import pg from 'pg';
import { recomputeExceptions } from '../accountability/index.js';
import { summarizeCall } from '../assistant/callPipeline.js';
import { totpCode, totpStep } from '../auth/totp.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { loadConfig } from '../config.js';
import { createFakeProviders } from '../providers/index.js';
import { signedHeader, telephonySignature } from '../providers/webhooks.js';
import { buildServer } from '../server.js';
import { handlers } from '../worker/handlers/index.js';
import { createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { SeedClient, SeedError } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../..');
export const CREDENTIALS_PATH = resolve(REPO_ROOT, '.demo/credentials.json');
export const DEMO_SLUG = 'harbor-pine';
export const DEMO_PASSWORD = 'harbor-pine-demo-2026';
const DOMAIN = 'demo.realty-os.test';

const log = (msg: string) => process.stdout.write(`seed: ${msg}\n`);

// ---- names -------------------------------------------------------------------------------------------

const PEOPLE = {
  owner: { email: `owner@${DOMAIN}`, name: 'Olivia Grant' },
  teamLead: { email: `lead@${DOMAIN}`, name: 'Taylor Morgan' },
  agent1: { email: `avery@${DOMAIN}`, name: 'Avery Brooks' },
  agent2: { email: `blake@${DOMAIN}`, name: 'Blake Chen' },
  agent3: { email: `casey@${DOMAIN}`, name: 'Casey Diaz' },
  isa: { email: `isabel@${DOMAIN}`, name: 'Isabel Reyes' },
  tc: { email: `toni@${DOMAIN}`, name: 'Toni Walsh' },
} as const;
type PersonKey = keyof typeof PEOPLE;

// Boston numbers (tenant zone America/New_York), a block nobody is assigned in this demo; the fake
// telephony provider never sends anything.
let phoneSeq = 0;
const phone = () => `+1617201${String(1000 + ++phoneSeq).padStart(4, '0')}`;
const email = (first: string, last: string) => `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com';

// ---- reset -------------------------------------------------------------------------------------------

async function resetDatabase(ownerUrl: string): Promise<void> {
  const u = new URL(ownerUrl);
  const dbName = decodeURIComponent(u.pathname.slice(1));
  const admin = new URL(ownerUrl);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
    await c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(dbName)}`);
    await c.query(`CREATE DATABASE ${c.escapeIdentifier(dbName)} TEMPLATE template0 ENCODING 'UTF8'`);
  } finally {
    await c.end();
  }
  const r = await migrate(ownerUrl, resolve(REPO_ROOT, 'packages/db/migrations'), { log: () => {} });
  log(`reset ${dbName}: ${r.applied.length} migrations applied`);
}

// ---- main --------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) throw new SeedError('MIGRATION_DATABASE_URL is not set (run pnpm db:setup first)');
  if (reset) await resetDatabase(ownerUrl);
  const su = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  // An idle client can be terminated by the server (a test database dropped WITH (FORCE), a restart):
  // without a listener pg re-throws it as an unhandled error. Queries in flight still reject normally.
  su.on('error', () => {});
  try {
    const exists = await su.query('SELECT 1 FROM tenants WHERE slug = $1', [DEMO_SLUG]);
    if (exists.rowCount) {
      log(`the demo tenant "${DEMO_SLUG}" already exists. Run \`pnpm seed --reset\` to rebuild the dev database from scratch.`);
      return;
    }
    await seed(su);
  } finally {
    await su.end();
  }
}

async function seed(su: pg.Pool): Promise<void> {
  const base = loadConfig();
  // the in-process server: dev keys and secrets, fake providers, a generous global rate limit
  const config = { ...base, logLevel: 'silent' as const, globalRateLimitPerMinute: 100_000 };
  const origin = config.webOrigins[0] ?? 'http://localhost:5173';
  const db = configureDatabase({ url: config.databaseUrl, applicationName: 'realty-seed', max: 6 });
  const clock = { now: () => instant(Date.now()) };
  const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
  const providers = createFakeProviders({ clock });
  const app = buildServer(config, { providers, clock, ids, db });
  await app.ready();
  const registry = new HandlerRegistry().registerAll(handlers);
  const worker = createWorker({ db, registry, providers, queues: ['realtime', 'default', 'bulk', 'maintenance'], concurrency: 4, worker: 'seed', idleMs: 10, log: silentLogger });
  /** Runs every due job (and the jobs they enqueue) through the real worker loop and handler list. */
  const drain = async () => {
    for (let i = 0; i < 6; i++) if ((await worker.drain(200)) === 0) break;
  };

  let ipSeq = 10;
  const client = (mail = '') => new SeedClient(app, origin, `198.51.100.${ipSeq++}`, mail);

  // ---- 1. Owner signs up and enrolls MFA (Owner/Admin must: R-PERM-14) --------------------------------
  const owner = client(PEOPLE.owner.email);
  await owner.must('POST', '/auth/signup', {
    email: PEOPLE.owner.email,
    password: DEMO_PASSWORD,
    displayName: PEOPLE.owner.name,
    teamName: 'Harbor & Pine Team',
    slug: DEMO_SLUG,
    timezone: 'America/New_York',
    brokerageLegalName: 'Harbor & Pine Realty LLC',
  });
  const tenantId = owner.tenantId;
  const enroll = await owner.must<{ secret: string }>('POST', '/auth/mfa/enroll');
  const totpSecret = enroll.secret;
  /** a fresh code; clears the replay guard first (a fixture: several codes are used within one 30 s step) */
  const code = async () => {
    await su.query('UPDATE users SET mfa_last_used_step = NULL WHERE id = $1', [owner.userId]);
    return totpCode(totpSecret, totpStep(Date.now()));
  };
  await owner.must('POST', '/auth/mfa/enroll/confirm', { code: await code() });
  // sensitive Owner actions need a re-auth within 15 minutes (R-PERM-13); the seed re-authenticates only
  // when the server asks (the re-auth endpoint is rate limited)
  owner.reauth = async () => void (await owner.must('POST', '/auth/reauth', { password: DEMO_PASSWORD, code: await code() }));
  log(`tenant ${DEMO_SLUG} created; Owner ${PEOPLE.owner.email} enrolled in MFA`);

  // ---- 2. members: invited by email through the API, accepted through the emailed link ---------------
  const members: Record<PersonKey, SeedClient> = { owner } as Record<PersonKey, SeedClient>;
  const roles: Record<Exclude<PersonKey, 'owner'>, string> = { teamLead: 'team_lead', agent1: 'agent', agent2: 'agent', agent3: 'agent', isa: 'isa', tc: 'tc' };
  for (const [key, role] of Object.entries(roles) as [Exclude<PersonKey, 'owner'>, string][]) {
    const p = PEOPLE[key];
    await owner.must('POST', '/invites', { email: p.email, role });
    const link = providers.accountMail.lastLink(p.email);
    const token = link ? /#token=([^&]+)$/.exec(link)?.[1] : undefined;
    if (!token) throw new SeedError(`no invite link was emailed to ${p.email}`);
    const c = client(p.email);
    await c.must('POST', `/auth/invites/${token}/accept`, { displayName: p.name, password: DEMO_PASSWORD });
    members[key] = c;
  }
  const { teamLead, agent1, agent2, agent3, isa } = members;
  const agents = [agent1, agent2, agent3];
  // a (fake) push device per field member, so routing has somewhere to deliver offers
  for (const c of [teamLead, ...agents, isa]) {
    await c.must('POST', '/push-subscriptions', { endpoint: `https://push.example.test/sub/${randomUUID()}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' } });
  }
  log('members invited and accepted: Team Lead, 3 agents, ISA, TC');

  // ---- 3. team, pond, routing, lead source, settings ------------------------------------------------
  const team = await owner.must<{ team: { id: string } }>('POST', '/teams', { name: 'Harbor Team' });
  await owner.must('PUT', `/teams/${team.team.id}/members`, {
    members: [{ userId: teamLead.userId, isLead: true }, ...agents.map((a) => ({ userId: a.userId, isLead: false })), { userId: isa.userId, isLead: false }],
  });
  const buyerPond = await owner.must<{ pond: { id: string } }>('POST', '/ponds', { name: 'Buyer leads pond', claimsPerDay: 5 });
  await owner.must('POST', '/routing-rules', { name: 'Harbor Team round robin', strategy: 'round_robin', match: {}, members: agents.map((a) => ({ userId: a.userId, weight: 1 })) });
  const source = await owner.must<{ source: { id: string }; ingestToken: string }>('POST', '/lead-sources', { name: 'Website inquiry form', kind: 'portal' });
  const settings = await owner.must<{ settings: { version: number } }>('GET', '/settings');
  // demo-friendly lead timers: 30 min offers, round-the-clock routing (every value is a normal setting)
  await owner.must('PATCH', '/settings', { version: settings.settings.version, offerWindowSeconds: 1800, routingHoursStart: '00:00', routingHoursEnd: '23:59' });
  const s2 = await owner.must<{ settings: { version: number } }>('GET', '/settings');
  await owner.must('PATCH', '/settings/identity', { version: s2.settings.version, brokerageLicenseNumber: 'RB-0000000 (demo)', brokeragePostalAddress: '100 Harbor St, Suite 2, Boston, MA 02110' });
  log('team, buyer pond, round-robin rule, lead source, lead timers and brokerage identity set');

  // ---- 4. phone number, 10DLC registration, email identity -----------------------------------------
  const num = await owner.must<{ number: { id: string; e164: string } }>('POST', '/numbers', { purpose: 'team_main', areaCode: '617' });
  const reg = await owner.must<{ registration: { id: string } }>('POST', '/sender-registrations', { kind: 'a2p_campaign', useCase: 'customer care', sampleMessages: ['Hi, this is Avery with Harbor & Pine following up on your inquiry.'], optInDescription: 'Leads opt in on our website inquiry form.' });
  await owner.must('POST', `/sender-registrations/${reg.registration.id}/refresh`);
  await owner.must('PATCH', `/numbers/${num.number.id}/registration`, { registrationId: reg.registration.id });
  await owner.must('POST', '/email-identities', { fromAddress: `team@send.${DOMAIN}`, displayName: 'Harbor & Pine Team' });
  const mainNumber = num.number.e164;
  log(`team number ${mainNumber} registered; team email identity added`);

  // ---- helpers ---------------------------------------------------------------------------------------
  const deps = depsFromPlatform(app.platform);
  const telephony = (path: string, params: Record<string, string>) => {
    const url = new URL(`/api${path}`, config.publicBaseUrl).toString();
    return app.inject({ method: 'POST', url: `/api${path}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': telephonySignature(config.webhookSecrets.telephony, url, params) }, payload: new URLSearchParams(params).toString() });
  };
  let sidSeq = 0;
  const inboundSms = async (from: string, body: string) => {
    const r = await telephony('/webhooks/telephony/sms', { MessageSid: `SMseed${Date.now().toString(16)}${String(++sidSeq).padStart(6, '0')}`, From: from, To: mainNumber, Body: body, NumMedia: '0' });
    if (r.statusCode >= 300) throw new SeedError(`inbound sms → ${r.statusCode} ${r.body}`);
  };
  const intake = async (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body);
    const r = await app.inject({ method: 'POST', url: `/api/intake/${source.ingestToken}`, headers: { 'content-type': 'application/json', 'x-realty-signature': signedHeader(config.webhookSecrets.lead, Math.floor(Date.now() / 1000), raw) }, payload: raw });
    if (r.statusCode >= 300) throw new SeedError(`intake → ${r.statusCode} ${r.body}`);
    return JSON.parse(r.body) as { contactId: string };
  };
  const state = async (id: string) =>
    (await su.query<{ ownership_state: string; owner_user_id: string | null; offered_to_user_id: string | null; offer_id: string | null; ownership_seq: string }>('SELECT ownership_state, owner_user_id, offered_to_user_id, offer_id, ownership_seq FROM contacts WHERE id = $1', [id])).rows[0]!;
  const pointOf = async (contactId: string, kind: 'phone' | 'email') => (await su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND kind = $2 ORDER BY created_at LIMIT 1', [contactId, kind])).rows[0]!.id;
  const consent = async (c: SeedClient, contactId: string, channels: ('sms' | 'voice' | 'email')[]) => {
    for (const ch of channels) {
      await c.must('POST', `/contacts/${contactId}/consent`, { kind: 'record', pointId: await pointOf(contactId, ch === 'email' ? 'email' : 'phone'), channel: ch, purpose: 'all', level: 'express', evidence: { note: 'Asked on the phone; said yes to texts, calls and email.' } });
    }
  };
  interface Contact { id: string; name: string; phone: string; email: string }
  const created: Contact[] = [];
  /** An agent adds a contact they met (owned by them) with staff-entered express consent (R-CONSENT-4). */
  const contact = async (c: SeedClient, first: string, last: string, o: { intent?: string; contactType?: string; consent?: ('sms' | 'voice' | 'email')[] } = {}): Promise<Contact> => {
    const ph = phone();
    const em = email(first, last);
    const r = await c.must<{ contact: { id: string } }>('POST', '/contacts', { commandId: randomUUID(), firstName: first, lastName: last, phones: [ph], emails: [em], ...(o.intent ? { intent: o.intent } : {}), ...(o.contactType ? { contactType: o.contactType } : {}) });
    await consent(c, r.contact.id, o.consent ?? ['sms', 'voice', 'email']);
    const out = { id: r.contact.id, name: `${first} ${last}`, phone: ph, email: em };
    created.push(out);
    return out;
  };
  const leadCmd = (c: SeedClient, id: string, verb: string, body: Record<string, unknown> = {}) => c.must('POST', `/leads/${id}/${verb}`, { commandId: randomUUID(), ...body });
  const nameOf = new Map(Object.entries(PEOPLE).map(([k, p]) => [members[k as PersonKey]?.userId, p.name] as const));

  // ---- 5. the agents' own contacts (sphere, clients, active conversations) -------------------------
  const jane = await contact(agent1, 'Jane', 'Cooper', { intent: 'buyer' });
  const lena = await contact(agent1, 'Lena', 'Park', { intent: 'buyer' });
  const marco = await contact(agent1, 'Marco', 'Silva', { intent: 'seller' });
  const owen = await contact(agent1, 'Owen', 'Price', { intent: 'buyer' }); // will opt out (STOP)
  await contact(agent1, 'Dana', 'Whitfield', { intent: 'seller' });
  const grace = await contact(agent1, 'Grace', 'Kim', { intent: 'buyer' }); // California address (all-party recording state)
  const sophia = await contact(agent1, 'Sophia', 'Nguyen', { intent: 'buyer' }); // call → promise + saved search
  const liam = await contact(agent1, 'Liam', 'Foster', { intent: 'buyer' }); // a text the carrier rejects
  const ethan = await contact(agent1, 'Ethan', 'Ross', { intent: 'buyer', contactType: 'sphere' });
  const mia = await contact(agent1, 'Mia', 'Torres', { intent: 'buyer', contactType: 'sphere' });
  const noah = await contact(agent1, 'Noah', 'Bennett', { intent: 'buyer' });
  const ava = await contact(agent1, 'Ava', 'Morales', { intent: 'seller', contactType: 'past_client' });
  await contact(agent1, 'Henry', 'Clark', { intent: 'buyer', contactType: 'sphere' });
  await contact(agent1, 'Chloe', 'Adams', { intent: 'seller', contactType: 'past_client' });

  const b1 = await contact(agent2, 'Ryan', 'Patel', { intent: 'buyer' });
  const b2 = await contact(agent2, 'Emma', 'Walker', { intent: 'seller' });
  const b3 = await contact(agent2, 'Lucas', 'Hughes', { intent: 'buyer', contactType: 'sphere' });
  const b4 = await contact(agent2, 'Zoe', 'Bryant', { intent: 'buyer_seller' });
  await contact(agent2, 'Isaac', 'Turner', { intent: 'investor' });
  await contact(agent2, 'Nora', 'Fleming', { intent: 'buyer', contactType: 'sphere' });
  await contact(agent2, 'Owen', 'Gallagher', { intent: 'renter' });

  const c1 = await contact(agent3, 'Harper', 'Lee', { intent: 'seller' });
  const c2 = await contact(agent3, 'Jack', 'Murphy', { intent: 'buyer' });
  const c3 = await contact(agent3, 'Ella', 'Ramirez', { intent: 'buyer', contactType: 'sphere' });
  await contact(agent3, 'Leo', 'Sanders', { intent: 'seller', contactType: 'past_client' });
  await contact(agent3, 'Ivy', 'Coleman', { intent: 'buyer' });
  await contact(agent3, 'Mason', 'Reed', { intent: 'seller', contactType: 'sphere' });
  await contact(agent2, 'Caleb', 'Ward', { intent: 'buyer' });
  await contact(agent1, 'Aria', 'Jensen', { intent: 'buyer', contactType: 'sphere', consent: ['email'] });

  await contact(isa, 'Miles', 'Ortega', { intent: 'buyer' });
  await contact(isa, 'Ruby', 'Shaw', { intent: 'buyer' });
  log(`${created.length} agent/ISA contacts with staff-entered consent`);

  // ---- 6. conversations: inbound texts through the signed telephony webhook --------------------------
  await inboundSms(jane.phone, 'Hi Avery! Does Saturday morning work for a showing at 12 Oak St? We are pre-approved up to $650k.');
  await inboundSms(lena.phone, 'Can you send me the HOA docs for the Pine St condo before Thursday?');
  await inboundSms(b1.phone, 'Thanks for the list. The second one looks great, can we see it this week?');
  // Owen texts STOP: the ingestion revokes texting consent atomically and queues the one confirmation
  await inboundSms(owen.phone, 'STOP');
  log('inbound texts: Jane, Lena, Ryan, and a STOP from Owen');

  // ---- 7. the assistant drafts replies (fake AI; evidence quotes the client's own words) -------------
  await agent1.must('POST', `/contacts/${jane.id}/drafts`, { commandId: randomUUID() });
  await agent1.must('POST', `/contacts/${lena.id}/drafts`, { commandId: randomUUID() });
  await agent2.must('POST', `/contacts/${b1.id}/drafts`, { commandId: randomUUID() });
  log('assistant drafts for Jane, Lena (Avery) and Ryan (Blake) waiting for approval');

  // ---- 8. a California address (Grace) ---------------------------------------------------------------
  // (core-compliance/2.0.0 removed the national DNC registry check, so no DNC scrub is seeded any more.)
  // fixture (no address-edit route in Phase 1): Grace lives in Los Angeles, CA (an all-party
  // recording-consent state, VERIFY WITH COUNSEL; with no counsel-reviewed CA pack the call gate announces)
  await su.query(`INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code, country, jurisdiction) VALUES ($1,$2,$3,'home','2140 Rose Ave','Los Angeles','CA','90039','US','US-CA')`, [tenantId, randomUUID(), grace.id]);
  await su.query(`UPDATE contacts SET timezone = 'America/Los_Angeles', timezone_source = 'address' WHERE id = $1`, [grace.id]);
  log('Grace has a California address');

  // ---- 9. leads arrive through the signed intake webhook and are offered round robin ----------------
  const leads = [
    { fullName: 'Priya Shah', inquiryType: 'buy', message: 'Is 12 Oak St still available? We would love to see it this weekend.', propertyText: '12 Oak St', postalCode: '02134', priceMaxCents: 75_000_000 },
    { fullName: 'Marcus Lee', inquiryType: 'buy', message: 'Looking for a 3 bed near Jamaica Plain, under 700k.', postalCode: '02130', priceMaxCents: 70_000_000 },
    { fullName: 'Hannah Wright', inquiryType: 'sell', message: 'Thinking about selling our condo in the spring. What is it worth?', postalCode: '02116' },
    { fullName: 'Diego Alvarez', inquiryType: 'buy', message: 'First-time buyer, can you help me get started?', postalCode: '02145', priceMaxCents: 55_000_000 },
    { fullName: 'Samira Haddad', inquiryType: 'buy', message: 'Interested in the Pine St open house.', propertyText: '48 Pine St', postalCode: '02118' },
    { fullName: 'Tom Becker', inquiryType: 'buy', message: 'Relocating from Chicago in March, need a 2 bed rental first.', postalCode: '02139' },
    { fullName: 'Grace Okafor', inquiryType: 'buy', message: 'Do you have anything with a yard under 800k?', postalCode: '02131', priceMaxCents: 80_000_000 },
    { fullName: 'Ben Carter', inquiryType: 'general', message: 'Cheap watches, click here', postalCode: '02110' },
    { fullName: 'Lily Chen', inquiryType: 'buy', message: 'Can I see 12 Oak St on Sunday?', propertyText: '12 Oak St', postalCode: '02134', priceMaxCents: 75_000_000 },
  ];
  const offers: { id: string; name: string; to: string; offerId: string }[] = [];
  for (const l of leads) {
    const r = await intake({ ...l, phones: [phone()], emails: [email(l.fullName.split(' ')[0]!, l.fullName.split(' ')[1]!)] });
    const s = await state(r.contactId);
    if (s.ownership_state !== 'offered' || !s.offered_to_user_id || !s.offer_id) throw new SeedError(`lead ${l.fullName} was not offered (state ${s.ownership_state})`);
    offers.push({ id: r.contactId, name: l.fullName, to: s.offered_to_user_id, offerId: s.offer_id });
  }
  const offersOf = (a: SeedClient) => offers.filter((o) => o.to === a.userId);
  const take = (a: SeedClient) => {
    const o = offersOf(a).shift();
    if (!o) throw new SeedError(`no offer left for ${a.email}`);
    offers.splice(offers.indexOf(o), 1);
    return o;
  };
  // Blake and Casey accept their first offers and then do nothing: the first-touch SLA lapses
  const untouched: { id: string; name: string; owner: SeedClient }[] = [];
  for (const a of [agent2, agent3]) {
    const o = take(a);
    await leadCmd(a, o.id, 'accept', { offerId: o.offerId });
    untouched.push({ id: o.id, name: o.name, owner: a });
  }
  // Blake accepts another, then releases it to the buyer pond (not a fit for him)
  const released = take(agent2);
  await leadCmd(agent2, released.id, 'accept', { offerId: released.offerId });
  await leadCmd(agent2, released.id, 'release', { reason: 'wrong_area', note: 'Outside my farm area', toPondId: buyerPond.pond.id });
  // Casey declines one: it goes back to routing and is re-offered by the ownership follow-up job
  const declined = take(agent3);
  await leadCmd(agent3, declined.id, 'decline', { offerId: declined.offerId, reason: 'busy' });
  // the spam inquiry is closed by the Team Lead
  const spamIdx = offers.findIndex((o) => o.name === 'Ben Carter');
  const spam = offers.splice(spamIdx, 1)[0]!;
  await leadCmd(teamLead, spam.id, 'close', { reason: 'spam' });
  // Avery's offers stay live for the demo; the second one is about to expire (clock fixture below)
  const averyOffers = offersOf(agent1);
  log(`leads: ${leads.length} inquiries; Avery has ${averyOffers.length} live offers`);
  await drain(); // the decline's follow-up routes it again; notifications go out

  // clock fixture: Avery's second offer expires in 6 minutes (deadline column, ledger instant and timer move together)
  const expiring = averyOffers[1] ?? averyOffers[0];
  if (expiring) {
    const at = (await su.query<{ t: Date }>(`SELECT clock_timestamp() + interval '6 minutes' AS t`)).rows[0]!.t;
    await suFixture(su, [
      { text: 'UPDATE contacts SET offer_expires_at = $2 WHERE id = $1', values: [expiring.id, at] },
      { text: "UPDATE lead_ownership_events e SET deadline_at = $2 FROM contacts c WHERE c.id = $1 AND e.contact_id = c.id AND e.type = 'offered' AND e.offer_id = c.offer_id", values: [expiring.id, at] },
      { text: "UPDATE jobs SET run_at = LEAST(run_at, $2) WHERE kind = 'ownership.offer_expiry' AND payload->>'contactId' = $1::text AND status = 'pending'", values: [expiring.id, at] },
    ]);
  }

  // clock fixture: the untouched leads were accepted 70 minutes ago (their whole ledger history moves back
  // together, so fold(ledger) still equals the projection), and the first-contact deadline passed 55
  // minutes ago (auto-release in 23 h)
  for (const u of untouched) {
    const t = (await su.query<{ due: Date; rel: Date }>(`SELECT owned_at - interval '70 minutes' + interval '15 minutes' AS due, clock_timestamp() + interval '23 hours' AS rel FROM contacts WHERE id = $1`, [u.id])).rows[0]!;
    await suFixture(su, [
      { text: `UPDATE lead_ownership_events SET occurred_at = occurred_at - interval '70 minutes', deadline_at = deadline_at - interval '70 minutes' WHERE contact_id = $1`, values: [u.id] },
      { text: `UPDATE contacts SET created_at = created_at - interval '70 minutes', owned_at = owned_at - interval '70 minutes', first_touch_due_at = $2, release_due_at = $3 WHERE id = $1`, values: [u.id, t.due, t.rel] },
      { text: `UPDATE lead_inquiries SET received_at = received_at - interval '70 minutes' WHERE contact_id = $1`, values: [u.id] },
      { text: `UPDATE lead_ownership_events e SET deadline_at = $2, payload = jsonb_set(e.payload, '{releaseDueAt}', to_jsonb($3::bigint)) FROM contacts c WHERE c.id = $1 AND e.contact_id = c.id AND e.seq = c.ownership_period_seq`, values: [u.id, t.due, t.rel.getTime()] },
      { text: `UPDATE jobs SET run_at = to_timestamp($2::bigint / 1000.0), payload = jsonb_set(payload, '{dueAt}', to_jsonb($2::bigint)) WHERE kind = 'ownership.first_touch_breach' AND payload->>'contactId' = $1::text AND status = 'pending'`, values: [u.id, t.due.getTime()] },
      { text: `UPDATE jobs SET run_at = to_timestamp($2::bigint / 1000.0), payload = jsonb_set(payload, '{dueAt}', to_jsonb($2::bigint)) WHERE kind = 'ownership.auto_release' AND payload->>'contactId' = $1::text AND status = 'pending'`, values: [u.id, t.rel.getTime()] },
    ]);
  }
  await drain(); // the breach timers fire through the real handlers (breach event + Team Lead alert)

  // a pond claim: Avery accepts a spare offer (if routing gave her one), releases it to the default pond,
  // and Casey claims it from there
  const spare = averyOffers.find((o) => o !== expiring && o !== averyOffers[0]);
  if (spare) {
    await leadCmd(agent1, spare.id, 'accept', { offerId: spare.offerId });
    await leadCmd(agent1, spare.id, 'release', { reason: 'not_a_fit', note: 'Rental only for now' });
    await leadCmd(agent3, spare.id, 'claim');
  }
  log('lead states: offered (one expiring in 6 min), owned and untouched (SLA breached), released to a pond, declined and re-offered, claimed, closed as spam');

  // ---- 10. a text the carrier rejects (failed send), and a normal sent text -------------------------
  providers.telephony.failNext('rejected');
  await agent1.must('POST', `/contacts/${liam.id}/messages`, { channel: 'sms', body: 'Hi Liam, the inspection report is in. Want me to walk you through it tonight?', idempotencyKey: `seed-${randomUUID()}` });
  await agent1.must('POST', `/contacts/${noah.id}/messages`, { channel: 'sms', body: 'Hi Noah, congrats again on getting under contract! The appraisal is booked for Thursday.', idempotencyKey: `seed-${randomUUID()}` });
  log('texts: one rejected by the carrier (Liam), one sent (Noah)');

  // ---- 11. appointments: a buyer consult that ended 3 h ago with no outcome logged ------------------
  const start = new Date(Date.now() + 86_400_000);
  const consult = await agent1.must<{ appointment: { id: string } }>('POST', '/appointments', { kind: 'listing_appointment', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString(), contactId: marco.id, location: '9 Elm St' });
  // clock fixture: the listing appointment ended 3 hours ago
  await su.query("UPDATE appointments SET starts_at = clock_timestamp() - interval '4 hours', ends_at = clock_timestamp() - interval '3 hours' WHERE id = $1", [consult.appointment.id]);
  const consult2 = await agent2.must<{ appointment: { id: string } }>('POST', '/appointments', { kind: 'buyer_consult', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString(), contactId: b4.id, location: 'Office' });
  await su.query("UPDATE appointments SET starts_at = clock_timestamp() - interval '6 hours', ends_at = clock_timestamp() - interval '5 hours' WHERE id = $1", [consult2.appointment.id]);
  const later = new Date(Date.now() + 2 * 86_400_000);
  later.setUTCHours(15, 0, 0, 0);
  await agent1.must('POST', '/appointments', { kind: 'buyer_consult', startsAt: later.toISOString(), endsAt: new Date(later.getTime() + 3_600_000).toISOString(), contactId: jane.id, location: '12 Oak St' });
  await agent3.must('POST', '/appointments', { kind: 'listing_appointment', startsAt: later.toISOString(), endsAt: new Date(later.getTime() + 3_600_000).toISOString(), contactId: c1.id, location: '77 Harbor View' });

  // ---- 12. tasks -------------------------------------------------------------------------------------
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  await agent1.must('POST', '/tasks', { title: 'Send Jane the disclosure package', kind: 'document', contactId: jane.id, dueAt: inHours(3) });
  await agent1.must('POST', '/tasks', { title: 'Call Ethan about refinancing timing', kind: 'callback', contactId: ethan.id, dueAt: inHours(26) });
  await agent2.must('POST', '/tasks', { title: 'Pull comps for Emma', kind: 'todo', contactId: b2.id, dueAt: inHours(5) });
  await agent3.must('POST', '/tasks', { title: 'Order a staging consult for Harper', kind: 'follow_up', contactId: c1.id, dueAt: inHours(30) });

  // ---- 13. listings ----------------------------------------------------------------------------------
  const listing = (c: SeedClient, l: Record<string, unknown>) => c.must<{ listing: { id: string } }>('POST', '/listings', { region: 'MA', propertyType: 'single_family', ...l });
  const oak = await listing(agent1, { status: 'active', addressLine1: '12 Oak St', city: 'Boston', postalCode: '02134', listPriceCents: 72_500_000, beds: 3, bathsX10: 20, sqft: 1650, description: 'Sunny colonial with a fenced yard.' });
  await listing(agent2, { status: 'active', addressLine1: '48 Pine St', addressLine2: 'Unit 3', city: 'Boston', postalCode: '02118', listPriceCents: 61_000_000, beds: 2, bathsX10: 20, sqft: 1120, propertyType: 'condo' });
  await listing(agent3, { status: 'coming_soon', addressLine1: '77 Harbor View', city: 'Quincy', postalCode: '02169', listPriceCents: 89_900_000, beds: 4, bathsX10: 30, sqft: 2400 });
  await listing(agent1, { status: 'pending', addressLine1: '9 Elm St', city: 'Somerville', postalCode: '02145', listPriceCents: 79_900_000, beds: 3, bathsX10: 25, sqft: 1800, propertyType: 'townhouse' });
  await listing(agent2, { status: 'sold', addressLine1: '5 Chestnut Ave', city: 'Brookline', postalCode: '02445', listPriceCents: 115_000_000, beds: 4, bathsX10: 35, sqft: 2900 });

  // ---- 14. deals in several stages -------------------------------------------------------------------
  const deal = async (c: SeedClient, contactId: string, d: { side: string; priceCents: number; close: string; stages: string[]; listingId?: string; lostReason?: string }) => {
    const r = await c.must<{ deal: { id: string; rowVersion: number } }>('POST', '/deals', { primaryContactId: contactId, side: d.side, priceCents: d.priceCents, expectedCloseDate: d.close, ...(d.listingId ? { listingId: d.listingId } : {}) });
    let v = r.deal.rowVersion;
    for (const stage of d.stages) v = (await c.must<{ deal: { rowVersion: number } }>('POST', `/deals/${r.deal.id}/stage`, { rowVersion: v, stage, ...(stage === 'lost' && d.lostReason ? { lostReason: d.lostReason } : {}) })).deal.rowVersion;
    return r.deal.id;
  };
  await deal(agent1, noah.id, { side: 'buy', priceCents: 69_000_000, close: '2026-12-18', stages: ['agreement_signed', 'active', 'under_contract'] });
  await deal(agent1, ava.id, { side: 'sell', priceCents: 81_500_000, close: '2026-10-30', stages: ['agreement_signed', 'active', 'under_contract', 'closed'] });
  await deal(agent1, jane.id, { side: 'buy', priceCents: 65_000_000, close: '2027-02-15', stages: [], listingId: oak.listing.id });
  await deal(agent2, b2.id, { side: 'sell', priceCents: 61_000_000, close: '2027-01-20', stages: ['agreement_signed', 'active'] });
  await deal(agent2, b3.id, { side: 'buy', priceCents: 50_000_000, close: '2026-12-01', stages: ['lost'], lostReason: 'Bought with a relative’s agent' });
  await deal(agent3, c1.id, { side: 'sell', priceCents: 89_900_000, close: '2027-03-01', stages: ['agreement_signed'] });
  await deal(agent3, c2.id, { side: 'buy', priceCents: 58_000_000, close: '2027-01-10', stages: ['agreement_signed', 'active'] });
  log('5 listings, 7 deals (prospect → closed, one lost)');

  // ---- 15. an approved team nurture playbook, and enrollments -------------------------------------
  const DAY = 86_400;
  const pb = await owner.must<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>('POST', '/playbooks', {
    kind: 'nurture',
    scope: 'team',
    name: 'Sphere check-ins',
    steps: [
      { stepKey: 'market_note', channel: 'email', delay: { anchor: 'enrollment', offsetSeconds: 3 * DAY }, purpose: 'marketing', category: 'nurture_step', intent: 'market_update', subject: 'A quick market note', template: 'Hi {{first_name}},\n\nHomes near you are still moving. If you want a short list of what came up this month, just reply and I will put it together.', personalization: 'none', slots: ['first_name'], maxLength: 2000, stopIf: ['appointment_booked', 'deal_opened'] },
      { stepKey: 'check_in', channel: 'email', delay: { anchor: 'previous_step', offsetSeconds: 30 * DAY }, purpose: 'marketing', category: 'nurture_step', intent: 'check_in', subject: 'Checking in', template: 'Hi {{first_name}},\n\nJust checking in. Is a move still on your mind, or should I check back in a few months?', personalization: 'none', slots: ['first_name'], maxLength: 2000, stopIf: ['appointment_booked', 'deal_opened'] },
    ],
  });
  const v1 = pb.playbook.versions[0]!;
  await owner.must('POST', `/playbook-versions/${v1.id}/approve`, { attestation: 'I reviewed both Sphere check-in emails and approve the assistant sending them on schedule.', contentSha256: v1.contentSha256 });
  for (const [c, who] of [[ethan, agent1], [mia, agent1], [b3, agent2], [c3, agent3]] as const) {
    await who.must('POST', `/contacts/${c.id}/enrollments`, { playbookId: pb.playbook.id });
  }
  log('approved team nurture playbook "Sphere check-ins" with 4 enrollments');

  // ---- 16. a recorded call 5 days ago: summary, promises (one overdue) and a saved-search proposal ---
  // fixture: the call, recording and encrypted transcript as the provider webhooks + transcription write them
  const callAt = new Date(Date.now() - 5 * 86_400_000);
  const callId = await recordedCall(su, deps, tenantId, sophia.id, agent1.userId, callAt, [
    { startMs: 0, endMs: 20_000, speaker: 'agent', text: 'Thanks for calling back, Sophia. What are you looking for?' },
    { startMs: 21_000, endMs: 40_000, speaker: 'client', text: 'We want three bedrooms near 02134, under 750k if we can.' },
    { startMs: 41_000, endMs: 60_000, speaker: 'agent', text: 'Great. I will send you the comps for Oak St by tomorrow.' },
    { startMs: 61_000, endMs: 75_000, speaker: 'client', text: 'Perfect, thank you.' },
  ]);
  // The fake model is scripted with the answers a real model gives for this transcript (the quotes are the
  // transcript's own words, so evidence verification passes); the pipeline itself is the real one.
  providers.ai.scripted.push(
    { text: JSON.stringify({ explanation: 'Sophia gave her search and Avery promised comps.', claims: [{ kind: 'commitment', text: 'Send Sophia the comps for Oak St', when: 'tomorrow', needs_review: false, evidence: [{ source: 'S1', locator: { kind: 'transcript_offset', start_ms: 41_000, end_ms: 60_000 }, snippet: 'I will send you the comps for Oak St by tomorrow' }] }] }) },
    { text: JSON.stringify({ explanation: 'Search criteria from the call.', claims: [
      { kind: 'preference', text: 'Near 02134', criterion: { key: 'postal_codes', value: ['02134'] }, needs_review: false, evidence: [{ source: 'S1', locator: { kind: 'transcript_offset', start_ms: 21_000, end_ms: 40_000 }, snippet: 'near 02134' }] },
      { kind: 'preference', text: 'Under $750k', criterion: { key: 'price_max', value: 750_000 }, needs_review: false, evidence: [{ source: 'S1', locator: { kind: 'transcript_offset', start_ms: 21_000, end_ms: 40_000 }, snippet: 'under 750k' }] },
      { kind: 'preference', text: 'Three bedrooms', criterion: { key: 'beds_min', value: 3 }, needs_review: false, evidence: [{ source: 'S1', locator: { kind: 'transcript_offset', start_ms: 21_000, end_ms: 40_000 }, snippet: 'three bedrooms' }] },
    ] }) },
  );
  const summary = await summarizeCall(systemActor(tenantId, 'assistant'), callId, deps);
  if (summary.kind !== 'done' || !summary.searchId) throw new SeedError(`call pipeline: ${JSON.stringify(summary)}`);
  log('Sophia: call summary with an overdue promise, and a saved buyer search waiting for Avery’s approval');

  // ---- 17. run the worker: follow-ups, notifications, and the exception queue -----------------------
  await drain();
  await withTenantTx(systemActor(tenantId, 'worker'), (tx, now) => recomputeExceptions(tx, 'tenant', now, ids), { db });
  const ex = await su.query<{ item_type: string; n: number }>("SELECT item_type, count(*)::int AS n FROM exception_items WHERE tenant_id = $1 GROUP BY item_type ORDER BY 1", [tenantId]);
  const count = await su.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [tenantId]);
  log(`exception queue: ${ex.rows.map((r) => `${r.item_type} ${r.n}`).join(', ') || 'empty'}`);
  log(`${count.rows[0]!.n} contacts in total`);
  for (const t of ['untouched_lead', 'overdue_promise', 'failed_send', 'missing_outcome']) {
    if (!ex.rows.some((r) => r.item_type === t)) throw new SeedError(`the exception queue has no ${t} item`);
  }

  // ---- 18. demo credentials ---------------------------------------------------------------------------
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify(
      {
        note: 'Demo logins for the local dev database only (pnpm seed). Never reuse these anywhere.',
        password: DEMO_PASSWORD,
        ownerTotpSecret: totpSecret,
        users: Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [k, { email: p.email, name: p.name, role: k === 'owner' ? 'owner' : roles[k as Exclude<PersonKey, 'owner'>] }])),
        contacts: { optedOut: owen.name, californiaAddress: grace.name, drafts: [jane.name, lena.name], failedSend: liam.name, savedSearch: sophia.name },
        untouchedLeads: untouched.map((u) => ({ name: u.name, owner: nameOf.get(u.owner.userId) })),
        averyOffers: averyOffers.map((o) => o.name),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  log(`done. Demo logins: see README "Demo logins"; Owner TOTP: pnpm demo:totp (credentials in ${CREDENTIALS_PATH})`);
  await app.close();
  await closeDefaultDatabase();
}

async function suFixture(su: pg.Pool, statements: { text: string; values?: unknown[] }[]): Promise<void> {
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const s of statements) await c.query(s.text, s.values ?? []);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Fixture: a completed, announced, recorded inbound call (the client called back) with a ready transcript, encrypted as comms stores it. */
async function recordedCall(su: pg.Pool, deps: ReturnType<typeof depsFromPlatform>, tenantId: string, contactId: string, agentUserId: string, started: Date, segments: { startMs: number; endMs: number; speaker: string; text: string }[]): Promise<string> {
  const callId = randomUUID();
  const recId = randomUUID();
  let conv = (await su.query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1', [contactId])).rows[0]?.id;
  if (!conv) {
    conv = randomUUID();
    await su.query('INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1,$2,$3)', [tenantId, conv, contactId]);
  }
  const addr = (await su.query<{ address: string }>("SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'phone' LIMIT 1", [contactId])).rows[0]?.address ?? '+16172019999';
  await su.query(
    `INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, agent_user_id, client_address, initiator, status, started_at, answered_at, ended_at,
       duration_s, recording_mode, recording_announced_at, recording_decision)
     VALUES ($1,$2,$3,$4,'inbound',$5,$6,'client','completed',$7,$7,$8,75,'announced_all_parties',$7,'{}')`,
    [tenantId, callId, conv, contactId, agentUserId, addr, started, new Date(started.getTime() + 75_000)],
  );
  await su.query(
    `INSERT INTO recordings (tenant_id, id, call_id, contact_id, agent_user_id, source, consent_basis, status, retain_until)
     VALUES ($1,$2,$3,$4,$5,'provider','announced_all_parties','pending_copy', now() + interval '700 days')`,
    [tenantId, recId, callId, contactId, agentUserId],
  );
  const tid = randomUUID();
  await withTenantTx(
    systemActor(tenantId, 'provider'),
    async (tx) => {
      const enc = await deps.envelope.inTx(tx, tenantId as TenantId).encrypt(tenantId as TenantId, { table: 'transcripts', column: 'segments_enc', rowId: tid }, Buffer.from(JSON.stringify(segments)));
      await sql`INSERT INTO transcripts (tenant_id, id, recording_id, contact_id, status, language, segments_enc, key_version, provider)
                VALUES (app.tenant_id(), ${tid}, ${recId}, ${contactId}, 'ready', 'en', ${Buffer.from(enc)}, 1, 'fake')`.execute(tx);
    },
    { db: deps.db },
  );
  return callId;
}

main().catch(async (e: unknown) => {
  process.stderr.write(`seed failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
  await closeDefaultDatabase().catch(() => undefined);
  process.exit(1);
});

// b18 item d (OQ-1114-14, owner queued recommendation 2026-11-14): the Integrations page shows the deployment-wide AI
// sending switch (AI_ISA_LIVE_SENDS; R-ISA-25) beside the AI pack lines. Display only: GET /admin/integrations reports it,
// no route changes it, and the AI ISA's own hold (comms/dispatch.ts) is the only place it is enforced.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, inviteViaApi } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { AI_SENDING_OFF, AI_SENDING_ON } from './catalog.js';

interface View {
  platformPacks: { key: string }[];
  aiSending: { live: boolean; sentence: string };
}

let off: ApiHarness;
let on: ApiHarness;
let ownerOff: TestClient;
let ownerOn: TestClient;
beforeAll(async () => {
  off = await createApiHarness();
  on = await createApiHarness({ config: { aiIsaLiveSends: true } });
  ownerOff = await off.signup();
  ownerOn = await on.signup();
}, 180_000);
afterAll(async () => {
  await off?.close();
  await on?.close();
});

describe('R-ISA-25 the Integrations page names the deployment-wide AI sending switch (b18 OQ-1114-14)', () => {
  it('R-ISA-25: with AI_ISA_LIVE_SENDS false (the default) the overview says AI sending is off on this deployment, in the AI screens\' words, whatever the packs say', async () => {
    expect(off.config.aiIsaLiveSends).toBe(false);
    const r = await call<View>(ownerOff, 'GET', '/admin/integrations');
    expect(r.status).toBe(200);
    expect(r.body.aiSending).toEqual({ live: false, sentence: AI_SENDING_OFF });
    expect(AI_SENDING_OFF.startsWith('AI assistant sending is off on this deployment.')).toBe(true);
    expect(AI_SENDING_OFF).toMatch(/AI sending switch is off/);
    expect(AI_SENDING_OFF).toMatch(/only shows the switch/);
    // staff words: no raw code or variable name (the page strips them; DEPLOY names AI_ISA_LIVE_SENDS)
    for (const x of [AI_SENDING_OFF, AI_SENDING_ON]) expect(x).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b/);
    // shown beside the AI pack lines: both AI packs are on the same page
    expect(r.body.platformPacks.map((p) => p.key)).toEqual(expect.arrayContaining(['platform:ai_isa', 'platform:ai_isa_seller_data']));
  });

  it('R-ISA-25: with AI_ISA_LIVE_SENDS true it says sending is allowed, and that each message still waits for the packs and the send-time checks', async () => {
    const r = await call<View>(ownerOn, 'GET', '/admin/integrations');
    expect(r.body.aiSending).toEqual({ live: true, sentence: AI_SENDING_ON });
    expect(AI_SENDING_ON).toMatch(/packs/);
  });

  it('R-ISA-25: an Admin sees the same line; roles without integration.view still get 404', async () => {
    const admin = await inviteViaApi(off, ownerOff, 'admin');
    expect((await call<View>(admin, 'GET', '/admin/integrations')).body.aiSending.live).toBe(false);
    const agent = await inviteViaApi(off, ownerOff, 'agent');
    expect((await call(agent, 'GET', '/admin/integrations')).status).toBe(404);
  });

  it('R-ISA-25: display only: integrations/** never writes the switch, and its routes are exactly the five it had (no new control)', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/aiIsaLiveSends\s*=[^=]|AI_ISA_LIVE_SENDS\s*=/);
    }
    const routes = readFileSync(join(dir, 'routes.ts'), 'utf8');
    const declared = [...routes.matchAll(/r\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]!}`).sort();
    expect(declared).toEqual(['GET /admin/integrations', 'GET /admin/integrations/:kind/callback', 'PATCH /admin/integrations/connections/:id', 'POST /admin/integrations/:kind/connect', 'POST /admin/integrations/connections/:id/disconnect'].sort());
  });
});

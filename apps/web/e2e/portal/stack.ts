// module 46 e2e: the real module 45 API (journeys/stack.ts: a fresh Postgres database, RLS-bound app_user, the real
// worker drained through /jobs, deterministic FAKE providers only) plus the portal's fixture routes:
//   /portal/world   {world}        Jane Doe (example.test email, fake phone) on agent0, her buy deal, a confirmed
//                                  milestone (module 31's route) and a clean, shared PDF (upload, fake scan, share)
//   /portal/clear   {cleared}      platform:portal cleared or withdrawn (superuser; the spec restores it)
//   /portal/link    {to, after}    drains comms.dispatch, waits up to 10 s for the post-reply delivery, and returns
//                                  the newest #token= link sent to `to` after `after` messages, and the notice bodies
//   /portal/publish {grantId, documentId}  the agent's POST /portal-items for the document (test only), then the jobs
//   /portal/isa     {world}        an ISA member of the world (client "<world>.isa")
// Nothing is sent to a real person: every email and text lands in the fakes.
import { type JourneyStack, startJourneyStack } from '../journeys/stack.js';

export interface PortalWorld {
  dealId: string;
  dealName: string;
  slug: string;
  jane: { id: string; email: string; phone: string; name: string };
  documentId: string;
  documentName: string;
  pdfBase64: string;
  milestoneOn: string;
}

export interface PortalStack extends JourneyStack {
  portalWorld(world?: string): Promise<PortalWorld>;
  setCleared(cleared: boolean): Promise<void>;
  link(to: string, after?: number): Promise<{ link: string | null; count: number; notices: string[] }>;
  publishDocument(grantId: string, documentId: string): Promise<void>;
  emailCount(to: string): Promise<number>;
}

const ROUTES = String.raw`
  async '/portal/world'(b) {
    const w = world(b.world);
    const agent = w.agents[0];
    const jane = await portalClient(agent, { firstName: 'Jane' });
    const dealId = await portalDeal(agent, jane.id);
    await portalMilestone(agent, dealId, '2026-12-18', 'inspection');
    const doc = await sharedDocument(h, w, agent, dealId, 'Purchase contract.pdf');
    const slug = await slugOf(h, w.tenantId);
    const d = must(await call(agent, 'GET', '/deals/' + dealId), 'deal');
    return { dealId, dealName: d.deal.name, slug, jane: { ...jane, name: d.deal.primaryContact.name }, documentId: doc.id, documentName: 'Purchase contract.pdf', pdfBase64: Buffer.from(doc.bytes).toString('base64'), milestoneOn: '2026-12-18' };
  },
  async '/portal/clear'(b) { await setPortalCleared(h, !!b.cleared); return { ok: true }; },
  async '/portal/count'(b) {
    return { count: h.providers.email.sent.filter((m) => m.to.toLowerCase() === String(b.to).toLowerCase()).length };
  },
  async '/portal/link'(b) {
    const to = String(b.to).toLowerCase();
    const deadline = Date.now() + 10000;
    for (;;) {
      await settlePortalSignins();
      await worker().drain(50);
      const mine = h.providers.email.sent.filter((m) => m.to.toLowerCase() === to);
      const fresh = mine.slice(b.after ?? 0);
      const withLink = fresh.map((m) => /https?:\/\/[^\s]+#token=[A-Za-z0-9_-]{43}/.exec(m.text ?? '')).filter(Boolean);
      if (withLink.length > 0 || Date.now() > deadline) {
        return { link: withLink.length ? withLink[withLink.length - 1][0] : null, count: mine.length, notices: fresh.map((m) => m.text ?? '') };
      }
      await new Promise((ok) => setTimeout(ok, 200));
    }
  },
  async '/portal/publish'(b) {
    const w = world(b.world);
    const r = await portalPublish(w.agents[0], 'document', b.documentId, [b.grantId]);
    if (r.status !== 200 || r.body.results[0].result !== 'published') throw new Error('publish: ' + JSON.stringify(r.body));
    await worker().drain(100);
    return { ok: true };
  },
  async '/portal/isa'(b) {
    const w = world(b.world);
    const isa = await h.invite(w.owner, 'isa');
    clients.set((b.world ?? 'a') + '.isa', isa);
    return { isa: who(isa) };
  },
`;

const IMPORTS = `import { setPortalCleared, slugOf, client as portalClient, deal as portalDeal, milestone as portalMilestone, sharedDocument, publish as portalPublish } from './src/portal/testing.ts';
import { settlePortalSignins } from './src/portal/signin/routes.ts';`;

export async function startPortalStack(): Promise<PortalStack> {
  const s = await startJourneyStack({ imports: IMPORTS, routes: ROUTES });
  return {
    ...s,
    portalWorld: (world = 'a') => s.fixture<PortalWorld>('/portal/world', { world }),
    setCleared: async (cleared) => void (await s.fixture('/portal/clear', { cleared })),
    link: (to, after = 0) => s.fixture('/portal/link', { to, after }),
    publishDocument: async (grantId, documentId) => void (await s.fixture('/portal/publish', { grantId, documentId })),
    emailCount: async (to) => (await s.fixture<{ count: number }>('/portal/count', { to })).count,
  };
}

/** The portal's address for a team (what the invite notice names). */
export const portalUrl = (stack: JourneyStack, slug: string) => `${stack.webUrl}/portal.html?team=${encodeURIComponent(slug)}`;

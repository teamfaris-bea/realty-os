// Module 48 item 2: the voice_answering built-in template (flagged edit of assistant/templates.ts, PLAN:306).
import { type IdentityFacts, type PlaybookKind, validatePlaybookContent } from '@realty/core/assistant';
import { approvedVoiceContent } from '@realty/core/voice';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AssistantWorld, assistantWorld, call } from '../assistant/testing.js';
import { templateByKey } from '../assistant/templates.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';

let h: ApiHarness;
let w: AssistantWorld;
beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
});
afterAll(async () => {
  await h?.close();
});

describe('R-VOICE-9 R-AST-4: the voice_answering template ships as a team draft', () => {
  it('R-AST-4 R-VOICE-8: the content validates cleanly against the tenant identity and names no listing-facts tool', async () => {
    const t = templateByKey('voice_answering')!;
    expect(t).toMatchObject({ kind: 'voice_answering', scope: 'team', name: 'AI answering for missed calls', steps: [] });
    expect(t.content).toMatchObject({ kind: 'voice', voice: { tools: ['book_appointment', 'take_message', 'transfer_to_owner'], maxCallSeconds: 300, transferHoldSeconds: 20 } });
    const identity: IdentityFacts = { brokerageLegalName: 'Harbor Realty LLC', teamName: 'Team abc', agentFirstName: null, scope: 'team', allowedLinkHosts: [], brokeragePostalAddress: null };
    expect(validatePlaybookContent(t.content, { kind: t.kind as PlaybookKind, identity })).toEqual([]);
    expect(approvedVoiceContent({ versionId: 'v' as never, kind: 'voice_answering', status: 'approved', content: t.content }, identity)).not.toBeNull();
  });

  it('R-AST-4: the Owner creates it by templateKey as a draft with no issues; an agent cannot create a team voice playbook', async () => {
    const c = await call<{ playbook: { kind: string; scope: string; approvedVersionId: string | null; versions: { status: string; issues: unknown[] }[] } }>(w.owner, 'POST', '/playbooks', { templateKey: 'voice_answering' });
    expect(c.status).toBe(201);
    expect(c.body.playbook).toMatchObject({ kind: 'voice_answering', scope: 'team', approvedVersionId: null });
    expect(c.body.playbook.versions.map((v) => [v.status, v.issues])).toEqual([['draft', []]]);
    // the POST /playbooks kind enum keeps voice_answering out of the body (templateKey only)
    expect((await call(w.owner, 'POST', '/playbooks', { kind: 'voice_answering', scope: 'team', steps: t().content })).status).toBe(422);
    expect((await call(w.agents[0]!, 'POST', '/playbooks', { templateKey: 'voice_answering' })).status).not.toBe(201);
  });

  it('R-NURT-1: GET /nurture/triggers lists trigger templates only (no voice entry)', async () => {
    const r = await call<{ templates: { key: string }[] }>(w.owner, 'GET', '/nurture/triggers');
    expect(r.status).toBe(200);
    expect(r.body.templates.map((x) => x.key)).not.toContain('voice_answering');
    expect(r.body.templates.map((x) => x.key)).toContain('behavior_alerts');
  });
});

const t = () => templateByKey('voice_answering')!;

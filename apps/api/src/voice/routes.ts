// api/voice routes (module 48; PHASE2_3_PLAN §5.4 #48). Mounted under /api. No webhook route: the telephony callbacks
// are comms/webhooks.ts's existing voice paths (R-TWL-3).
//
//   GET  /voice/answering            the honest state of AI answering                        settings.compliance (reading)
//   PUT  /voice/answering/settings   answer-after seconds and when (widening is a loosening)   settings.compliance
//   POST /voice/answering/enable     the Owner turns it on (re-auth + the exact attestation)    settings.compliance (loosening)
//   POST /voice/answering/disable    an Owner or Admin turns it off                             settings.compliance
//   GET  /calls/:id/voice            one call's AI session: takeover, outcome, ledger           self (calls RLS; else 404)
//   POST /voice/test-call            a scripted caller against the fake, in memory              settings.compliance (reading)
// Writes run as the user, so the DB role guards apply (R-VOICE-9). No response carries a tenant id or a confidence.
import type { PlaybookVersionId, UserActor } from '@realty/core/foundation';
import { approvedVoiceContent } from '@realty/core/voice';
import { SCRIPTS, type ScriptName, runScript, voiceFacts } from '@realty/core/voice/testing';
import { validatePlaybookContent, storedContent, VoiceContentSchema, type VoiceContent } from '@realty/core/assistant';
import { type Database, withTenantTx } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { actorOf, platformOf } from '../admin/common.js';
import { identityFacts } from '../assistant/repos/context.js';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { VOICE_ATTESTATION_TEXT, answeringView, disableAnswering, enableAnswering, settingsFacts, updateAnsweringSettings } from './answering.js';
import { OUTCOME_SENTENCES } from './handback.js';
import { AnsweringResponse, AnsweringSettingsBody, CallVoiceResponse, DisableBody, EnableBody, TestCallBody, TestCallResponse } from './schemas.js';
import { refusalSentence } from './takeover.js';
import { voiceDeps } from './runtime.js';

export const TEST_CALL_SENTENCE = 'Simulation with a scripted caller. No call was placed and nothing was saved.';

async function callVoice(actor: UserActor, db: Database, callId: string) {
  return withTenantTx(actor, async (tx) => {
    const r = await sql<{ id: string; handled_by: string; ai_takeover_at: Date | null; voice_outcome: string | null; transfer_outcome: string | null; handback_action_id: string | null; ended_at: Date | null; recording_decision: Record<string, unknown> }>`
      SELECT id, handled_by, ai_takeover_at, voice_outcome, transfer_outcome, handback_action_id, ended_at, recording_decision FROM calls
       WHERE tenant_id = app.tenant_id() AND id = ${callId}`.execute(tx);
    const c = r.rows[0];
    if (!c) throw new AppError('NOT_FOUND');
    const takeover = (c.recording_decision?.['voiceTakeover'] ?? null) as { code?: string | null } | null;
    const base = { callId: c.id, takeoverAt: c.ai_takeover_at?.toISOString() ?? null, transferOutcome: c.transfer_outcome, handbackId: c.handback_action_id };
    if (c.handled_by !== 'assistant') {
      return { ...base, state: 'not_answered' as const, sentence: refusalSentence(takeover?.code ?? null), outcome: null, outcomeSentence: null, endReason: null, ledger: [], unlogged: [] };
    }
    const ledger = (await sql<{ seq: number; tool: string; args: Record<string, string>; decision: 'allow' | 'deny'; reason_code: string; occurred_at: Date }>`
      SELECT seq, tool, args, decision, reason_code, occurred_at FROM voice_tool_calls WHERE tenant_id = app.tenant_id() AND call_id = ${c.id} ORDER BY seq`.execute(tx)).rows;
    const hb = c.handback_action_id ? (await sql<{ payload: Record<string, unknown> }>`SELECT payload FROM assistant_actions WHERE tenant_id = app.tenant_id() AND id = ${c.handback_action_id}`.execute(tx)).rows[0] : undefined;
    const voice = (hb?.payload['voice'] ?? null) as { endReason?: string; unlogged?: { seq: number; reason: string; at: string }[]; recovered?: boolean } | null;
    const state: 'in_progress' | 'recovered' | 'ended' = c.handback_action_id === null ? 'in_progress' : voice?.recovered ? 'recovered' : 'ended';
    const sentence = state === 'in_progress' ? 'The assistant is on this call now.' : state === 'recovered' ? 'The assistant lost this call; the handback was written afterwards.' : 'The assistant answered this call and handed it back.';
    return {
      ...base,
      state,
      sentence,
      outcome: c.voice_outcome,
      outcomeSentence: c.voice_outcome ? (OUTCOME_SENTENCES as Record<string, string>)[c.voice_outcome] ?? null : null,
      endReason: voice?.endReason ?? null,
      ledger: ledger.map((x) => ({ seq: x.seq, tool: x.tool, args: x.args, decision: x.decision, reasonCode: x.reason_code, occurredAt: x.occurred_at.toISOString() })),
      unlogged: voice?.unlogged ?? [],
    };
  }, { db });
}

async function testCall(actor: UserActor, deps: ReturnType<typeof voiceDeps>, i: { script: string; versionId?: string | undefined }) {
  const script = (SCRIPTS as Record<string, (typeof SCRIPTS)[ScriptName]>)[i.script];
  if (!script) throw new AppError('VALIDATION_FAILED', { reason: 'UNKNOWN_SCRIPT' });
  const picked = await withTenantTx(actor, async (tx): Promise<{ content: VoiceContent; versionId: string }> => {
    const identity = await identityFacts(tx, { scope: 'team', agentUserId: null });
    const r = await sql<{ id: string; status: string; steps: unknown; kind: string }>`
      SELECT v.id, v.status, v.steps, p.kind FROM playbook_versions v JOIN playbooks p ON p.tenant_id = v.tenant_id AND p.id = v.playbook_id
       WHERE v.tenant_id = app.tenant_id() AND p.kind = 'voice_answering' AND ${i.versionId ? sql`v.id = ${i.versionId}::uuid` : sql`v.status = 'approved'`}
       ORDER BY v.version_no DESC LIMIT 1`.execute(tx);
    const v = r.rows[0];
    if (!v) throw new AppError('NOT_FOUND');
    if (v.status === 'approved') {
      const c = approvedVoiceContent({ versionId: v.id as PlaybookVersionId, kind: v.kind, status: 'approved', content: v.steps }, identity);
      if (!c) throw new AppError('PLAYBOOK_INVALID', { issues: [{ code: 'VOICE_CONTENT' }] });
      return { content: c, versionId: v.id };
    }
    const issues = validatePlaybookContent(v.steps, { kind: 'voice_answering', identity });
    if (issues.length > 0) throw new AppError('PLAYBOOK_INVALID', { issues: issues.map((x) => ({ code: x.code })) });
    return { content: VoiceContentSchema.parse((storedContent(v.steps) as { voice: unknown }).voice), versionId: v.id };
  }, { db: deps.db });
  const run = runScript(script, voiceFacts({ content: picked.content }));
  const end = run.actions.find((a) => a.action.kind === 'end')?.action as Extract<(typeof run.actions)[number]['action'], { kind: 'end' }> | undefined;
  await withTenantTx(actor, (tx) => audit(tx, actor, { action: 'voice.test_call', entity: { type: 'playbook_version', id: picked.versionId }, reason: i.script }), { db: deps.db });
  return {
    sentence: TEST_CALL_SENTENCE,
    lines: run.actions.flatMap((a) => (a.action.kind === 'say' ? [{ source: a.action.source, text: a.action.text }] : [])),
    ledger: run.state.ledger.map((e) => ({ seq: e.seq, tool: e.row?.tool ?? null, decision: e.decision, reasonCode: e.reason })),
    handback: end
      ? { outcome: end.handback.outcome, endReason: end.handback.endReason, critical: end.handback.critical, messageTopics: [...end.handback.messageTopics], noPhoneCallback: end.handback.noPhoneCallback, confirmationChannel: end.handback.confirmationChannel }
      : { outcome: run.state.outcome ?? 'caller_ended', endReason: run.state.endReason ?? 'CALLER_HUNG_UP', critical: true, messageTopics: [], noPhoneCallback: false, confirmationChannel: null },
  };
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const deps = () => voiceDeps(app.platform);
  const reading = { config: { auth: 'settings.compliance' as const }, preHandler: authorize('settings.compliance', () => ({ loosening: false })) };

  r.get('/voice/answering', { ...reading, schema: { response: { 200: AnsweringResponse } } }, async (req) => answeringView(actorOf(req), deps()));

  r.put(
    '/voice/answering/settings',
    {
      config: { auth: 'settings.compliance' },
      preHandler: authorize('settings.compliance', (req) => {
        const b = req.body as z.infer<typeof AnsweringSettingsBody>;
        return settingsFacts(actorOf(req), voiceDeps(platformOf(req)), b, b.attestation);
      }),
      schema: { body: AnsweringSettingsBody, response: { 200: AnsweringResponse } },
    },
    async (req) => updateAnsweringSettings(actorOf(req), deps(), req.body),
  );

  r.post(
    '/voice/answering/enable',
    {
      config: { auth: 'settings.compliance' },
      preHandler: authorize('settings.compliance', (req) => ({ loosening: true, attested: (req.body as { attestation?: string }).attestation === VOICE_ATTESTATION_TEXT })),
      schema: { body: EnableBody, response: { 200: AnsweringResponse } },
    },
    async (req) => enableAnswering(actorOf(req), deps()),
  );

  r.post('/voice/answering/disable', { ...reading, schema: { body: DisableBody, response: { 200: AnsweringResponse } } }, async (req) => disableAnswering(actorOf(req), deps()));

  r.get('/calls/:id/voice', { config: { auth: 'self' }, schema: { params: z.object({ id: z.uuid() }), response: { 200: CallVoiceResponse } } }, async (req) => callVoice(actorOf(req), app.platform.db, req.params.id));

  r.post('/voice/test-call', { ...reading, schema: { body: TestCallBody, response: { 200: TestCallResponse } } }, async (req) => testCall(actorOf(req), deps(), req.body));
}

export const voiceRoutes: RouteModule = { name: 'voice', register };

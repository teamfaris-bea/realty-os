// SQL of the timing-cue scan and today's nudge list (b20; DATA_MODEL R-TCUE-1 to R-TCUE-8). Every query runs in the
// caller's transaction under row-level security: the scan as the tenant's system actor, the list as a human
// Owner or Admin. Note text is read only by `noteCandidates` (for the local model) and never written anywhere but
// the verified quote of a cue row.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface TimingSettings {
  zone: string;
  aiEnabled: boolean;
}

export async function timingSettings(tx: Tx): Promise<TimingSettings | null> {
  const r = await sql<{ zone: string; ai_enabled: boolean }>`SELECT default_timezone AS zone, ai_enabled FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const row = r.rows[0];
  return row ? { zone: row.zone, aiEnabled: row.ai_enabled } : null;
}

export interface NoteCandidate {
  id: string;
  body: string;
  /** exact text of notes.updated_at (microseconds kept): the version this read is of */
  updated_at: string;
  /** when the words were written: the logged activity's time, else the note's creation */
  written_at: Date;
}

/**
 * Notes about a live person written in the look-back that have no scan row yet, or whose scan read an older
 * version (an edited note is read again). Newest words first, so each night's new notes go before any backfill.
 */
export async function noteCandidates(tx: Tx, o: { lookbackDays: number; limit: number }): Promise<NoteCandidate[]> {
  const r = await sql<NoteCandidate>`
    SELECT n.id, n.body, n.updated_at::text AS updated_at, COALESCE(n.activity_at, n.created_at) AS written_at
      FROM notes n
      JOIN contacts c ON c.tenant_id = n.tenant_id AND c.id = n.contact_id
      LEFT JOIN timing_cues t ON t.tenant_id = n.tenant_id AND t.note_id = n.id
     WHERE n.tenant_id = app.tenant_id()
       AND n.contact_id IS NOT NULL
       AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
       AND COALESCE(n.activity_at, n.created_at) >= now() - make_interval(days => ${o.lookbackDays})
       AND (t.note_id IS NULL OR t.note_updated_at < n.updated_at)
     ORDER BY COALESCE(n.activity_at, n.created_at) DESC, n.id
     LIMIT ${o.limit}`.execute(tx);
  return r.rows;
}

export interface ScanRow {
  id: string;
  noteId: string;
  noteUpdatedAt: string;
  writtenAt: Date;
  outcome: string;
  cue: null | {
    evidence: string;
    intent: string;
    timeframe: string;
    snippet: string;
    windowStart: string;
    windowEnd: string;
    windowPrecision: string;
    windowBasis: string;
    windowLabel: string;
    confidence: number;
  };
  model: string | null;
  promptVersion: string | null;
}

/**
 * Records one read of one note version. Written only when the note is still that version (a note edited or deleted
 * while the model ran is left for the next run); a second read of the same version changes nothing (idempotent),
 * and an older read never replaces a newer one. Returns whether a row was written.
 */
export async function recordScan(tx: Tx, s: ScanRow): Promise<boolean> {
  const c = s.cue;
  const r = await sql`
    INSERT INTO timing_cues (tenant_id, id, note_id, note_updated_at, written_at, scanned_at, outcome, evidence, intent, timeframe, cue_snippet,
                             window_start, window_end, window_precision, window_basis, window_label, confidence, model, prompt_version)
    SELECT n.tenant_id, ${s.id}::uuid, n.id, n.updated_at, ${s.writtenAt}, now(), ${s.outcome}, ${c?.evidence ?? null}, ${c?.intent ?? null}, ${c?.timeframe ?? null},
           ${c?.snippet ?? null}, ${c?.windowStart ?? null}::date, ${c?.windowEnd ?? null}::date, ${c?.windowPrecision ?? null}, ${c?.windowBasis ?? null},
           ${c?.windowLabel ?? null}, ${c?.confidence ?? null}, ${s.model}, ${s.promptVersion}
      FROM notes n
     WHERE n.tenant_id = app.tenant_id() AND n.id = ${s.noteId}::uuid AND n.updated_at = ${s.noteUpdatedAt}::timestamptz
    ON CONFLICT (tenant_id, note_id) DO UPDATE SET
           note_updated_at = EXCLUDED.note_updated_at, written_at = EXCLUDED.written_at, scanned_at = EXCLUDED.scanned_at, outcome = EXCLUDED.outcome,
           evidence = EXCLUDED.evidence, intent = EXCLUDED.intent, timeframe = EXCLUDED.timeframe, cue_snippet = EXCLUDED.cue_snippet,
           window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end, window_precision = EXCLUDED.window_precision,
           window_basis = EXCLUDED.window_basis, window_label = EXCLUDED.window_label, confidence = EXCLUDED.confidence,
           model = EXCLUDED.model, prompt_version = EXCLUDED.prompt_version, updated_at = now()
     WHERE timing_cues.note_updated_at < EXCLUDED.note_updated_at`.execute(tx);
  return Number(r.numAffectedRows ?? 0) > 0;
}

export interface NudgeRow {
  note_id: string;
  written_at: Date;
  evidence: string;
  intent: string;
  cue_snippet: string;
  window_start: string;
  window_end: string;
  window_label: string;
  window_precision: string;
  contact_id: string;
  first_name: string | null;
  stage: string;
  owner_user_id: string | null;
  owner_name: string | null;
  do_not_contact: boolean;
  last_human_touch_at: Date | null;
  later_transaction: boolean;
}

/**
 * Every cue row the reader may see, with the person's facts the list needs: first name only, stage, owner,
 * do-not-contact, last human touch (R-OWN-14: notes, drafts, assistant, automated and bulk mail never count), and
 * whether a deal reached listed / under contract / closed AFTER the words were written.
 */
export async function nudgeRows(tx: Tx): Promise<NudgeRow[]> {
  const r = await sql<NudgeRow>`
    SELECT t.note_id, t.written_at, t.evidence, t.intent, t.cue_snippet, t.window_start::text AS window_start, t.window_end::text AS window_end,
           t.window_label, t.window_precision, c.id AS contact_id, c.first_name, c.stage, c.owner_user_id, u.display_name AS owner_name,
           (c.do_not_contact_at IS NOT NULL) AS do_not_contact, c.last_human_touch_at,
           EXISTS (SELECT 1 FROM deals d
                    WHERE d.tenant_id = c.tenant_id
                      AND (d.primary_contact_id = c.id
                           OR EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id AND dc.contact_id = c.id))
                      AND (d.stage IN ('under_contract', 'closed') OR (d.side IN ('sell', 'dual') AND d.stage = 'active'))
                      AND d.stage_entered_at >= t.written_at) AS later_transaction
      FROM timing_cues t
      JOIN notes n ON n.tenant_id = t.tenant_id AND n.id = t.note_id
      JOIN contacts c ON c.tenant_id = n.tenant_id AND c.id = n.contact_id
      LEFT JOIN memberships m ON m.tenant_id = c.tenant_id AND m.user_id = c.owner_user_id
      LEFT JOIN users u ON u.id = m.user_id
     WHERE t.tenant_id = app.tenant_id() AND t.outcome = 'cue'
       AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL`.execute(tx);
  return r.rows;
}

export interface ContactCueRow {
  note_id: string;
  written_at: Date;
  evidence: string;
  intent: string;
  cue_snippet: string;
  window_start: string;
  window_end: string;
  model: string;
  prompt_version: string;
}

/**
 * The accepted cues of ONE person the caller can read, newest words first: the read a per-lead consumer (the lead
 * copilot's `TimingCueSource.cuesFor`) adapts. Row-level security scopes it to notes the caller may read.
 */
export async function cuesForContact(tx: Tx, contactId: string): Promise<ContactCueRow[]> {
  const r = await sql<ContactCueRow>`
    SELECT t.note_id, t.written_at, t.evidence, t.intent, t.cue_snippet, t.window_start::text AS window_start, t.window_end::text AS window_end,
           t.model, t.prompt_version
      FROM timing_cues t
      JOIN notes n ON n.tenant_id = t.tenant_id AND n.id = t.note_id
     WHERE t.tenant_id = app.tenant_id() AND t.outcome = 'cue' AND n.contact_id = ${contactId}::uuid
     ORDER BY t.written_at DESC, t.note_id`.execute(tx);
  return r.rows;
}

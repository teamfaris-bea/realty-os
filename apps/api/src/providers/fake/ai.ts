// Deterministic AI fake (ARCHITECTURE §7). It reads the prompt core.assistant.buildPrompt produced
// and answers with the JSON output contract:
//   - one claim whose evidence snippet is copied word for word from the first source (verifies), and
//   - one claim with a DELIBERATELY BAD quote (words that appear in no source), so evidence
//     verification (R-AST-1, E33) is exercised on every run,
//   - plus a short draft for `draft` / `first_response`, ending with the sign-off the system prompt
//     asks for.
// Same prompt ⇒ same output. It never calls the network.
import { createHash } from 'node:crypto';
import type { AiProvider, AiRequest, AiResponse } from '../types.js';

interface FakeSource {
  handle: string;
  kind: 'text' | 'transcript' | 'fields';
  text: string;
  startMs?: number;
  endMs?: number;
  field?: string;
}

export const FAKE_BAD_QUOTE = 'already pre-approved for nine hundred thousand';

/** Pulls the `[S<n>]` sources out of the prompt's user text. */
export function parseFakeSources(user: string): FakeSource[] {
  const lines = user.split('\n');
  const out: FakeSource[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[(S\d+)\]\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const handle = m[1]!;
    const rest = m[2]!;
    const next = lines[i + 1] ?? '';
    if (/^<untrusted_[0-9a-f]+>$/.test(next)) {
      const body: string[] = [];
      let j = i + 2;
      while (j < lines.length && !/^<\/untrusted_[0-9a-f]+>$/.test(lines[j]!)) body.push(lines[j++]!);
      const seg = /^\[(\d+)-(\d+)ms\]\s*[^:]*:\s*(.*)$/.exec(body[0] ?? '');
      if (rest.startsWith('CALL') && seg) out.push({ handle, kind: 'transcript', text: seg[3]!, startMs: Number(seg[1]), endMs: Number(seg[2]) });
      else if (/^(?:DEAL|LISTING|ACTIVITY)\b/.test(rest)) out.push({ handle, kind: 'fields', text: body.join(' '), field: rest.startsWith('DEAL') ? 'stage' : 'status' });
      else out.push({ handle, kind: 'text', text: body.join('\n') });
      i = j;
    } else if (/^[^:]*:\s*\S/.test(rest) && !/^stage:/.test(rest)) {
      // agent notes / outbound messages: "[S3] <when>: body"  or  "[S2] <when> agent (sms):" + next line
      const idx = rest.indexOf(': ');
      out.push({ handle, kind: 'text', text: idx >= 0 ? rest.slice(idx + 2) : rest });
    } else if (rest.endsWith(':') && next.trim() !== '') {
      out.push({ handle, kind: 'text', text: next });
    } else {
      out.push({ handle, kind: 'fields', text: rest, field: rest.startsWith('stage:') ? 'stage' : 'status' });
    }
  }
  return out;
}

function firstWords(s: string, n: number): string {
  return s.trim().split(/\s+/).slice(0, n).join(' ');
}

function locator(s: FakeSource): Record<string, unknown> {
  if (s.kind === 'transcript') return { kind: 'transcript_offset', start_ms: s.startMs, end_ms: s.endMs };
  if (s.kind === 'fields') return { kind: 'field', name: s.field ?? 'status' };
  return { kind: 'message' };
}

export class FakeAi implements AiProvider {
  readonly calls: AiRequest[] = [];
  /** test hook: force the next responses (e.g. a refusal or malformed JSON) */
  readonly scripted: Partial<AiResponse>[] = [];

  async complete(r: AiRequest): Promise<AiResponse> {
    this.calls.push(r);
    const forced = this.scripted.shift();
    const text = forced?.text ?? this.answer(r);
    return {
      text,
      model: 'fake-assistant-1',
      stopReason: forced?.stopReason ?? 'end_turn',
      inputTokens: Math.ceil((r.system.length + r.user.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
    };
  }

  private answer(r: AiRequest): string {
    if (r.templateKey === 'coaching.call_review') return fakeCallReview(r.user);
    const purpose = r.templateKey.replace(/^assistant\./, '');
    const sources = parseFakeSources(r.user);
    // the sign-off is in the server-written <request> block of the user turn (assistant-prompts/2)
    const signOff = /end with "([^"]+)"/.exec(r.user)?.[1] ?? /end with "([^"]+)"/.exec(r.system)?.[1] ?? '';
    const first = sources.find((s) => s.kind !== 'fields' && s.text.trim() !== '') ?? sources[0];
    const claims: unknown[] = [];
    if (first) {
      const snippet = firstWords(first.text, 8);
      claims.push({
        kind: first.kind === 'transcript' ? 'commitment' : 'client_statement',
        text: `They said: "${snippet}"`.slice(0, 300),
        needs_review: false,
        evidence: [{ source: first.handle, locator: locator(first), snippet }],
      });
      claims.push({
        kind: 'qualification',
        text: 'They may already have financing lined up.',
        needs_review: false,
        evidence: [{ source: first.handle, locator: locator(first), snippet: FAKE_BAD_QUOTE }],
      });
    }
    const digest = createHash('sha256').update(r.user).digest('hex').slice(0, 6);
    const out: Record<string, unknown> = {
      explanation: first ? 'Based on their latest message.' : 'There is not much to go on yet.',
      claims,
    };
    if (purpose === 'draft' || purpose === 'first_response') {
      const body =
        purpose === 'first_response'
          ? 'Thanks for reaching out! What timeline are you working with, and have you talked with a lender yet?'
          : 'Thanks for the note. Does tomorrow afternoon work for a quick call?';
      out.draft = { channel: 'sms', body: signOff ? `${body} ${signOff}` : body };
    }
    out.explanation = `${String(out.explanation)} (ref ${digest})`;
    return JSON.stringify(out);
  }
}

// ---- module 36: the call review (template coaching.call_review) -------------------------------------
// Deterministic: for each checklist key in the prompt, the first AGENT line that matches the item's words
// is quoted word for word as "met"; otherwise the item is "missed", quoting the agent's last line. The
// recap item, when missed, quotes words that are not in the call (FAKE_BAD_REVIEW_QUOTE), so quote
// verification (R-COACH-2, E105) is exercised on every review that misses it.
export const FAKE_BAD_REVIEW_QUOTE = 'so to recap we agreed on everything today';
const REVIEW_WORDS: Record<string, RegExp> = {
  introduced_self: /\b(this is|my name is)\b/i,
  asked_timeline: /\b(when|timeline|moved in|move by)\b/i,
  asked_financing: /\b(lender|pre-?approv|financ|mortgage)/i,
  asked_motivation: /\b(what has you|prompting|thinking about a move|why are you)\b/i,
  confirmed_contact_preference: /\b(text or|call or|email or|prefer)\b/i,
  proposed_next_step: /\bwould .{1,40} work\b/i,
  set_follow_up: /\b(see you|i will text you|i'll text you|reminder|confirmed for)\b/i,
  recapped_call: /\b(to recap|to summari[sz]e)\b/i,
};

function fakeCallReview(user: string): string {
  const keys = [...user.matchAll(/^- ([a-z_]+):/gm)].map((m) => m[1]!);
  const lines = [...user.matchAll(/^\[(S\d+)\] \[\d+-\d+ms\] (agent|lead|speaker): (.*)$/gm)].map((m) => ({ handle: m[1]!, speaker: m[2]!, text: m[3]! }));
  const agent = lines.filter((l) => l.speaker === 'agent');
  const last = agent[agent.length - 1];
  const items = keys.map((key) => {
    const re = REVIEW_WORDS[key];
    const hit = re ? agent.find((l) => re.test(l.text)) : undefined;
    if (hit) return { key, status: 'met', evidence: [{ source: hit.handle, snippet: hit.text }] };
    if (!last) return { key, status: 'not_applicable', evidence: [] };
    if (key === 'recapped_call') return { key, status: 'missed', evidence: [{ source: last.handle, snippet: FAKE_BAD_REVIEW_QUOTE }] };
    return { key, status: 'missed', evidence: [{ source: last.handle, snippet: last.text }] };
  });
  return JSON.stringify({ items });
}

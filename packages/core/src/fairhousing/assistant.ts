// The assistant and voice side of the fair-housing pack (R-FH-2, R-FH-3).
//
// - `guardAssistantOutput`: assistant text (a playbook step, a trigger alert, a draft, a voice turn)
//   with any hard or soft match is never autonomous; it becomes a draft flagged "Check this".
//   core/assistant's content guard calls it (module 25) and core/voice's turn guard will (47).
// - `detectAreaQuestion` / `areaQuestionPolicy`: when a client or caller asks who lives in an area,
//   whether it is safe, or what "kind of people" are there, the assistant does not answer; it hands
//   back to the agent with a neutral note. The client line it may use says only that.
// VERIFY WITH COUNSEL (C3): wording of the neutral client line.
import { check, compilePattern, findSpans } from './check.js';
import { tokenize } from './normalize.js';
import type { FairHousingPack, Match } from './types.js';

export interface AssistantFairHousingResult {
  /** False when any hard or soft match remains (R-FH-2). */
  autonomousAllowed: boolean;
  /** The draft carries the "Check this" flag. */
  checkThis: boolean;
  hard: Match[];
  soft: Match[];
}

export function guardAssistantOutput(text: string, pack: FairHousingPack): AssistantFairHousingResult {
  const r = check(text, pack);
  const any = r.hard.length > 0 || r.soft.length > 0;
  return { autonomousAllowed: !any, checkThis: any, hard: r.hard, soft: r.soft };
}

export type AreaQuestionTopic = 'who_lives_there' | 'safety' | 'kind_of_people';

const AREA_TERMS: readonly { topic: AreaQuestionTopic; patterns: readonly string[] }[] = [
  {
    topic: 'kind_of_people',
    patterns: [
      'kind|type|sort|class of people|neighbors|neighbours|crowd|residents|folks|families|community',
      'people like me|us',
      'fit in',
      'the right people|crowd',
    ],
  },
  {
    topic: 'safety',
    patterns: [
      'is it|area|neighborhood|neighbourhood|street|that|this a|an|the? safe|safer',
      'how safe',
      'safe area|neighborhood|neighbourhood|street|place|block|community',
      'safe to walk',
      'safe at night',
      'crime*',
      'dangerous',
      'sketchy',
      'shady',
      'bad|rough|ghetto area|neighborhood|neighbourhood|part',
      'break ins',
      'breakins',
    ],
  },
  {
    topic: 'who_lives_there',
    patterns: [
      'who lives',
      'who live',
      'demographic*',
      'diverse',
      'diversity',
      'ethnic*',
      'racial*',
      'mostly white|black|hispanic|latino|asian|jewish|christian|muslim|immigrants|families|retirees|seniors|young|old|students',
      'lot|lots|many|plenty of families|kids|children|retirees|seniors|immigrants|minorities|students|young|singles|couples',
      'any families|kids|children|retirees|seniors|immigrants|minorities',
      'what are the neighbors|neighbours like',
      'religious',
    ],
  },
];
const AREA_COMPILED = AREA_TERMS.map((t) => ({ topic: t.topic, patterns: t.patterns.map(compilePattern) }));

/** What a client or caller asked that the assistant must not answer (R-FH-3), or null. */
export function detectAreaQuestion(text: string): { topic: AreaQuestionTopic; text: string } | null {
  const tokens = tokenize(text);
  for (const t of AREA_COMPILED) {
    for (const p of t.patterns) {
      const span = findSpans(tokens, p)[0];
      if (span !== undefined) {
        const start = (tokens[span[0]] as { start: number }).start;
        const end = (tokens[span[1]] as { end: number }).end;
        return { topic: t.topic, text: text.slice(start, end) };
      }
    }
  }
  return null;
}

const TOPIC_WORDS: Readonly<Record<AreaQuestionTopic, string>> = {
  who_lives_there: 'who lives in the area',
  safety: 'how safe the area is',
  kind_of_people: 'what kind of people live there',
};

/** The neutral line the assistant may say or send instead of an answer. */
export const AREA_QUESTION_CLIENT_REPLY =
  "I can't describe who lives in an area or how safe it is. Your agent can point you to public sources so you can decide for yourself.";

export type AreaQuestionPolicy =
  | { action: 'continue' }
  | { action: 'handback'; topic: AreaQuestionTopic; quoted: string; clientReply: string; agentNote: string };

/**
 * R-FH-3: given what the client or caller said, either the assistant may go on, or it hands back
 * with a neutral note (it never answers, even with a "safe" answer).
 */
export function areaQuestionPolicy(inbound: string): AreaQuestionPolicy {
  const q = detectAreaQuestion(inbound);
  if (q === null) return { action: 'continue' };
  return {
    action: 'handback',
    topic: q.topic,
    quoted: q.text,
    clientReply: AREA_QUESTION_CLIENT_REPLY,
    agentNote: `Fair housing: they asked about ${TOPIC_WORDS[q.topic]} ("${q.text}"). The assistant did not answer and handed this to you. Point them to objective public sources rather than describing the area or its people.`,
  };
}

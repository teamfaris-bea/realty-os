// The cheap prefilter in front of the model (timing cues; DATA_MODEL R-TCUE-2). A port of the notes pilot's v2
// filter, which held 95% precision on 90 days of real notes: a source reaches the model only when it has timing
// words AND is not a playbook / sequence / mail-merge template AND is not a short agent self-reminder. Intake form
// notes with a filled timeline field always go through. Pure and deterministic.

const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const SEASON = String.raw`(?:spring|summer|fall|autumn|winter)`;
const NUM = String.raw`(?:\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?:\s+of)?|few)`;

const CUE_PARTS = [
  String.raw`leases?(?:\s+(?:is|ends?|up|expires|expiration|renewal))?`,
  String.raw`pcs(?:'d|d|ing)?`,
  String.raw`permanent\s+change\s+of\s+station`,
  String.raw`orders`,
  String.raw`deploy(?:ment)?`,
  String.raw`tdy`,
  String.raw`holidays?`,
  String.raw`christmas`,
  String.raw`thanksgiving`,
  String.raw`new\s+year(?:'s)?`,
  String.raw`next\s+(?:year|summer|spring|fall|winter|month|season)`,
  String.raw`after\s+(?:the\s+)?(?:new\s+year|christmas|thanksgiving|holidays?|school|baby|closing|pcs|deployment|lease)`,
  String.raw`when\s+(?:my|the|we|our|i)\s+(?:lease|orders|tour|pcs|deployment)`,
  String.raw`${MONTH}\s+20\d\d`,
  String.raw`in\s+(?:the\s+)?(?:${SEASON}|january|february|march|april|may|june|july|august|september|october|november|december)`,
  String.raw`(?:this|next|coming)\s+${SEASON}`,
  String.raw`(?:by|until|til|till|around|before|after)\s+(?:the\s+)?(?:${SEASON}|holidays?|new\s+year|christmas|thanksgiving)`,
  String.raw`in\s+\d+\s+(?:months?|years?)`,
  String.raw`${NUM}\s+(?:months?|years?)`,
  String.raw`\d+\s*-\s*\d+\s+(?:months?|years?)`,
  String.raw`not\s+ready\s+(?:until|till|for)`,
  String.raw`end\s+of\s+(?:the\s+)?(?:year|month|lease|tour|contract)`,
  String.raw`time\s*frame`,
  String.raw`timeline`,
  String.raw`when\s+we\s+(?:move|relocate|pcs)`,
  String.raw`relocat(?:ing|ion)`,
  String.raw`get(?:ting)?\s+orders`,
  String.raw`tour(?:\s+ends|\s+is\s+up)?`,
  String.raw`ets`,
  String.raw`contract\s+ends`,
  String.raw`(?:early|mid|late)\s*-?\s*20\d\d`,
];
/** Timing words (case-insensitive, whole words). */
export const TIMING_CUE_RE = new RegExp(String.raw`\b(?:${CUE_PARTS.join('|')})\b`, 'i');

const BOILER_PARTS = [
  String.raw`\bday\s*\d+\s*[—\-–:]?\s*(?:call|text|email|touch)`,
  String.raw`\btouch\s*\d+\b`,
  String.raw`\bactive\s+duty\s+client\b`,
  String.raw`\b2[\s-]?year\s+mark\b`,
  String.raw`this\s+should\s+feel\s+like\s+a\s+personal\s+check-in`,
  String.raw`\bnow\s*[—\-–]\s*call\b`,
  String.raw`your\s+internal\s+note\s+should\s+be`,
  String.raw`\bif\s+(?:he|she|they)\s+engages?:`,
  String.raw`\bkey\s+questions:`,
  String.raw`\bcommunication\s+rule\b`,
  String.raw`\bplan\s+start:`,
  String.raw`\[(?:first\s+)?name\]`,
  String.raw`\b(?:hi|hey)\s+\[`,
  String.raw`\{\{\s*\w+\s*\}\}`,
  String.raw`\bbuyer\s*\+\s*potential\s+seller\s+plan\b`,
  String.raw`\blong-term\s+nurture\b`,
  String.raw`\bhouse\s+set\s+up\s+as\s+a\s+rental\b`,
];
/** Strong playbook / sequence / script / mail-merge markers. */
export const BOILERPLATE_RE = new RegExp(BOILER_PARTS.join('|'), 'i');

/** A short standalone agent self-reminder: a task for the agent, not the client's timing. */
export const REMINDER_RE = new RegExp(
  String.raw`^\s*(?:call\s+in\s+(?:the\s+)?new\s+year|call\s+after\s+(?:the\s+)?holidays|(?:call|text|email|follow\s*up|f\/?u)\s+(?:in|next)\s+(?:a\s+)?(?:week|month|year|january|february|march|april|may|june|july|august|september|october|november|december)|fu\s+in\s+).*$`,
  'i',
);

/** An intake form note with a FILLED timeline field ("Move timeline: 0-3 months"). An empty or unsure field is not. */
export const FORM_FIELD_RE = /\b(?:move\s+timeline|time\s*frame|timeline|when\s+are\s+you\s+looking(?:\s+to\s+(?:buy|sell|move))?)\s*:\s*(?!\s*(?:unknown|not\s+sure|unsure|none|n\/a|-|\?)\s*(?:$|\n))\S/i;

/** Plain text of a note that may hold HTML (imported notes): tags out, common entities decoded, spaces collapsed. */
export function plainText(s: string): string {
  return s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type PrefilterResult =
  | { keep: true; kind: 'form' | 'text'; match: string }
  | { keep: false; outcome: 'no_timing' | 'boilerplate' | 'reminder_only' };

/**
 * Decides whether a source's words go to the model. The order is the pilot's: no timing words → drop; a filled
 * form timeline → keep; playbook / template → drop; a short self-reminder → drop; else keep.
 */
export function prefilter(text: string): PrefilterResult {
  const t = plainText(text);
  const form = FORM_FIELD_RE.exec(t);
  const m = TIMING_CUE_RE.exec(t);
  if (!m && !form) return { keep: false, outcome: 'no_timing' };
  if (form && t.length < 2000) return { keep: true, kind: 'form', match: form[0].slice(0, 80) };
  if (isBoilerplate(t)) return { keep: false, outcome: 'boilerplate' };
  const compact = t.replace(/\s+/g, ' ').trim();
  if (compact.length <= 80 && REMINDER_RE.test(compact)) return { keep: false, outcome: 'reminder_only' };
  return { keep: true, kind: 'text', match: (m ?? form)![0].slice(0, 80) };
}

function isBoilerplate(t: string): boolean {
  if (BOILERPLATE_RE.test(t)) return true;
  // long notes that look like a multi-touch sequence without one strong marker
  if (t.length < 2500) return false;
  let markers = 0;
  if (/\bday\s+\d+\b/i.test(t)) markers++;
  if ((t.toLowerCase().match(/\n(?:email|text|call)\b/g) ?? []).length >= 2) markers++;
  if (/\bsubject:/i.test(t)) markers++;
  if ((t.match(/\[/g) ?? []).length >= 3) markers++;
  if (/if\s+(?:they|he|she|the\s+client)\s+engages/i.test(t)) markers++;
  return markers >= 2;
}

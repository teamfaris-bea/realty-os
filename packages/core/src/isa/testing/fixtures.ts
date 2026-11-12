// Test fixtures of core/isa. Fictional names only (the repository is public).
import { classifyInbound, type InboundClassification, type Keywords } from '../../compliance/index.js';
import type { IdentityFacts } from '../../assistant/index.js';
import { type Instant, at, zone } from '../../foundation/index.js';
import { DEFAULT_AI_ISA_CONTENT, type AiIsaContent } from '../content.js';
import type { LineIdentity } from '../lines.js';
import type { IsaFacts, IsaInbound } from '../machine.js';
import type { Decision } from '../output.js';

export const NY = zone('America/New_York');
export const LA = zone('America/Los_Angeles');
export const CHI = zone('America/Chicago');
/** Thu 2026-11-12 15:00 UTC = 10:00 ET. */
export const NOW: Instant = at('2026-11-12T15:00:00Z');

export const WHO: LineIdentity = { agentFirstName: 'Avery', teamName: 'Maple Team', brokerageName: 'Example Realty LLC' };
export const IDENTITY: IdentityFacts = { brokerageLegalName: 'Example Realty LLC', teamName: 'Maple Team', agentFirstName: 'Avery', scope: 'agent', allowedLinkHosts: ['example.test'], brokeragePostalAddress: '1 Main St, Springfield' };

export const KEYWORDS: Keywords = { optOut: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'], resubscribe: ['START', 'UNSTOP'], help: ['HELP', 'INFO'] };

export function classify(text: string): InboundClassification {
  return classifyInbound(text, KEYWORDS, 'sms');
}

export const CONTENT: AiIsaContent = {
  ...DEFAULT_AI_ISA_CONTENT,
  capabilities: ['converse', 'share_listings', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'book_appointments'],
};

export function facts(o: Partial<IsaFacts> = {}): IsaFacts {
  return { who: WHO, content: CONTENT, windowOpenNow: true, teamTexts: [], recentInboundCount: 1, zone: NY, mlsListedElsewhere: false, subjectConfirmed: false, ...o };
}

let seq = 0;
export function inbound(text: string, o: Partial<IsaInbound> = {}): IsaInbound {
  seq += 1;
  return { seq: o.seq ?? seq, messageId: o.messageId ?? `m${seq}`, channel: 'sms', at: o.at ?? NOW, ownText: text, ownTextReliable: true, classification: classify(text), reaction: false, ...o };
}

export function emptyDecision(o: Partial<Decision> = {}): Decision {
  return {
    reply: null,
    replyBlocked: null,
    claims: [],
    unusableClaims: [],
    shareListings: null,
    shareCompetition: null,
    sendComps: false,
    proposeSavedSearch: false,
    offerSlots: null,
    bookSlot: null,
    slotAmbiguous: false,
    escalations: [],
    ready: null,
    followUp: null,
    endProposal: null,
    summary: null,
    denied: [],
    ...o,
  };
}

/**
 * Lexicon fixtures (§13.1): per class, phrases that MUST escalate, NEGATED phrases that must not, and statements
 * that must not. Every B3 and S3 field phrase is in MUST_NOT_ESCALATE.
 */
export const MUST_ESCALATE: Readonly<Record<string, readonly string[]>> = {
  possible_opt_out: ['you text too much', 'Too many texts honestly', 'how do I unsubscribe from this', 'this is spam'],
  safety: ['I want to kill myself', 'someone is breaking in right now', 'I will hurt you'],
  fraud_risk: ['Can I wire the deposit today?', 'please send the deposit to this new account', 'the title company sent new wiring instructions', 'my routing number is below'],
  consent_dispute: ['how did you get my number?', 'I never signed up for this', 'who gave you my email'],
  privacy_request: ['please delete my data', 'what do you have on me', 'what information do you have about me?'],
  ai_declined: ["I don't want to text a bot", 'no bots please', 'I am not talking to an AI'],
  complaint: ['I want to file a complaint', "I'll leave a bad review", 'this is unprofessional'],
  human_request: ['I want to talk to a real person', 'have Avery call me', 'can someone call me tomorrow', 'AGENT', 'please call me'],
  fair_housing: ['Is it safe? Who lives there?', 'what kind of people live in that area'],
  legal_contract: ['can you review the listing agreement?', 'what does the inspection contingency mean?', 'should I get an attorney?'],
  third_party: ['this is her husband', "I'm replying for my mother"],
  other_agent: ['we already listed with another brokerage', 'my agent is handling it', "we're working with a realtor"],
  pricing_negotiation: ["what's my home worth?", 'What should I list at?', 'Would they take 20 less?', 'should we make an offer?', 'what is your commission?'],
  financial: ['What rate can we get?', 'how much can we afford', 'do you know a good lender?', 'how much should we put down?'],
  sensitive_personal: ["we're going through a divorce", 'my mother passed away', 'facing foreclosure', 'I just got military orders'],
  language: ['Hola, quiero vender mi casa por favor', 'Bonjour, je veux acheter une maison'],
};

export const NEGATED: Readonly<Record<string, readonly string[]>> = {
  human_request: ['please don\'t call me', 'do not call me, text only', "don't have anyone call me"],
  other_agent: ["I'm not working with a realtor yet", "we don't have an agent", 'not working with an agent'],
  possible_opt_out: ["this isn't spam right?", "don't leave me alone, I want updates"],
  complaint: ['no complaints at all'],
  privacy_request: ["don't delete my info, I'm still looking"],
  safety: ["I'm not in danger, just asking"],
  legal_contract: ["we don't need an attorney, thanks"],
  financial: ["we don't need a lender, we're paying cash"],
  pricing_negotiation: ["I'm not asking what it's worth, just curious about the area"],
  ai_declined: ["I don't hate bots, this is fine"],
};

/**
 * Classes whose lexicon is deliberately NOT negation-aware (the pattern carries its own negation, or any mention must
 * reach a person): fraud_risk ("we don't need to wire anything" still warns), consent_dispute, third_party,
 * sensitive_personal. Listed so the choice is explicit and reviewed (VERIFY WITH COUNSEL).
 */
export const NON_NEGATABLE_BY_DESIGN: readonly string[] = ['fraud_risk', 'consent_dispute', 'third_party', 'sensitive_personal'];

/** Statements that must never escalate (every B3 and S3 field phrase included, E504, E507). */
export const MUST_NOT_ESCALATE: readonly string[] = [
  'Our budget is around 450k',
  "We're preapproved",
  "we're pre-approved with a lender",
  'talking to a lender',
  '50k for a down payment',
  'we are paying cash',
  'we want to move in the next 2 months',
  'looking in Springfield or 62701',
  'we need 3 bedrooms and 2 baths',
  'a townhouse would be great',
  'What do you offer?',
  "we're not preapproved yet",
  'thinking of selling by March',
  'we own the house outright',
  "it's not listed with anyone",
  'we own our home and want to sell in 60 days',
  'hi, still looking!',
  'Tuesday works',
  'thanks!',
  'sounds good',
];

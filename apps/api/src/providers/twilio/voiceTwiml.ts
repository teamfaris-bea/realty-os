// TwiML for INBOUND calls (pure builders; comms/voice.ts decides what to say and whom to ring).
//
//   ring       [announcement] → <Dial callerId=team number timeout=N action=dial-result answerOnBridge>
//              <Number url=screen>agent phone</Number></Dial>. The caller keeps hearing ringback until the
//              agent accepts (answerOnBridge). When recording is allowed the Dial records from the bridge.
//   screen     the AGENT leg's whisper (<Number url>): "press 1 to answer". Only a key press bridges the
//              call, so an agent's own phone voicemail picking up never swallows the client's call: no key,
//              no bridge, and the dial result sends the caller to OUR voicemail. VERIFY on a live call that
//              the carrier voicemail of the agent's phone is not reported as an accept.
//   voicemail  greeting + recording notice + <Record> (transcribed by our own transcription provider once
//              the recording is copied into encrypted storage).
// Every value placed in the XML is escaped; phone numbers must be E.164 (a bad one is refused, never
// passed through).
import { ProviderError } from '../types.js';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const E164 = /^\+[1-9][0-9]{6,14}$/;
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

function e164(v: string, code: string): string {
  if (!E164.test(v)) throw new ProviderError('rejected', code);
  return v;
}

function seconds(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(Number.isFinite(v) ? v : min)));
}

export interface RingTwiml {
  /** played to the caller before anything else (the recording announcement), or null */
  announcement: string | null;
  /** the team number that was called: the caller ID the agent sees */
  callerId: string;
  agentPhone: string;
  timeoutS: number;
  /** record the bridged call (only when the stored recording decision allows it) */
  record: boolean;
  /** the agent leg's whisper ("press 1 to answer") */
  screenUrl: string;
  /** fetched when the Dial ends (answered or not) */
  actionUrl: string;
  recordingStatusCallbackUrl?: string;
}

export function ringTwiml(r: RingTwiml): string {
  const attrs = [
    `callerId="${xml(e164(r.callerId, 'TWILIO_FROM_INVALID'))}"`,
    `timeout="${seconds(r.timeoutS, 5, 60)}"`,
    `action="${xml(r.actionUrl)}"`,
    'method="POST"',
    'answerOnBridge="true"',
  ];
  if (r.record) {
    attrs.push('record="record-from-answer-dual"');
    if (r.recordingStatusCallbackUrl) attrs.push(`recordingStatusCallback="${xml(r.recordingStatusCallbackUrl)}"`, 'recordingStatusCallbackMethod="POST"', 'recordingStatusCallbackEvent="completed"');
  }
  const say = r.announcement ? `<Say>${xml(r.announcement)}</Say>` : '';
  return `${HEAD}<Response>${say}<Dial ${attrs.join(' ')}><Number url="${xml(r.screenUrl)}" method="POST">${xml(e164(r.agentPhone, 'TWILIO_AGENT_PHONE_INVALID'))}</Number></Dial></Response>`;
}

/** The agent leg's whisper: a key press accepts; silence hangs up the agent leg only. */
export function screenTwiml(r: { prompt: string; acceptUrl: string }): string {
  return `${HEAD}<Response><Gather numDigits="1" timeout="8" action="${xml(r.acceptUrl)}" method="POST" actionOnEmptyResult="true"><Say>${xml(r.prompt)}</Say></Gather><Hangup/></Response>`;
}

export interface VoicemailTwiml {
  greeting: string;
  /** fixed notice that the message is recorded (not editable by the tenant) */
  notice: string;
  maxLengthS: number;
  /** fetched after the caller finishes the message */
  doneUrl: string;
  recordingStatusCallbackUrl: string;
}

export function voicemailTwiml(r: VoicemailTwiml): string {
  const rec = [
    `maxLength="${seconds(r.maxLengthS, 10, 300)}"`,
    'playBeep="true"',
    'timeout="5"',
    'finishOnKey="#"',
    `action="${xml(r.doneUrl)}"`,
    'method="POST"',
    `recordingStatusCallback="${xml(r.recordingStatusCallbackUrl)}"`,
    'recordingStatusCallbackMethod="POST"',
    'recordingStatusCallbackEvent="completed"',
  ];
  return `${HEAD}<Response><Say>${xml(r.greeting)}</Say><Say>${xml(r.notice)}</Say><Record ${rec.join(' ')}/><Say>No message was recorded. Goodbye.</Say><Hangup/></Response>`;
}

export function sayAndHangupTwiml(text: string | null): string {
  return `${HEAD}<Response>${text ? `<Say>${xml(text)}</Say>` : ''}<Hangup/></Response>`;
}

/** Bridges the screened agent leg: an empty response ends the whisper and connects the call. */
export const BRIDGE_TWIML = `${HEAD}<Response></Response>`;

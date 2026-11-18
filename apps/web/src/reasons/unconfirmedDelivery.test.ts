// W8 (batch 18 review: a duplicate-send risk): a text or email whose provider answer never came, or came back
// unreadable, was never proved undelivered. After 10 minutes with no confirmation the API marks it failed with reason
// DISPATCH_UNKNOWN_UNRESOLVED; until then it is dispatch_unknown while reconciliation asks the provider. Neither state
// is a non-delivery. Every sentence for them says that delivery could not be confirmed, that it may have reached the
// person, and to check before sending again. Wording only: the states, retries and reconciliation are unchanged.
import { describe, expect, it } from 'vitest';
import { messageStatus } from './sentences.js';
import { sendOutcomeText, sentResult } from '../surfaces/feed/lib/AgentSheets.js';
import type { ComposeResponse } from '../surfaces/feed/lib/types.js';

// what a sentence about an unconfirmed send must never claim
const CLAIMS_NOT_DELIVERED = /Not delivered|Not sent|didn't send|did not send|wasn't sent|was not sent|Nothing reached|refused it|went out\b|no record/i;
const MAY_HAVE = /may have reached them/;
const CHECK_FIRST = /[Cc]heck .*before (you send|sending) (it )?again/;

const unresolved = { status: 'failed', statusReason: 'DISPATCH_UNKNOWN_UNRESOLVED' } as const;

describe('R-GATE-8 E753 (W8): an unconfirmed send is never worded as a non-delivery', () => {
  it.each(['sms', 'mms', 'email', 'web_chat'] as const)("the thread's line for a %s that ended DISPATCH_UNKNOWN_UNRESOLVED says delivery could not be confirmed, that it may have reached them, and to check before sending again", (channel) => {
    const line = messageStatus({ ...unresolved, channel }, 'Jane');
    expect(line?.text).toBe('Delivery could not be confirmed: this may have reached them. Check with them before sending it again.');
    expect(line?.text).not.toMatch(CLAIMS_NOT_DELIVERED);
    // still never drawn like a sent message: the state is unchanged, only the words are
    expect(line?.tone).toBe('failed');
  });

  it('a provider code on such a message never turns the line back into a rejection', () => {
    const line = messageStatus({ ...unresolved, providerErrorCode: '30003', channel: 'sms' }, 'Jane');
    expect(line?.text).toMatch(/^Delivery could not be confirmed: /);
    expect(line?.text).not.toMatch(CLAIMS_NOT_DELIVERED);
  });

  it("the thread's line while reconciliation is still asking (dispatch_unknown, as after an unreadable provider reply) says the same, and that it is still being checked", () => {
    const line = messageStatus({ status: 'dispatch_unknown', channel: 'sms' }, 'Jane');
    expect(line?.text).toBe("Delivery is not confirmed yet: this may have reached them. We're still checking; check with them before sending it again.");
    expect(line?.text).not.toMatch(CLAIMS_NOT_DELIVERED);
    expect(line?.tone).toBe('info');
  });

  it('other failures keep their own words: a carrier rejection is still "Not delivered", and a timeout before any send is not called unconfirmed', () => {
    expect(messageStatus({ status: 'failed', statusReason: 'PROVIDER_REJECTED', channel: 'sms' }, 'Jane')?.text).toBe('Not delivered: the carrier rejected it');
    expect(messageStatus({ status: 'failed', statusReason: 'PROVIDER_UNAVAILABLE', channel: 'sms' }, 'Jane')?.text).toBe("Not delivered: the phone service wasn't answering");
    expect(messageStatus({ status: 'undelivered', statusReason: 'DISPATCH_UNKNOWN_UNRESOLVED', channel: 'sms' }, 'Jane')?.text).toMatch(/^Not delivered: /);
  });

  it('the notice after Send for an unknown outcome (dispatch_unknown) says it may have reached them, that this attempt is not sent again automatically, and to check before sending again', () => {
    const o = sendOutcomeText({ result: 'dispatch_unknown', message: null, decision: null }, 'Jane Doe');
    expect(o.tone).toBe('warn');
    expect(o.title).toBe("We couldn't confirm it was delivered.");
    expect(o.detail).toBe("The service may have accepted it, so it may have reached them. We're still checking, and this attempt won't be sent again automatically. Check the conversation before you send it again.");
    for (const text of [o.title, o.detail ?? '']) expect(text).not.toMatch(CLAIMS_NOT_DELIVERED);
    expect(o.detail).toMatch(MAY_HAVE);
    expect(o.detail).toMatch(CHECK_FIRST);
  });

  it('a re-tap that finds its first attempt ended DISPATCH_UNKNOWN_UNRESOLVED is not told "It didn\'t send. Nothing reached them."', () => {
    const replay = { result: 'noop', decision: null, message: { status: 'failed', statusReason: 'DISPATCH_UNKNOWN_UNRESOLVED' } } as unknown as ComposeResponse;
    expect(sentResult(replay)).toBe('delivery_unconfirmed');
    const o = sendOutcomeText(replay, 'Jane Doe');
    expect(o.tone).toBe('warn');
    expect(o.title).toBe("We couldn't confirm it was delivered.");
    expect(o.detail).toBe('It may have reached them. Check with them before you send it again.');
    for (const text of [o.title, o.detail ?? '']) expect(text).not.toMatch(CLAIMS_NOT_DELIVERED);
    // the same message as the direct answer of a send
    expect(sentResult({ result: 'failed', message: { status: 'failed', statusReason: 'DISPATCH_UNKNOWN_UNRESOLVED' } } as never)).toBe('delivery_unconfirmed');
    // a refusal is still a refusal
    expect(sendOutcomeText({ result: 'failed', decision: null, message: { status: 'failed', statusReason: 'PROVIDER_REJECTED' } } as unknown as ComposeResponse, 'Jane Doe').title).toBe("It didn't send.");
    expect(sentResult({ result: 'failed', message: null })).toBe('failed');
  });
});

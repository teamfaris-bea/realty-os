import { describe, expect, it } from 'vitest';
import { taskTimelineText } from './taskTimeline.js';

describe('task timeline sentence', () => {
  it('names an open promise and a kept one', () => {
    expect(taskTimelineText('promise:open', 'Send the comps')).toBe('Promise: Send the comps');
    expect(taskTimelineText('promise:done', 'Send the comps')).toBe('Promise kept: Send the comps');
  });

  it('names the other kinds, and a canceled task', () => {
    expect(taskTimelineText('todo:open', 'Call the lender')).toBe('Task: Call the lender');
    expect(taskTimelineText('callback:done', 'Call back')).toBe('Done: Call back');
    expect(taskTimelineText('follow_up:canceled', 'Check in')).toBe('Canceled: Check in');
  });

  it('is null for a row that is not a task', () => {
    expect(taskTimelineText('offer_accepted', 'OFFER_ACCEPTED')).toBeNull();
    expect(taskTimelineText(null, 'Send the comps')).toBeNull();
  });
});

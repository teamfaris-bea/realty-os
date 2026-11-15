import {expect,it} from 'vitest';
import {sendOutcomeText} from './AgentSheets.js';

it('describes an unreadable successful response as possibly accepted, without claiming a timeout or non-delivery',()=>{
  const outcome=sendOutcomeText({result:'dispatch_unknown',message:null,decision:null},'Synthetic Contact');
  expect(outcome.tone).toBe('warn');
  expect(outcome.detail).toContain('may have accepted');
  expect(outcome.detail).toContain("won't be sent again automatically");
  expect(outcome.detail).not.toMatch(/didn't answer in time|Nothing reached|won't be sent twice/);
});

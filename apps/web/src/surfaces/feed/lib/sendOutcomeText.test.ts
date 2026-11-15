import {messageStatus} from '../../../reasons/sentences.js';
import {expect,it} from 'vitest';
import {sendOutcomeText} from './AgentSheets.js';

it('describes an unreadable successful response as possibly accepted, without claiming a timeout or non-delivery',()=>{
  const outcome=sendOutcomeText({result:'dispatch_unknown',message:null,decision:null},'Synthetic Contact');
  expect(outcome.tone).toBe('warn');
  expect(outcome.detail).toContain('may have accepted');
  expect(outcome.detail).toContain("won't be sent again automatically");
  expect(outcome.detail).not.toMatch(/didn't answer in time|Nothing reached|won't be sent twice/);
});


it('a legacy unresolved failure is still described as possibly sent',()=>{
  const outcome=sendOutcomeText({result:'failed',message:{status:'failed',statusReason:'DISPATCH_UNKNOWN_UNRESOLVED'} as never,decision:null},'Synthetic Contact');
  expect(outcome.tone).toBe('warn');
  expect(outcome.detail).not.toMatch(/Nothing reached|refused/);
  expect(outcome.detail).toMatch(/may have accepted/);
});

it.each(['dispatch_unknown','failed'])('unresolved %s thread text never claims non-delivery',status=>{
  const line=messageStatus({status,statusReason:'DISPATCH_UNKNOWN_UNRESOLVED',channel:'sms'} as never,'Synthetic');
  expect(line?.text).toContain('Sending again could duplicate');
  expect(line?.text).not.toMatch(/Not delivered|Checking/);
});

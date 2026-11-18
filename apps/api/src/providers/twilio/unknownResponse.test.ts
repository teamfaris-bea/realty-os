// No live requests: all adapter I/O ends at the injected recording fetch.
import { describe, expect, it } from 'vitest';
import { TwilioHttp } from './http.js';
import { TwilioTelephony } from './telephony.js';

const account = {accountRef:'AC'+'2'.repeat(32),secret:'synthetic-sub-token'};
function transport(response:()=>Response) {
  const calls: string[] = [];
  const fetchStub = (async (_input:unknown,init?:RequestInit) => { calls.push(init?.method ?? 'GET'); return response(); }) as typeof fetch;
  const adapter = new TwilioTelephony({accountSid:'AC'+'1'.repeat(32),authToken:'synthetic-master-token',publicBaseUrl:'https://api.example.test',apiBase:'https://twilio.example.test',platformSender:'+15555550100',fetch:fetchStub,liveRequests:true,sleep:async()=>undefined});
  return {adapter,calls,fetchStub};
}
const responseCases = [
  ['malformed JSON',()=>new Response('{broken',{status:201})],
  ['unreadable body',()=>new Response(new ReadableStream({start(c){c.error(new Error('synthetic truncated response'));}}),{status:201})],
  ['missing SID',()=>new Response('{}',{status:201})],
  ['invalid SID',()=>new Response('{"sid":"invalid"}',{status:201})],
] as const;

describe('R-GATE-8 E754: ambiguous successful Twilio submits are unknown, never safe failures',()=>{
  it.each(responseCases)('SMS %s: exactly one raw POST',async (_name,response)=>{
    const h = transport(response);
    await expect(h.adapter.sendSms({account,from:'+15555550100',to:'+15555550101',body:'Synthetic response test',idempotencyKey:'local-only'})).rejects.toMatchObject({kind:'timeout',providerCode:'TWILIO_BAD_RESPONSE'});
    expect(h.calls).toEqual(['POST']);
  });
  it('voice malformed JSON is unknown after one raw POST',async()=>{
    const h = transport(()=>new Response('{broken',{status:201}));
    await expect(h.adapter.dialCall({account,from:'+15555550100',agentPhone:'+15555550102',to:'+15555550101',record:false,idempotencyKey:'local-call'})).rejects.toMatchObject({kind:'timeout',providerCode:'TWILIO_BAD_RESPONSE'});
    expect(h.calls).toEqual(['POST']);
  });
  it('verification submit malformed JSON is unknown after one raw POST',async()=>{
    const h = transport(()=>new Response('{broken',{status:201}));
    await expect(h.adapter.deliverVerificationCode({to:'+15555550101',code:'000000'})).rejects.toMatchObject({kind:'timeout',providerCode:'TWILIO_BAD_RESPONSE'});
    expect(h.calls).toEqual(['POST']);
  });
  it('a malformed read remains unavailable and cannot submit a message',async()=>{
    const h = transport(()=>new Response('{broken',{status:200}));
    const http = new TwilioHttp({fetch:h.fetchStub,liveRequests:true,sleep:async()=>undefined});
    await expect(http.request({sid:account.accountRef,token:account.secret},'GET','https://twilio.example.test/read')).rejects.toMatchObject({kind:'unavailable',providerCode:'TWILIO_BAD_RESPONSE'});
    expect(h.calls).toEqual(['GET']);
  });
});

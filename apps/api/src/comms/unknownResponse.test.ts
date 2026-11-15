// Real dispatcher + database + Twilio adapter, with only an injected HTTP stub.
// No fake-provider deduplication is involved in send/recovery assertions.
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {withTenantTx} from '@realty/db';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {type ApiHarness,createApiHarness} from '../auth/testHarness.js';
import {TwilioTelephony} from '../providers/twilio/telephony.js';
import {systemActor} from '../worker/systemActor.js';
import {dispatchOutbound,reconcileOutbound} from './dispatch.js';
import {storeTelephonyAccount} from './repos/credentials.js';
import {type CommsWorld,call,commsWorld,messageRow,ownedContact,sendText,telephonyWebhook} from './testing.js';

let h:ApiHarness;
let w:CommsWorld;
const account = {accountRef:'AC'+'2'.repeat(32),secret:'synthetic-response-token'};
beforeAll(async()=>{
  h=await createApiHarness(); w=await commsWorld(h,{agents:1});
  await withTenantTx(systemActor(w.tenantId,'worker'),tx=>storeTelephonyAccount(tx,w.deps.envelope,w.deps.ids,w.tenantId,account,null),{db:h.database});
},120_000);
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{await h?.close();});

function wire() {
  const calls:string[]=[];
  let body=''; let at=new Date(); let visible=false;
  let hold: {entered:()=>void; release:Promise<void>} | null = null;
  const providerRef='SM'+randomUUID().replaceAll('-','');
  const fetchStub=(async (_input:unknown,init?:RequestInit)=>{
    const method=init?.method ?? 'GET'; calls.push(method);
    if(method==='POST') { body=new URLSearchParams(String(init?.body)).get('Body')!; return new Response('{broken',{status:201}); }
    const response = new Response(JSON.stringify({messages:visible?[{sid:providerRef,body,status:'delivered',direction:'outbound-api',date_created:at.toUTCString()}]:[]}),{status:200});
    const barrier=hold; hold=null;
    if (barrier) { barrier.entered(); await barrier.release; }
    return response;
  }) as typeof fetch;
  const adapter=new TwilioTelephony({accountSid:'AC'+'1'.repeat(32),authToken:'synthetic-master-token',publicBaseUrl:'https://api.example.test',apiBase:'https://twilio.example.test',fetch:fetchStub,liveRequests:true,sleep:async()=>undefined});
  // Test-only adapter substitution; all calls originate from the normal dispatcher after its gates.
  // eslint-disable-next-line realty/no-provider-outbound
  const send=vi.spyOn(h.providers.telephony,'sendSms').mockImplementation(adapter.sendSms.bind(adapter));
  vi.spyOn(h.providers.telephony,'lookupMessage').mockImplementation(adapter.lookupMessage.bind(adapter));
  return {calls,send,providerRef,show:(time:Date)=>{at=time;visible=true;}, hide:()=>{visible=false;}, holdNextLookup:()=>{
    let entered!:()=>void; let release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const wait=new Promise<void>(resolve=>{release=resolve;});
    hold={entered,release:wait}; return {started,release};
  }};
}

describe('malformed accepted response persists uncertainty without replay',()=>{
  it('a deliberate new command is still a new submit, so uncertainty must not be described as non-delivery',async()=>{
    const c=await ownedContact(w.agents[0]!);
    const transport=wire();
    const first=await sendText(w.agents[0]!,c.id,'Synthetic uncertain message',{idempotencyKey:randomUUID()});
    const second=await sendText(w.agents[0]!,c.id,'Synthetic uncertain message',{idempotencyKey:randomUUID()});
    expect(first.body.result).toBe('dispatch_unknown');
    expect(second.body.result).toBe('dispatch_unknown');
    expect(first.body.message!.id).not.toBe(second.body.message!.id);
    expect(transport.calls).toEqual(['POST','POST']);
    expect(transport.send).toHaveBeenCalledTimes(2);
  });
  it.each(['lookup','callback','unresolved'] as const)('%s recovery never issues another raw POST',async recovery=>{
    const c=await ownedContact(w.agents[0]!);
    const transport=wire();
    const idempotencyKey=randomUUID();
    const text='Synthetic ambiguous submit';
    const first=await sendText(w.agents[0]!,c.id,text,{idempotencyKey});
    expect(transport.calls).toEqual(['POST']);
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(first.body.result).toBe('dispatch_unknown');
    const id=first.body.message!.id;
    const row=await messageRow(h,id);
    expect(row).toMatchObject({status:'dispatch_unknown',status_reason:'PROVIDER_TIMEOUT',provider_message_ref:null});
    expect((await h.su.query("SELECT provider_error_code FROM messages WHERE id=$1",[id])).rows[0].provider_error_code).toBeNull();
    expect((await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND kind='comms.reconcile' AND payload->>'messageId'=$2",[w.tenantId,id])).rows[0].n).toBe(1);
    expect((await sendText(w.agents[0]!,c.id,text,{idempotencyKey})).body.result).toBe('noop');
    expect(await dispatchOutbound(id,w.deps,{tenantId:w.tenantId})).toMatchObject({kind:'noop',status:'dispatch_unknown'});
    const retap=await call(w.agents[0]!,'POST',`/messages/${id}/send`,{});
    expect([retap.status,retap.code]).toEqual([409,'MESSAGE_NOT_SENDABLE']);
    expect(transport.calls).toEqual(['POST']);
    if(recovery==='lookup') {
      transport.show(row.dispatched_at!);
      expect(await reconcileOutbound(id,w.deps,w.tenantId)).toEqual({kind:'resolved',status:'delivered'});
      expect(await messageRow(h,id)).toMatchObject({status:'delivered',provider_message_ref:transport.providerRef});
      expect(transport.calls).toEqual(['POST','GET']);
    } else if(recovery==='callback') {
      const callback=()=>telephonyWebhook(h,`/webhooks/telephony/status?m=${id}`,{MessageSid:transport.providerRef,MessageStatus:'delivered',From:w.mainNumber,To:c.phone});
      expect((await callback()).statusCode).toBe(200);
      expect((await callback()).statusCode).toBe(200);
      // Current callback recovery records the status/event but does not backfill the provider ref.
      expect(await messageRow(h,id)).toMatchObject({status:'delivered',provider_message_ref:null});
      expect((await h.su.query('SELECT provider_event_ref FROM message_status_events WHERE message_id=$1',[id])).rows).toEqual([{provider_event_ref:`status:${transport.providerRef}:delivered`}]);
      expect(await reconcileOutbound(id,w.deps,w.tenantId)).toEqual({kind:'noop'});
      expect(transport.calls).toEqual(['POST']);
    } else {
      expect(await reconcileOutbound(id,w.deps,w.tenantId)).toMatchObject({kind:'retry'});
      await h.su.query("UPDATE messages SET dispatched_at=now()-interval '11 minutes' WHERE id=$1",[id]);
      expect(await reconcileOutbound(id,w.deps,w.tenantId)).toEqual({kind:'unresolved'});
      expect(await messageRow(h,id)).toMatchObject({status:'dispatch_unknown',status_reason:'DISPATCH_UNKNOWN_UNRESOLVED'});
      expect(transport.calls).toEqual(['POST','GET','GET']);
      expect(await reconcileOutbound(id,w.deps,w.tenantId)).toEqual({kind:'unresolved'});
      expect(transport.calls).toEqual(['POST','GET','GET']);
      expect((await h.su.query("SELECT ref_id FROM app.due_work(now(),100) WHERE work_kind='dispatch_reconcile' AND ref_id=$1",[id])).rows).toEqual([]);
      expect((await call(w.agents[0]!,'POST',`/messages/${id}/send`,{})).code).toBe('MESSAGE_NOT_SENDABLE');
      expect((await telephonyWebhook(h,`/webhooks/telephony/status?m=${id}`,{MessageSid:transport.providerRef,MessageStatus:'delivered',From:w.mainNumber,To:c.phone})).statusCode).toBe(200);
      expect(await messageRow(h,id)).toMatchObject({status:'delivered',status_reason:null});
    }
    expect((await dispatchOutbound(id,w.deps,{tenantId:w.tenantId})).kind).toBe('noop');
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.calls.filter(method=>method==='POST')).toHaveLength(1);
  });
});

it('repairs legacy unresolved rows without changing evidenced failures',async()=>{
  const c=await ownedContact(w.agents[0]!);
  wire();
  const ids:string[]=[];
  for (let i=0;i<2;i++) ids.push((await sendText(w.agents[0]!,c.id,'Synthetic legacy outcome',{idempotencyKey:randomUUID()})).body.message!.id);
  await h.su.query("UPDATE messages SET status='failed',status_reason='DISPATCH_UNKNOWN_UNRESOLVED',provider_error_code=NULL WHERE id=$1",[ids[0]]);
  await h.su.query("UPDATE messages SET status='failed',status_reason='PROVIDER_REJECTED',provider_error_code='21610' WHERE id=$1",[ids[1]]);
  await h.su.query(readFileSync(new URL('../../../../packages/db/migrations/0102_preserve_unresolved_outcomes.sql',import.meta.url),'utf8'));
  expect(await messageRow(h,ids[0]!)).toMatchObject({status:'dispatch_unknown',status_reason:'DISPATCH_UNKNOWN_UNRESOLVED'});
  expect(await messageRow(h,ids[1]!)).toMatchObject({status:'failed',status_reason:'PROVIDER_REJECTED'});
  expect((await h.su.query("SELECT ref_id FROM app.due_work(now(),100) WHERE ref_id=ANY($1::uuid[])",[ids])).rows).toEqual([]);
});

it.each(['unresolved','callback'] as const)('a slow positive lookup respects a competing %s result without replay',async competitor=>{
  const c=await ownedContact(w.agents[0]!);
  const transport=wire();
  const first=await sendText(w.agents[0]!,c.id,'Synthetic concurrent recovery',{idempotencyKey:randomUUID()});
  const id=first.body.message!.id;
  await h.su.query("UPDATE messages SET dispatched_at=now()-interval '11 minutes' WHERE id=$1",[id]);
  transport.show((await messageRow(h,id)).dispatched_at!);
  const barrier=transport.holdNextLookup();
  const slow=reconcileOutbound(id,w.deps,w.tenantId);
  await barrier.started;
  try {
    transport.hide();
    if (competitor==='unresolved') expect(await reconcileOutbound(id,w.deps,w.tenantId)).toEqual({kind:'unresolved'});
    else expect((await telephonyWebhook(h,`/webhooks/telephony/status?m=${id}`,{MessageSid:transport.providerRef,MessageStatus:'undelivered',ErrorCode:'30003',From:w.mainNumber,To:c.phone})).statusCode).toBe(200);
  } finally { barrier.release(); }
  expect(await slow).toEqual(competitor==='unresolved'?{kind:'resolved',status:'delivered'}:{kind:'noop'});
  expect(await messageRow(h,id)).toMatchObject(competitor==='unresolved'?{status:'delivered',status_reason:null}:{status:'undelivered'});
  expect(transport.calls.filter(method=>method==='POST')).toHaveLength(1);
  expect(transport.calls.filter(method=>method==='GET')).toHaveLength(competitor==='unresolved'?2:1);
  expect((await dispatchOutbound(id,w.deps,{tenantId:w.tenantId})).kind).toBe('noop');
});

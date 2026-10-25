import test from 'node:test';
import assert from 'node:assert/strict';
import {collectWithRecovery} from '../../contracts/collection-retry.mjs';
import {retryAfterMs,backoffMs,transientHttp} from '../../contracts/retry.mjs';

async function replay(results,options={}){
  let clock=0,opened=0,closed=0;const calls=[],waits=[];
  const query={domain:'example.com'};
  const completion=await collectWithRecovery({query,maxRequests:15,deadline:480000,now:()=>clock,backoff:()=>100,
    sleep:async ms=>{waits.push(ms);clock+=ms;},open:async q=>{assert.equal(q,query);opened++;return {page:{},close:async()=>closed++};},
    collect:async(_p,q,opts)=>{calls.push(opts);return results[calls.length-1];},...options});
  return {completion,opened,closed,calls,waits};
}
test('one lease retries an empty transient report once and adds both request counts',async()=>{
  const r=await replay([{status:'QUERY_TIMEOUT',actual_requests:6,data:{}},{status:'OK',actual_requests:6,data:{metric:0}}]);
  assert.equal(r.completion.actual_requests,12);assert.equal(r.completion.result.actual_requests,12);
  assert.deepEqual(r.calls.map(c=>c.maxRequests),[15,9]);assert.equal(r.opened,2);assert.equal(r.closed,2);
  assert.deepEqual(r.completion.result.retry_history.map(h=>h.status),['QUERY_TIMEOUT','OK']);
});
test('rate limits wait at least a minute and respect longer provider hints',async()=>{
  for(const hint of [undefined,180]){
    const r=await replay([{status:'RATE_LIMITED',actual_requests:2,data:{},retry_after_seconds:hint},{status:'OK',actual_requests:2,data:{metric:1}}]);
    assert.deepEqual(r.waits,[hint?hint*1000:60000]);assert.equal(r.completion.actual_requests,4);
  }
});
test('authentication, quota, partial data, unknown counts and exhausted budgets never re-collect',async()=>{
  for(const result of [
    ...['AUTH_REQUIRED','PERMISSION_DENIED','CAPTCHA_REQUIRED','QUOTA_EXCEEDED','BUDGET_EXCEEDED','PARTIAL'].map(status=>({status,actual_requests:1,data:{}})),
    {status:'QUERY_TIMEOUT',actual_requests:null,data:{}},{status:'QUERY_TIMEOUT',actual_requests:16,data:{}},
    {status:'QUERY_TIMEOUT',actual_requests:15,data:{}},{status:'QUERY_TIMEOUT',actual_requests:2,data:{metric:0}},
  ]){const r=await replay([result]);assert.equal(r.opened,1);assert.equal(r.closed,1);assert.equal(r.waits.length,0);}
});
test('the attempt cap, deadline and cancellation cannot create additional browser work',async()=>{
  const failure={status:'QUERY_TIMEOUT',actual_requests:2,data:{}};
  const bounded=await replay([failure,failure]);assert.equal(bounded.opened,2);assert.equal(bounded.completion.actual_requests,4);
  const short=await replay([{status:'RATE_LIMITED',actual_requests:2,data:{}}],{deadline:50000});assert.equal(short.opened,1);assert.equal(short.waits.length,0);
  const controller=new AbortController();
  const cancelled=await replay([failure],{signal:controller.signal,sleep:async()=>controller.abort()});
  assert.equal(cancelled.opened,1);assert.deepEqual(cancelled.completion,{error:'EXECUTION_INTERRUPTED',actual_requests:2});
});
test('failure to open a retry page preserves usage from the first collection',async()=>{
  let opens=0;
  const r=await replay([{status:'QUERY_TIMEOUT',actual_requests:3,data:{}}],{open:async()=>{if(opens++)throw {code:'AUTH_REQUIRED'};return {page:{},close:async()=>{}};}});
  assert.deepEqual(r.completion,{error:'AUTH_REQUIRED',actual_requests:3});
});
test('HTTP backoff accepts Retry-After seconds and dates without retrying permanent refusals',()=>{
  assert.equal(retryAfterMs('120'),120000);assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT',0),120000);
  assert.equal(retryAfterMs('invalid'),0);assert.equal(backoffMs(0,{retryAfter:10000,random:()=>0}),10000);
  assert.equal(transientHttp(503),true);assert.equal(transientHttp(401),false);assert.equal(transientHttp(403),false);
});

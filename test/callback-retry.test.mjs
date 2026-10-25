import test from 'node:test';
import assert from 'node:assert/strict';
import {retryCallback} from '../../contracts/callback-retry.mjs';

test('callback retry recovers a lost acknowledgement within the lease window',async()=>{
  let clock=0,calls=0;const waits=[];
  const result=await retryCallback(async()=>{calls++;clock+=5000;if(calls===1)throw Error('lost ack');return 'ok';},
    {now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;},backoff:()=>500});
  assert.equal(result,'ok');assert.equal(calls,2);assert.deepEqual(waits,[500]);
});

test('callback refusal and long cooling hints never outlive the lease window',async()=>{
  for(const error of [Object.assign(Error('revoked'),{retryable:false}),Object.assign(Error('busy'),{retryAfter:60000})]){
    let calls=0;
    await assert.rejects(()=>retryCallback(async()=>{calls++;throw error;},{sleep:async()=>{},backoff:(_n,{retryAfter})=>retryAfter}));
    assert.equal(calls,1);
  }
  let clock=0,calls=0;
  await assert.rejects(()=>retryCallback(async()=>{calls++;clock+=10000;throw Error('timeout');},
    {now:()=>clock,sleep:async ms=>{clock+=ms;},backoff:()=>500}));
  assert.equal(calls,1);
});

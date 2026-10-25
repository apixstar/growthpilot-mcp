import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, stat, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULTS, PROVIDERS, options, argumentsFor, prepare, loadAccounts, readRpc, classification,
  runSuite, stats, summarize, writeReports, redact, validateTargets, plan, Client} from '../scripts/load-test.mjs';

const users=Array.from({length:3},(_,i)=>({user:i+1,accountId:String(i+1).repeat(32),key:'gp_'+String(i+1).repeat(64)}));
const tools=['similarweb_query','execute_report','ahrefs_execute_report','google_trends_query','growthpilot_account_get',
  'organic_research','get_report_schema','ahrefs_discover','ahrefs_get_report_schema'];
async function temp(t) { const path=await mkdtemp(join(tmpdir(),'mcp-load-test-')); t.after(()=>rm(path,{recursive:true,force:true})); return path; }

// A real HTTP mock checks the wire contract, headers, pagination, asynchronous queues,
// ownership and accounting. Every other tools/call uses SSE instead of JSON.
async function fixture(t, mode={}) {
  const tasks=[], submissions=[], polls=[], headers=[], active=new Map(), timers=new Set(), usage=[0,0,0];
  let count=0, current=0, peak=0, leaked=false;
  const transientFailures=new Set();
  const startNext=provider=>{
    if(active.has(provider)) return;
    const task=tasks.find(x=>x.provider===provider&&x.status==='queued'); if(!task) return;
    task.status='running'; task.started=performance.now(); active.set(provider,task);
    const timer=setTimeout(()=>{
      timers.delete(timer); task.status='succeeded'; task.finished=performance.now(); current--; active.delete(provider); startNext(provider);
    },mode.duration??65); timers.add(timer);
  };
  const view=task=>({task_id:task.id,status:task.status,poll_after_seconds:mode.pollAfter??0,
    ...(task.status==='succeeded'?{result:{status:task.resultStatus??'OK',cached:!!mode.cached,
      data:{metric:7,never_saved:users[0].key},missing_fields:[],errors:[]}}:{result:null})});
  const server=createServer(async(req,res)=>{
    try {
      let body=''; for await(const chunk of req) body+=chunk;
      const message=JSON.parse(body), user=users.find(u=>req.headers.authorization==='Bearer '+u.key);
      headers.push(req.headers);
      if(!user) {res.writeHead(401);res.end();return;}
      const answer=(result,sse=false)=>{
        const envelope=JSON.stringify({jsonrpc:'2.0',id:message.id,result});
        if(sse) {res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': heartbeat\r\n\r\n');res.write('event: message\r\ndata: '+envelope+'\r\n\r\n');res.end();}
        else {res.writeHead(200,{'Content-Type':'application/json',...(message.method==='initialize'?{'Mcp-Session-Id':'session-'+user.user}:{})});res.end(envelope);}
      };
      if(message.method==='initialize') {answer({protocolVersion:'2025-11-25',capabilities:{tools:{}}});return;}
      assert.equal(req.headers['mcp-session-id'],'session-'+user.user);
      assert.equal(req.headers['mcp-protocol-version'],'2025-11-25');
      if(message.method==='notifications/initialized') {assert.equal(message.id,undefined);res.writeHead(202);res.end();return;}
      if(message.method==='tools/list') {
        const list=mode.missingTool?tools.filter(x=>x!=='ahrefs_execute_report'):tools;
        answer(message.params.cursor?{tools:list.slice(4).map(name=>({name}))}:{tools:list.slice(0,4).map(name=>({name})),nextCursor:'page2'});return;
      }
      assert.equal(message.method,'tools/call');
      const {name,arguments:a}=message.params;
      const out=(data,isError=false)=>answer(count++%2?{content:[{type:'text',text:JSON.stringify(data)}],isError}:{structuredContent:data,content:[],isError},count%2===0);
      if(name==='growthpilot_account_get') {out({account_id:mode.wrongAccount?users[0].accountId:user.accountId,allowance:{total_remaining:(mode.credits??100)-usage[user.user-1]}});return;}
      if(name==='organic_research') {out({channel_enabled:!mode.disabled,reports:[{report_id:'organicKeywords'}]});return;}
      if(name==='ahrefs_discover') {out({channel_enabled:true,categories:[{reports:[{report_id:'domainRating'}]}]});return;}
      if(name==='get_report_schema') {out({parameters_schema:{properties:{domain:{type:'string'}}}});return;}
      if(name==='ahrefs_get_report_schema') {out({parameters_schema:{properties:{target:{type:'string'}}}});return;}
      const provider=name==='similarweb_query'?'similarweb':name==='execute_report'?'semrush':name==='ahrefs_execute_report'?'ahrefs':'google_trends';
      if(a.task_id) {
        assert.deepEqual(Object.keys(a).sort(),['task_id','wait_seconds']);
        polls.push({user:user.user,args:a});
        const task=tasks.find(x=>x.id===a.task_id);
        const failureKey=user.user+':'+a.task_id;
        if(mode.recoverTransient&&!transientFailures.has(failureKey)){transientFailures.add(failureKey);res.writeHead(500);res.end();return;}
        if(!task||task.user!==user.user) {
          if(mode.leak&&task) {leaked=true;out(view(task));} else out({status:'NOT_FOUND',error:'MCP query task not found'},true);
          return;
        }
        out(view(task),task.status==='succeeded'&&!!task.resultStatus&&!['OK','PARTIAL','NO_DATA'].includes(task.resultStatus));return;
      }
      assert.equal(a.wait_seconds,0);
      assert.match(a.request_id,/^[A-Za-z0-9_-]{8,128}$/);
      const previous=tasks.find(x=>x.user===user.user&&x.requestId===a.request_id);
      if(mode.recoverTransient&&previous){out(view(previous));return;}
      assert(!submissions.some(s=>s.requestId===a.request_id));
      assert(!tasks.some(x=>x.user===user.user&&['queued','running'].includes(x.status)), 'one outstanding task per user');
      submissions.push({user:user.user,provider,requestId:a.request_id,afterLeak:leaked,target:a.query?.domains?.[0]??a.parameters?.domain??a.parameters?.target??a.query?.q});
      if(mode.httpError) {res.writeHead(mode.httpError);res.end();return;}
      if(mode.rpcError) {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'private text'}}));return;}
      if(mode.hangBody) {res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': ping\n\n');return;}
      if(mode.budget) {out({status:'BUDGET_EXCEEDED',error:'shared budget exhausted'},true);return;}
      const task={id:String(tasks.length+1).padStart(32,'0'),requestId:a.request_id,user:user.user,provider,status:mode.cached?'succeeded':'queued'};
      tasks.push(task); usage[user.user-1]++;
      if(mode.lostSubmit) {req.socket.destroy();return;}
      if(mode.resultStatus) task.resultStatus=mode.resultStatus;
      if(!mode.cached) {current++;peak=Math.max(peak,current);startNext(provider);}
      if(mode.recoverTransient){req.socket.destroy();return;}
      out(view(task));
    } catch(e) {res.writeHead(500);res.end('mock assertion: '+e.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const cfg={...DEFAULTS,httpRetries:0,url:`http://127.0.0.1:${server.address().port}/mcp`,rounds:1,pollMs:3,thinkMs:0,httpTimeoutMs:1000,taskTimeoutMs:4000};
  return {cfg,tasks,submissions,polls,headers,usage,get peak(){return peak;}};
}

test('full HTTP run covers 24 queries with 3 accounts, independent queues and ownership checks',async t=>{
  const f=await fixture(t), events=[];
  const r=await runSuite(f.cfg,users,{emit:e=>events.push(e)});
  assert.equal(r.summary.exitCode,0,JSON.stringify(r.summary));
  assert.equal(r.jobs.length,24); assert.equal(f.submissions.length,24); assert.equal(f.peak,3);
  assert.deepEqual(f.usage,[8,8,8]); assert.equal(r.summary.isolation.rejected,12);
  assert(r.summary.concurrency.overlaps.length>0);assert.equal(r.summary.concurrency.sameProviderViolations.length,0);
  for(const p of PROVIDERS) {
    assert.equal(r.jobs.filter(j=>j.provider===p).length,6);
    const tasks=f.tasks.filter(j=>j.provider===p).sort((a,b)=>a.started-b.started);
    for(let i=1;i<tasks.length;i++) assert(tasks[i].started>=tasks[i-1].finished);
  }
  assert(r.accounts.every(a=>a.creditsUsed===8));
  assert(events.some(e=>e.kind==='task_state'));
  const dir=await temp(t); await writeReports(dir,r,users.map(u=>u.key));
  for(const name of ['summary.json','requests.csv','timeline.html']) {
    const text=await readFile(join(dir,name),'utf8');assert(!text.includes(users[0].key));assert(!text.includes('never_saved'));
  }
});
test('preflight blocks all paid work for absent providers, duplicate identity, disabled channel and low credit',async t=>{
  for(const mode of [{missingTool:true},{wrongAccount:true},{disabled:true},{credits:7}]) {
    const f=await fixture(t,mode), r=await runSuite(f.cfg,users);
    assert.equal(r.summary.exitCode,2);assert.equal(f.submissions.length,0);
  }
});
test('selected three-provider run schedules 72 distinct targets with at most three users in flight',async t=>{
  const f=await fixture(t,{missingTool:true,credits:24}),providers=['similarweb','semrush','google_trends'];
  const targets=validateTargets(Array.from({length:24},(_,i)=>({domain:`target${i}.example.com`,keyword:`Brand ${i}`})),4);
  const r=await runSuite({...f.cfg,providers,rounds:4,targets},users);
  assert.equal(r.summary.exitCode,0,JSON.stringify(r.summary));
  assert.equal(r.jobs.length,72);assert.equal(f.submissions.length,72);assert.equal(f.peak,3);
  assert.deepEqual(f.usage,[24,24,24]);assert.deepEqual(r.plan.providers,providers);
  assert.equal(r.summary.isolation.expected,36);assert.equal(r.summary.isolation.rejected,36);
  assert.equal(r.summary.byProvider.length,3);assert.equal(r.summary.groups.length,18);
  assert.equal(r.summary.concurrency.sameProviderViolations.length,0);
  for(const provider of providers){
    const calls=f.submissions.filter(s=>s.provider===provider);
    assert.equal(calls.length,24);assert.equal(new Set(calls.map(c=>c.target)).size,24);
  }
  assert(!f.submissions.some(s=>s.provider==='ahrefs'));
});
test('provider selection and custom targets reject invalid or repeated work before submission',()=>{
  for(const providers of ['', 'unknown', 'semrush,semrush']) assert.throws(()=>options(['run','--providers',providers]));
  const cfg=options(['run','--providers','similarweb,semrush,google_trends','--rounds','4']);
  assert.equal(plan(cfg).dataQueries,72);assert.equal(plan(cfg).queriesPerAccount,24);
  const targets=Array.from({length:6},(_,i)=>({domain:`target${i}.example.com`,keyword:`Brand ${i}`}));
  assert.throws(()=>validateTargets(targets,2));
  for(const patch of [{domain:'https://example.com'},{keyword:'bad\ntext'},{domain:targets[1].domain},{keyword:targets[1].keyword},{token:'secret'}])
    assert.throws(()=>validateTargets([{...targets[0],...patch},...targets.slice(1)],1));
});
test('lost acknowledgements, poll 500s and isolation 500s recover without duplicate tasks or billing',async t=>{
  const f=await fixture(t,{recoverTransient:true});
  const r=await runSuite({...f.cfg,httpRetries:2},users,{retryBackoff:()=>1});
  assert.equal(r.jobs.length,24);assert.equal(r.summary.overall.ok,24);assert.equal(f.tasks.length,24);
  assert.equal(f.submissions.length,24);assert.deepEqual(f.usage,[8,8,8]);assert.equal(f.peak,3);
  assert.equal(r.summary.isolation.rejected,12);assert.equal(r.summary.unfinished.length,0);
  assert(r.summary.overall.httpRetryAttempts>=24);assert(r.requests.some(q=>q.errorCode==='HTTP_500'));
  for(const j of r.jobs){const attempts=r.requests.filter(q=>q.requestId===j.requestId&&q.action==='submit');assert.equal(attempts.length,2);assert.equal(attempts[1].retryAttempt,1);}
});
test('a shared budget failure stops new work without retrying a submission',async t=>{
  const f=await fixture(t,{budget:true}),r=await runSuite(f.cfg,users);
  assert.equal(r.stopReason,'BUDGET_EXCEEDED');assert(f.submissions.length<=3);assert.equal(r.summary.exitCode,1);
});
test('cross-account disclosure stops the suite before contention',async t=>{
  const f=await fixture(t,{leak:true}),r=await runSuite(f.cfg,users);
  assert.equal(r.stopReason,'ISOLATION_FAILED');assert.equal(f.submissions.length,12);
  assert(!f.submissions.some(s=>s.afterLeak));assert.equal(r.summary.exitCode,1);
});
test('cached immediate results never count as observed provider concurrency',async t=>{
  const f=await fixture(t,{cached:true}),r=await runSuite(f.cfg,users);
  assert.equal(r.summary.overall.ok,24);assert.equal(r.summary.overall.cached,24);
  assert.equal(r.summary.concurrency.crossProvider,'inconclusive');assert.equal(r.summary.exitCode,3);
});
test('lost submission response leaves an unconfirmed request and never schedules another for that user',async t=>{
  const f=await fixture(t,{lostSubmit:true}),r=await runSuite(f.cfg,users);
  assert.equal(f.submissions.length,3);assert.equal(r.summary.unfinished.length,3);
  assert(r.jobs.every(j=>j.submissionUnconfirmed));assert.equal(r.summary.exitCode,1);
});
test('transport errors retain safe diagnostic codes without exception text or credentials',async()=>{
  const events=[],client=new Client(DEFAULTS,users[0],{emit:e=>events.push(e),fetchImpl:async()=>{throw new TypeError('private-message '+users[0].key,{cause:{code:'ECONNRESET',message:'private-cause'}});}});
  await assert.rejects(client.call('similarweb_query',{}),{code:'NETWORK_OR_PARSE'});
  assert.equal(events[0].transportError,'TypeError');assert.equal(events[0].transportCode,'ECONNRESET');
  assert.doesNotMatch(JSON.stringify(events),/private-message|private-cause/);assert(!JSON.stringify(events).includes(users[0].key));
});
test('task deadline leaves task IDs for follow-up and prevents replacing unfinished work',async t=>{
  const f=await fixture(t,{duration:2000,pollAfter:100}),r=await runSuite({...f.cfg,taskTimeoutMs:70},users);
  assert.equal(f.submissions.length,3);assert.equal(r.summary.overall.timeout,3);
  assert(r.summary.unfinished.every(j=>j.taskId));
});
test('interrupt preserves in-flight tasks and yields exit 130',async t=>{
  const f=await fixture(t,{duration:2000}),controller=new AbortController();let submitted=0;
  const r=await runSuite(f.cfg,users,{signal:controller.signal,emit:row=>{
    if(row.kind==='task_state' && ++submitted===3) controller.abort();
  }});
  assert.equal(r.summary.exitCode,130);assert.equal(f.submissions.length,3);assert(r.summary.unfinished.length>0);
});
test('HTTP errors, JSON-RPC errors and stalled SSE bodies fail without resubmission',async t=>{
  for(const [mode,expected] of [[{httpError:429},'HTTP_429'],[{rpcError:true},'RPC_-32602'],[{hangBody:true},'HTTP_TIMEOUT']]) {
    const f=await fixture(t,mode),r=await runSuite({...f.cfg,httpTimeoutMs:100},users);
    assert.equal(f.submissions.length,3);assert(r.jobs.every(j=>j.errorCode===expected),JSON.stringify(r.jobs));
    assert.equal(r.summary.exitCode,1);
  }
});
test('reused tasks do not inflate independent task counts or create concurrency violations',async t=>{
  const f=await fixture(t,{cached:true}),r=await runSuite(f.cfg,users);
  r.jobs[1].taskId=r.jobs[0].taskId;
  const s=summarize(r);assert.equal(s.overall.uniqueTasks,23);assert.equal(s.overall.reusedTasks,1);
  assert.equal(s.concurrency.sameProviderViolations.length,0);
});
test('provider errors inside HTTP-200 task results retain their specific codes in request and task metrics',async t=>{
  const f=await fixture(t,{resultStatus:'AUTH_REQUIRED',duration:2}),r=await runSuite(f.cfg,users);
  assert.equal(r.summary.overall.taskErrors.AUTH_REQUIRED,24);
  assert.equal(r.summary.overall.errors.AUTH_REQUIRED,24);
  assert.equal(r.summary.overall.ok,0);
});
test('result classification distinguishes partial/no-data/HTTP-200 errors and missing data',()=>{
  assert.deepEqual(classification({status:'succeeded',result:{status:'OK',data:{x:1}}},false),{outcome:'ok'});
  assert.equal(classification({status:'succeeded',result:{status:'PARTIAL',data:{}}},false).outcome,'partial');
  assert.equal(classification({status:'succeeded',result:{status:'NO_DATA'}},false).outcome,'no_data');
  assert.equal(classification({status:'succeeded',result:{status:'NEED_LOGIN'}},true).errorCode,'NEED_LOGIN');
  assert.equal(classification({status:'succeeded',result:{status:'OK'}},false).errorCode,'MISSING_DATA');
  assert.equal(classification({status:'succeeded',result:{status:'OK',data:{},missing_fields:['visits']}},false).outcome,'partial');
  assert.deepEqual(stats([10,20,30,40]),{count:4,meanMs:25,p50Ms:20,p95Ms:40,maxMs:40});
});
test('SSE reads split CRLF and multibyte chunks, ignores notifications and closes an open stream',async()=>{
  const raw=': ping\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":7,"result":{"value":"中文"}}\r\n\r\n';
  const bytes=new TextEncoder().encode(raw);let i=0,cancelled=false;
  const stream=new ReadableStream({pull(c){if(i<bytes.length)c.enqueue(bytes.slice(i,i+=1));},cancel(){cancelled=true;}});
  const result=await readRpc(new Response(stream,{headers:{'content-type':'text/event-stream'}}),7);
  assert.equal(result.result.value,'中文');assert(cancelled);
  await assert.rejects(readRpc(new Response('{"jsonrpc":"2.0","id":8,"result":{}}'),7),{code:'RPC_ID_MISMATCH'});
});
test('prepare creates exactly three private reusable accounts without sending credentials to reports',async t=>{
  const root=await temp(t),cfg={...DEFAULTS,credentials:join(root,'private/accounts.json')};let calls=0;
  const fetchImpl=async(url,init)=>{
    assert.equal(String(url),'https://grow.apixstar.com/v1/admin/accounts');
    assert.match(JSON.parse(init.body).email,/@example\.invalid$/);assert.equal(init.headers.Authorization,'Bearer '+'o'.repeat(32));
    calls++;return Response.json({account_id:users[calls-1].accountId,api_key:users[calls-1].key});
  };
  const first=await prepare(cfg,{adminToken:'o'.repeat(32),fetchImpl});assert.equal(first.prepared,3);assert.equal(calls,3);
  assert.equal((await stat(cfg.credentials)).mode&0o777,0o600);
  assert.equal((await prepare(cfg,{fetchImpl})).reused,true);assert.equal(calls,3);
  assert.equal((await loadAccounts(cfg)).users.length,3);
  await chmod(cfg.credentials,0o644);await assert.rejects(loadAccounts(cfg),{code:'CONFIG'});
});
test('prepare persists partial progress and stops ambiguous account creation instead of generating new identities',async t=>{
  const root=await temp(t),cfg={...DEFAULTS,credentials:join(root,'accounts.json')};let calls=0;
  const fetchImpl=async()=>{calls++;if(calls===2)throw Error('network lost');return Response.json({account_id:users[0].accountId,api_key:users[0].key});};
  await assert.rejects(prepare(cfg,{adminToken:'o'.repeat(32),fetchImpl}));
  const saved=JSON.parse(await readFile(cfg.credentials,'utf8'));assert.equal(saved.users.length,1);
  await assert.rejects(prepare(cfg,{adminToken:'o'.repeat(32),fetchImpl:async(url,init)=>{
    assert(JSON.parse(init.body).email.includes(saved.suiteId));return new Response('',{status:409});
  }}),{code:'PREPARE_HTTP_409'});
});
test('configuration rejects credential URLs and bad bounds; defaults and workload are deterministic',()=>{
  assert.equal(options(['run','--dry-run']).rounds,1);
  for(const args of [['run','--rounds','0'],['run','--url','http://example.com/mcp'],['run','--url','https://user:secret@example.com/mcp'],['run','--url','https://example.com/mcp?key=x']]) assert.throws(()=>options(args));
  assert.notDeepEqual(argumentsFor('similarweb',0,'mixed'),argumentsFor('similarweb',0,'contention'));
  assert(!redact({message:'Bearer secret',token:users[0].key},users.map(u=>u.key)).includes(users[0].key));
});

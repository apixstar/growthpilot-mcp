#!/usr/bin/env node
// Standalone production MCP load harness. No SDK or provider credentials required.
import {readFile, mkdir, writeFile, rename, stat, open, unlink} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {transientHttp,retryAfterMs,backoffMs} from '../../contracts/retry.mjs';

export const PROVIDERS = ['similarweb', 'semrush', 'ahrefs', 'google_trends'];
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VERSION = '2025-11-25';
const TOOLS = {similarweb:'similarweb_query', semrush:'execute_report', ahrefs:'ahrefs_execute_report', google_trends:'google_trends_query'};
const DOMAINS = ['canva.com','adobe.com','notion.so','shopify.com','github.com','figma.com'];
const WORDS = ['Canva','Adobe','Notion','Shopify','GitHub','Figma'];
export const DEFAULTS = {url:'https://grow.apixstar.com/mcp', rounds:1, pollMs:2000, thinkMs:2000, httpTimeoutMs:45000, taskTimeoutMs:900000, httpRetries:2};
const rounded = n => Math.round(n * 100) / 100;
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : 'TOOL_ERROR';
export class LoadError extends Error {
  constructor(code, message = code, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}
function endpoint(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || !['/mcp','/mcp/'].includes(u.pathname) ||
      !(u.protocol === 'https:' || u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))
    throw new LoadError('CONFIG', 'Use an HTTPS /mcp URL (HTTP is allowed only on loopback).');
  return u.href;
}
export function options(argv) {
  const {values:v, positionals} = parseArgs({args:argv, allowPositionals:true, options:{
    url:{type:'string'}, credentials:{type:'string'}, output:{type:'string'}, rounds:{type:'string'}, providers:{type:'string'}, targets:{type:'string'},
    'poll-ms':{type:'string'}, 'think-ms':{type:'string'}, 'http-timeout-ms':{type:'string'},
    'task-timeout-ms':{type:'string'}, 'http-retries':{type:'string'}, 'dry-run':{type:'boolean'}, help:{type:'boolean',short:'h'},
  }});
  if (v.help) return {help:true};
  const command = positionals[0];
  if (positionals.length !== 1 || !['prepare','check','run'].includes(command)) throw new LoadError('CONFIG','Choose prepare, check or run.');
  const cfg = {...DEFAULTS, command, url:endpoint(v.url ?? process.env.MCP_LOAD_URL ?? DEFAULTS.url),
    credentials:resolve(v.credentials ?? join(ROOT,'runs/mcp-load-test-private/accounts.json')),
    output:resolve(v.output ?? join(ROOT,'runs/mcp-load-test')), dryRun:!!v['dry-run'],
    ...(v.providers!==undefined?{providers:v.providers.split(',').map(p=>p.trim())}:{}),
    ...(v.targets?{targetsFile:resolve(v.targets)}:{})};
  for (const [flag,key,min,max] of [['rounds','rounds',1,100],['poll-ms','pollMs',1,60000],['think-ms','thinkMs',0,60000],
    ['http-timeout-ms','httpTimeoutMs',1,300000],['task-timeout-ms','taskTimeoutMs',1,3600000],['http-retries','httpRetries',0,5]]) {
    if (v[flag] !== undefined) cfg[key] = Number(v[flag]);
    if (!Number.isInteger(cfg[key]) || cfg[key] < min || cfg[key] > max) throw new LoadError('CONFIG',`Invalid --${flag}.`);
  }
  providersFor(cfg);return cfg;
}
function providersFor(cfg) {
  const providers=cfg.providers??PROVIDERS;
  if(!Array.isArray(providers)||!providers.length||new Set(providers).size!==providers.length||providers.some(p=>!PROVIDERS.includes(p)))
    throw new LoadError('CONFIG','Use distinct known provider names in --providers.');
  return providers;
}
export function validateTargets(targets,rounds) {
  if(!Array.isArray(targets)||targets.length<6*rounds||targets.length>600) throw new LoadError('CONFIG','Provide at least six distinct targets per round (at most 600).');
  const normalized=targets.map(t=>{
    if(!t||Object.keys(t).some(k=>!['domain','keyword'].includes(k))||typeof t.domain!=='string'||typeof t.keyword!=='string') throw new LoadError('CONFIG','Each target must contain domain and keyword.');
    const domain=t.domain.toLowerCase(),keyword=t.keyword.trim();
    if(domain.length>253||! /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)||!keyword||keyword.length>80||/[\u0000-\u001f\u007f]/.test(keyword)) throw new LoadError('CONFIG','Use public domain names and short text keywords.');
    return {domain,keyword};
  });
  if(new Set(normalized.map(t=>t.domain)).size!==normalized.length||new Set(normalized.map(t=>t.keyword.toLowerCase())).size!==normalized.length) throw new LoadError('CONFIG','Targets must have distinct domains and keywords.');
  return normalized;
}
export function plan(cfg) {
  const providers=providersFor(cfg);
  return {url:cfg.url, users:3, rounds:cfg.rounds, dataQueries:6*providers.length*cfg.rounds, queriesPerAccount:2*providers.length*cfg.rounds,
    phases:['mixed','contention'], providers, httpTimeoutMs:cfg.httpTimeoutMs, taskTimeoutMs:cfg.taskTimeoutMs,httpRetries:cfg.httpRetries??0,
    ...(cfg.targets?{targets:validateTargets(cfg.targets,cfg.rounds)}:{}),
    note:'Discovery, account reads, isolation checks and polls are additional non-query requests. Custom targets are distinct within the run; upstream or previous-run cache may still apply.'};
}
export function argumentsFor(provider, user, phase, round = 0, targets) {
  const i = targets?round*6+user+(phase==='contention'?3:0):(user + (phase === 'contention' ? 3 : 0) + round) % DOMAINS.length;
  const domain = targets?targets[i].domain:DOMAINS[i];
  if (provider === 'similarweb') return {query:{function:'siteEngagement',domains:[domain],months:1}};
  if (provider === 'semrush') return {report_id:'organicKeywords',channel:'3ue',parameters:{domain,database:'us',rows:5}};
  if (provider === 'ahrefs') return {report_id:'domainRating',parameters:{target:domain,mode:'subdomains',protocol:'both'}};
  return {query:{provider:'google_trends',q:targets?targets[i].keyword:WORDS[i],dataType:'timeseries',date:'today 3-m',geo:'',tz:-480}};
}
export function redact(value, secrets = []) {
  let text = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length)) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/gp_(?:test_)?[A-Za-z0-9_-]{32,128}/g,'[REDACTED]')
    .replace(/Bearer\s+[^\s"\\]+/gi,'Bearer [REDACTED]');
}
async function privateSave(path, data) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const tmp = path + '.' + randomUUID() + '.tmp';
  await writeFile(tmp,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});
  await rename(tmp,path);
}
export async function loadAccounts(cfg, allowPartial = false) {
  const info = await stat(cfg.credentials);
  if ((info.mode & 0o077) !== 0) throw new LoadError('CONFIG','Credential file must be readable only by its owner (chmod 600).');
  const data = JSON.parse(await readFile(cfg.credentials,'utf8'));
  if (data.url !== cfg.url || !Array.isArray(data.users) || (!allowPartial && data.users.length !== 3))
    throw new LoadError('CONFIG','Credential endpoint/count mismatch; use prepare first.');
  if (data.users.length > 3 || data.users.some((u,i)=>u.user !== i+1 || typeof u.key !== 'string' || !u.key || !u.accountId) ||
      new Set(data.users.map(u=>u.accountId)).size !== data.users.length || new Set(data.users.map(u=>u.key)).size !== data.users.length)
    throw new LoadError('CONFIG','Require three distinct accounts and keys.');
  return data;
}
export async function prepare(cfg, {adminToken = process.env.MCP_LOAD_ADMIN_TOKEN, fetchImpl = fetch} = {}) {
  let data;
  try { data = await loadAccounts(cfg,true); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (data?.users.length === 3) return {prepared:3,reused:true,credentials:cfg.credentials};
  if (!adminToken || adminToken.length<24) throw new LoadError('CONFIG','Set MCP_LOAD_ADMIN_TOKEN to the existing operator credential (at least 24 characters) for prepare.');
  await mkdir(dirname(cfg.credentials),{recursive:true,mode:0o700});
  const lock = await open(cfg.credentials+'.lock','wx',0o600);
  try {
    data ??= {version:1,url:cfg.url,suiteId:randomUUID().replaceAll('-',''),users:[]};
    // Persist identity before sending: an ambiguous create is never retried with a new email.
    await privateSave(cfg.credentials,data);
    for (let i=data.users.length; i<3; i++) {
      const email = `mcp-loadtest-${data.suiteId}-u${i+1}@example.invalid`;
      const response = await fetchImpl(new URL('/v1/admin/accounts',cfg.url),{method:'POST',redirect:'error',
        headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},body:JSON.stringify({email}),
        signal:AbortSignal.timeout(cfg.httpTimeoutMs)});
      if (!response.ok) { await response.body?.cancel(); throw new LoadError('PREPARE_HTTP_'+response.status,
        'Account preparation stopped. Saved accounts are reusable; an ambiguous create/409 needs operator recovery, not another suite.'); }
      const created = await response.json();
      if (!created.account_id || !created.api_key) throw new LoadError('PREPARE_RESPONSE');
      data.users.push({user:i+1,email,accountId:created.account_id,key:created.api_key});
      await privateSave(cfg.credentials,data);
    }
    return {prepared:3,reused:false,credentials:cfg.credentials};
  } finally { await lock.close(); await unlink(cfg.credentials+'.lock'); }
}

// Read SSE until the matching RPC response, even when the server keeps its stream open.
export async function readRpc(response, id) {
  const reader = response.body?.getReader();
  if (!reader) throw new LoadError('EMPTY_RESPONSE');
  const sse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  const decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  const event = block => {
    const lines = block.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).replace(/^ /,''));
    if (!lines.length) return;
    const value = JSON.parse(lines.join('\n'));
    if (value.id === id) return value;
  };
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (value) { bytes += value.byteLength; if (bytes > 10*1024*1024) throw new LoadError('RESPONSE_TOO_LARGE'); }
      buffer += decoder.decode(value,{stream:!done});
      if (sse) {
        // Normalize only complete CRLF pairs, including those split between chunks.
        buffer = buffer.replace(/\r\n/g,'\n');
        let boundary;
        while ((boundary=buffer.indexOf('\n\n')) >= 0) {
          const parsed = event(buffer.slice(0,boundary)); buffer=buffer.slice(boundary+2);
          if (parsed) return parsed;
        }
      }
      if (done) break;
    }
    const parsed = sse ? event(buffer) : JSON.parse(buffer);
    if (!parsed || parsed.id !== id) throw new LoadError('RPC_ID_MISMATCH');
    return parsed;
  } finally { await reader.cancel().catch(()=>{}); }
}
export function toolData(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const item of result?.content ?? []) if (item.type === 'text') {
    try { const d=JSON.parse(item.text); if(d && typeof d==='object') return d; } catch { /* Other text is not task data. */ }
  }
  throw new LoadError('INVALID_TOOL_RESPONSE');
}
export class Client {
  constructor(cfg,user,{fetchImpl=fetch,signal,emit=()=>{},retrySleep=sleep,retryBackoff=backoffMs}={}) {
    Object.assign(this,{cfg,user,fetchImpl,signal,emit,retrySleep,retryBackoff}); this.seq=0; this.protocol=VERSION;
  }
  async rpc(method,params,meta={},timeoutMs=this.cfg.httpTimeoutMs) {
    const id=++this.seq, start=performance.now();
    const row={kind:'request',user:this.user.user,method,tool:params?.name??null,...meta,
      startedAt:new Date().toISOString(),startMs:start,httpStatus:null,ok:false};
    const signal=AbortSignal.any([AbortSignal.timeout(Math.max(1,Math.ceil(timeoutMs))),...(this.signal?[this.signal]:[])]);
    try {
      const response=await this.fetchImpl(this.cfg.url,{method:'POST',redirect:'error',signal,headers:{
        Authorization:'Bearer '+this.user.key,'Content-Type':'application/json',Accept:'application/json, text/event-stream',
        ...(method==='initialize'?{}:{'MCP-Protocol-Version':this.protocol}),...(this.session?{'Mcp-Session-Id':this.session}:{}),
      },body:JSON.stringify({jsonrpc:'2.0',...(method.startsWith('notifications/')?{}:{id}),method,params})});
      row.httpStatus=response.status;
      if (!response.ok) { const retryAfter=retryAfterMs(response.headers.get('retry-after'));await response.body?.cancel(); throw new LoadError('HTTP_'+response.status,undefined,{retryAfter}); }
      if (method==='initialize') this.session=response.headers.get('mcp-session-id');
      if (method.startsWith('notifications/')) { await response.body?.cancel(); row.ok=true; return null; }
      const body=await readRpc(response,id);
      if (body.jsonrpc !== '2.0' || body.error || !Object.hasOwn(body,'result')) throw new LoadError(body.error?(Number.isInteger(body.error.code)?'RPC_'+body.error.code:'RPC_ERROR'):'INVALID_RPC');
      row.ok=!body.result?.isError;
      if (!row.ok) {
        const data=toolData(body.result);
        row.errorCode=code(data.result?.status ?? (data.status==='failed'?data.error:data.status));
      }
      return body.result;
    } catch(e) {
      if(!(e instanceof LoadError)) {
        row.transportError=/^[A-Za-z]{1,64}$/.test(e.name??'')?e.name:'UnknownError';
        const cause=e.cause?.code??e.cause?.errors?.[0]?.code;
        if(typeof cause==='string'&&/^[A-Z0-9_]{1,64}$/.test(cause)) row.transportCode=cause;
      }
      const error=e instanceof LoadError?e:new LoadError(this.signal?.aborted?'CANCELLED':signal.aborted?'HTTP_TIMEOUT':'NETWORK_OR_PARSE');
      row.errorCode=error.code; throw error;
    } finally {
      row.endMs=performance.now(); row.durationMs=rounded(row.endMs-start); this.emit(row); this.lastRequest=row;
    }
  }
  async call(name,args,meta={},timeoutMs) {
    const reads=new Set(['growthpilot_account_get','organic_research','get_report_schema','ahrefs_discover','ahrefs_get_report_schema']);
    const queryTool=Object.values(TOOLS).includes(name);
    const replayable=reads.has(name)||queryTool&&(!!args.task_id||typeof args.request_id==='string'&&args.request_id.length>=8);
    const retries=replayable?(this.cfg.httpRetries??0):0;
    const deadline=performance.now()+(timeoutMs??this.cfg.httpTimeoutMs*(retries+1)+15000);
    // Capture an immutable payload: a transport retry never invents a request_id,
    // changes query parameters or replaces polling with a new paid query.
    const params=JSON.parse(JSON.stringify({name,arguments:args}));
    for(let attempt=0;;attempt++) {
      let value,error;
      try{
        value=await this.rpc('tools/call',params,{...meta,retryAttempt:attempt},Math.min(this.cfg.httpTimeoutMs,Math.max(1,deadline-performance.now())));
        if(!value.isError||!['SERVICE_UNAVAILABLE','BUSY'].includes(toolData(value).status))return value;
      }catch(e){error=e;if(!['HTTP_TIMEOUT','NETWORK_OR_PARSE'].includes(e.code)&&!(e.code?.startsWith('HTTP_')&&transientHttp(Number(e.code.slice(5)))))throw e;}
      if(attempt>=retries||this.signal?.aborted){if(error)throw error;return value;}
      const suggested=value?.isError?toolData(value).retry_after_seconds:0;
      const wait=this.retryBackoff(attempt,{retryAfter:error?.retryAfter??(Number.isFinite(suggested)&&suggested>=0?suggested*1000:0)});
      if(wait+1>=deadline-performance.now()){if(error)throw error;return value;}
      await this.retrySleep(wait,this.signal);
    }
  }
  async checked(name,args,meta={phase:'preflight'}) {
    const result=await this.call(name,args,meta), data=toolData(result);
    if (result.isError) throw new LoadError(code(data.status));
    return data;
  }
  async connect() {
    const init=await this.rpc('initialize',{protocolVersion:VERSION,capabilities:{},clientInfo:{name:'growthpilot-load-test',version:'1.0.0'}},{phase:'preflight'});
    if (typeof init.protocolVersion!=='string') throw new LoadError('INVALID_INITIALIZE');
    this.protocol=init.protocolVersion;
    await this.rpc('notifications/initialized',{}, {phase:'preflight'});
    const names=new Set(), cursors=new Set(); let cursor;
    do {
      const page=await this.rpc('tools/list',cursor?{cursor}:{},{phase:'preflight'});
      if (!Array.isArray(page.tools)) throw new LoadError('INVALID_TOOL_LIST');
      for(const tool of page.tools) names.add(tool.name);
      cursor=page.nextCursor;
      if(cursor && (cursors.has(cursor)||cursors.size>=100)) throw new LoadError('TOOL_LIST_PAGINATION');
      cursors.add(cursor);
    } while(cursor);
    const providers=providersFor(this.cfg);
    for(const name of [...providers.map(p=>TOOLS[p]),'growthpilot_account_get',...(providers.includes('semrush')?['organic_research','get_report_schema']:[]),...(providers.includes('ahrefs')?['ahrefs_discover','ahrefs_get_report_schema']:[])])
      if(!names.has(name)) throw new LoadError('MISSING_TOOL',`Missing ${name}.`);
  }
}
export async function preflight(clients,cfg) {
  const providers=providersFor(cfg);
  const checks=await Promise.allSettled(clients.map(async client=>{
    await client.connect();
    const a=await client.checked('growthpilot_account_get',{});
    if(a.account_id!==client.user.accountId) throw new LoadError('ACCOUNT_MISMATCH');
    if(!Number.isFinite(a.allowance?.total_remaining) || a.allowance.total_remaining<2*providers.length*cfg.rounds) throw new LoadError('INSUFFICIENT_CREDITS');
    if(providers.includes('semrush')) {
      const sem=await client.checked('organic_research',{channel:'3ue'});
      if(!sem.channel_enabled || !sem.reports?.some(r=>r.report_id==='organicKeywords')) throw new LoadError('PROVIDER_UNAVAILABLE');
      const ss=await client.checked('get_report_schema',{report_id:'organicKeywords',channel:'3ue'});
      if(!ss.parameters_schema?.properties?.domain) throw new LoadError('REPORT_SCHEMA_CHANGED');
    }
    if(providers.includes('ahrefs')) {
      const ahrefs=await client.checked('ahrefs_discover',{category:'site-explorer-overview'});
      if(!ahrefs.channel_enabled || !ahrefs.categories?.some(c=>c.reports?.some(r=>r.report_id==='domainRating'))) throw new LoadError('PROVIDER_UNAVAILABLE');
      const as=await client.checked('ahrefs_get_report_schema',{report_id:'domainRating'});
      if(!as.parameters_schema?.properties?.target) throw new LoadError('REPORT_SCHEMA_CHANGED');
    }
    return {user:client.user.user,remainingBefore:a.allowance.total_remaining};
  }));
  const bad=checks.find(r=>r.status==='rejected'); if(bad) throw bad.reason;
  if(new Set(clients.map(c=>c.user.accountId)).size!==3) throw new LoadError('DUPLICATE_ACCOUNT');
  return checks.map(r=>r.value);
}
export function classification(data,isError) {
  if (data.status==='failed') return {outcome:'failed',errorCode:code(data.error)};
  if (isError) return {outcome:'failed',errorCode:code(data.result?.status??data.status)};
  if (data.status!=='succeeded') return {outcome:'failed',errorCode:'INVALID_TASK_STATUS'};
  const status=data.result?.status;
  if(status==='NO_DATA') return {outcome:'no_data'};
  if(status==='PARTIAL') return {outcome:'partial'};
  if(status!=='OK') return {outcome:'failed',errorCode:code(status)};
  if(data.result.data==null || typeof data.result.data!=='object') return {outcome:'failed',errorCode:'MISSING_DATA'};
  if(data.result.missing_fields?.length || data.result.errors?.length) return {outcome:'partial'};
  return {outcome:'ok'};
}
async function sleep(ms,signal) { if(ms>0) await delay(ms,undefined,{signal}); }

export async function runSuite(cfg, users, {fetchImpl=fetch,signal,emit=()=>{},runId=randomUUID().replaceAll('-',''),retryBackoff=backoffMs}={}) {
  const requests=[],jobs=[],isolation=[],stop={reason:null},blocked=new Set();
  const record=row=>{ if(row.kind==='request') requests.push(row); emit(row); };
  const clients=users.map(user=>new Client(cfg,user,{fetchImpl,signal,emit:record,retryBackoff}));
  const start=performance.now(), startedAt=new Date().toISOString();
  const report={version:1,runId,startedAt,plan:plan(cfg),accounts:[],jobs,requests,isolation,stopReason:null};
  const providers=report.plan.providers;
  const halt=(reason)=>{stop.reason??=reason;};
  async function job(client,provider,phase,round) {
    if(stop.reason || signal?.aborted || blocked.has(client.user.user)) return;
    const began=performance.now(), requestId=`load_${runId}_${phase}_${round}_${client.user.user}_${provider}`;
    const row={kind:'job',user:client.user.user,provider,tool:TOOLS[provider],phase,round,requestId,
      startMs:began,startedAt:new Date().toISOString(),taskId:null,taskStatus:null,outcome:null,cached:null,samples:[],polls:0};
    jobs.push(row); record({kind:'job_start',user:row.user,provider,phase,requestId});
    try {
      let args={...argumentsFor(provider,client.user.user-1,phase,round,report.plan.targets),request_id:requestId,wait_seconds:0};
      while(true) {
        if(signal?.aborted) throw new LoadError('CANCELLED');
        const remaining=cfg.taskTimeoutMs-(performance.now()-began);
        if(remaining<=0) throw new LoadError('TASK_TIMEOUT');
        const action=row.taskId?'poll':'submit';
        const result=await client.call(row.tool,args,{phase,provider,action,requestId},remaining);
        const data=toolData(result), req=client.lastRequest;
        if(data.task_id) {
          if(typeof data.task_id!=='string' || !/^[a-f0-9]{32}$/.test(data.task_id) || row.taskId && row.taskId!==data.task_id) throw new LoadError('TASK_ID_MISMATCH');
          row.taskId=data.task_id;
        }
        row.taskStatus=data.status;
        if(['queued','running','succeeded','failed'].includes(data.status) && !row.taskId) throw new LoadError('MISSING_TASK_ID');
        row.samples.push({state:data.status,startMs:req.startMs,endMs:req.endMs});
        record({kind:'task_state',user:row.user,provider,phase,requestId,taskId:row.taskId,state:data.status,startMs:req.startMs,endMs:req.endMs});
        if(action==='submit') row.submitMs=req.durationMs; else row.polls++;
        if(['queued','running'].includes(data.status) && !result.isError) {
          if(!row.taskId) throw new LoadError('MISSING_TASK_ID');
          const suggested=Number.isFinite(data.poll_after_seconds) && data.poll_after_seconds>=0 ? data.poll_after_seconds*1000 : 0;
          await sleep(Math.max(0,Math.min(Math.max(cfg.pollMs,suggested),cfg.taskTimeoutMs-(performance.now()-began))),signal);
          args={task_id:row.taskId,wait_seconds:0}; continue;
        }
        Object.assign(row,classification(data,result.isError));
        row.resultStatus=data.result?.status??null; row.cached=typeof data.result?.cached==='boolean'?data.result.cached:null;
        row.missingFieldCount=Array.isArray(data.result?.missing_fields)?data.result.missing_fields.length:null;
        row.resultErrorCount=Array.isArray(data.result?.errors)?data.result.errors.length:null;
        if(row.errorCode==='BUDGET_EXCEEDED') halt('BUDGET_EXCEEDED');
        if(['FREE_QUOTA_EXHAUSTED','MONTHLY_QUOTA_EXHAUSTED','PREPAID_QUOTA_EXHAUSTED','UNAUTHORIZED'].includes(row.errorCode)) blocked.add(row.user);
        if(!row.taskId) {
          blocked.add(row.user);
          if(['SERVICE_UNAVAILABLE','TOOL_ERROR'].includes(row.errorCode)) row.submissionUnconfirmed=true;
        }
        if(!['succeeded','failed'].includes(row.taskStatus) && row.taskId) blocked.add(row.user);
        break;
      }
    } catch(e) {
      row.errorCode=signal?.aborted?'CANCELLED':e.code??'CLIENT_ERROR';
      row.outcome=row.errorCode==='CANCELLED'?'cancelled':/TIMEOUT/.test(row.errorCode)?'timeout':'failed';
      // A lost submit response or poll failure can leave work running. Never add another task for this user.
      blocked.add(row.user);
      if(!row.taskId) row.submissionUnconfirmed=true;
    } finally {
      row.endMs=performance.now(); row.durationMs=rounded(row.endMs-began);
      row.unfinished=!!row.taskId && !['succeeded','failed'].includes(row.taskStatus);
      const running=row.samples.filter(s=>s.state==='running');
      row.observedQueueMs=running.length?rounded(running[0].endMs-began):null;
      row.runningInterval=running.length>=2 && running.at(-1).startMs>running[0].endMs ? [running[0].endMs,running.at(-1).startMs] : null;
      record({...row});
    }
  }
  async function checkIsolation(round) {
    for(const source of jobs.filter(j=>j.phase==='mixed' && j.round===round && j.taskId)) {
      if(signal?.aborted || stop.reason) break;
      const foreign=clients[source.user%3];
      const row={owner:source.user,reader:foreign.user.user,provider:source.provider,taskId:source.taskId,status:'inconclusive'};
      try {
        const raw=await foreign.call(source.tool,{task_id:source.taskId,wait_seconds:0},{phase:'isolation',provider:source.provider,action:'isolation'});
        const data=toolData(raw);
        if(raw.isError && data.status==='NOT_FOUND' && !data.result && !data.query && !data.task_id && !data.data) row.status='rejected';
        else { row.status='failed'; halt('ISOLATION_FAILED'); }
      } catch(e) { row.errorCode=e.code??'CLIENT_ERROR'; halt('ISOLATION_UNCONFIRMED'); }
      isolation.push(row); record({kind:'isolation',...row});
    }
  }
  try {
    report.accounts=await preflight(clients,cfg); record({kind:'preflight',accounts:report.accounts});
    report.loadStartMs=performance.now();
    for(let round=0; round<cfg.rounds && !stop.reason && !signal?.aborted; round++) {
      await Promise.all(clients.map(async(client,index)=>{
        for(let n=0;n<providers.length;n++) {
          await job(client,providers[(index+n)%providers.length],'mixed',round);
          if(n<providers.length-1 && !stop.reason && !blocked.has(client.user.user) && !signal?.aborted) await sleep(cfg.thinkMs,signal).catch(()=>{});
        }
      }));
      await checkIsolation(round);
      for(const provider of providers) {
        if(stop.reason || signal?.aborted) break;
        await Promise.all(clients.map(client=>job(client,provider,'contention',round)));
      }
    }
  } catch(e) { report.preflightError=e.code??'PREFLIGHT_FAILED'; halt(report.preflightError); }
  finally {
    report.loadEndMs=performance.now();
    // Finish all clients independently; a failed balance read never discards task results.
    if(!signal?.aborted) await Promise.all(clients.map(async client=>{
      const a=report.accounts.find(a=>a.user===client.user.user); if(!a) return;
      try { const result=await client.checked('growthpilot_account_get',{}, {phase:'account_after'});
        a.remainingAfter=result.allowance?.total_remaining??null;
        a.creditsUsed=Number.isFinite(a.remainingAfter)?a.remainingBefore-a.remainingAfter:null;
      } catch(e) { a.balanceError=e.code??'ACCOUNT_READ_FAILED'; }
    }));
    report.stopReason=signal?.aborted?'CANCELLED':stop.reason;
    report.finishedAt=new Date().toISOString(); report.durationMs=rounded(performance.now()-start);
    report.summary=summarize(report); record({kind:'summary',summary:report.summary});
  }
  return report;
}

export function stats(numbers) {
  const a=numbers.filter(Number.isFinite).sort((a,b)=>a-b), at=p=>a.length?a[Math.max(0,Math.ceil(a.length*p)-1)]:null;
  return {count:a.length,meanMs:a.length?rounded(a.reduce((s,x)=>s+x,0)/a.length):null,p50Ms:at(.5),p95Ms:at(.95),maxMs:at(1)};
}
function metrics(jobs,requests) {
  const counts=Object.fromEntries(['ok','partial','no_data','failed','timeout','cancelled'].map(k=>[k,jobs.filter(j=>j.outcome===k).length]));
  const knownCache=jobs.filter(j=>j.cached!==null);
  const elapsed=jobs.length?Math.max(...jobs.map(j=>j.endMs))-Math.min(...jobs.map(j=>j.startMs)):0;
  const retried=new Set(requests.filter(r=>r.retryAttempt>0&&r.requestId).map(r=>r.requestId));
  const recovered=jobs.filter(j=>j.outcome==='ok'&&retried.has(j.requestId)).length;
  return {attempted:jobs.length,...counts,fullSuccessRate:jobs.length?counts.ok/jobs.length:null,
    recoveredQueries:recovered,firstPassOk:counts.ok-recovered,firstPassSuccessRate:jobs.length?(counts.ok-recovered)/jobs.length:null,
    cached:jobs.filter(j=>j.cached===true).length,cacheKnown:knownCache.length,
    cacheHitRate:knownCache.length?knownCache.filter(j=>j.cached).length/knownCache.length:null,
    uniqueTasks:new Set(jobs.map(j=>j.taskId).filter(Boolean)).size,
    reusedTasks:jobs.filter(j=>j.taskId).length-new Set(jobs.map(j=>j.taskId).filter(Boolean)).size,
    submit:stats(requests.filter(r=>r.action==='submit').map(r=>r.durationMs)),poll:stats(requests.filter(r=>r.action==='poll').map(r=>r.durationMs)),
    allEndToEnd:stats(jobs.map(j=>j.durationMs)),fullSuccessEndToEnd:stats(jobs.filter(j=>j.outcome==='ok').map(j=>j.durationMs)),
    cachedEndToEnd:stats(jobs.filter(j=>j.cached===true).map(j=>j.durationMs)),uncachedEndToEnd:stats(jobs.filter(j=>j.cached===false).map(j=>j.durationMs)),
    completedTasksPerMinute:elapsed?rounded(jobs.filter(j=>['succeeded','failed'].includes(j.taskStatus)).length*60000/elapsed):null,
    requestErrors:requests.filter(r=>!r.ok).length,httpRetryAttempts:requests.filter(r=>r.retryAttempt>0).length,
    taskErrors:jobs.filter(j=>j.errorCode).reduce((a,j)=>(a[j.errorCode]=(a[j.errorCode]??0)+1,a),{}),
    errors:requests.filter(r=>!r.ok).reduce((a,r)=>(a[r.errorCode??'UNKNOWN']=(a[r.errorCode??'UNKNOWN']??0)+1,a),{})};
}
export function summarize(report) {
  const providers=report.plan.providers??PROVIDERS, expectedIsolation=3*providers.length*report.plan.rounds;
  const {jobs,requests}=report, loadRequests=requests.filter(r=>['mixed','contention'].includes(r.phase));
  const intervals=jobs.filter(j=>j.runningInterval && j.cached!==true), overlaps=[], violations=[];
  for(let i=0;i<intervals.length;i++) for(let k=i+1;k<intervals.length;k++) {
    const a=intervals[i],b=intervals[k];
    if(a.taskId===b.taskId) continue;
    const ms=Math.min(a.runningInterval[1],b.runningInterval[1])-Math.max(a.runningInterval[0],b.runningInterval[0]);
    if(ms>0) (a.provider===b.provider?violations:overlaps).push({tasks:[a.taskId,b.taskId],providers:[a.provider,b.provider],overlapMs:rounded(ms)});
  }
  const groups=[];
  for(const phase of ['mixed','contention']) for(const provider of providers) for(const user of [1,2,3])
    groups.push({phase,provider,user,...metrics(jobs.filter(j=>j.phase===phase&&j.provider===provider&&j.user===user),loadRequests.filter(r=>r.phase===phase&&r.provider===provider&&r.user===user))});
  const rejected=report.isolation.filter(r=>r.status==='rejected').length;
  const contention=providers.map(provider=>{
    const batch=jobs.filter(j=>j.phase==='contention'&&j.provider===provider);
    return {provider,attempted:batch.length,observedQueued:batch.filter(j=>j.samples.some(s=>s.state==='queued')).length,
      observedRunning:batch.filter(j=>j.runningInterval).length,
      completionOrder:[...batch].filter(j=>['succeeded','failed'].includes(j.taskStatus)).sort((a,b)=>a.endMs-b.endMs).map(j=>j.user),
      status:violations.some(v=>v.providers.includes(provider))?'violation':batch.length===3*report.plan.rounds&&batch.every(j=>j.runningInterval)&&batch.some(j=>j.samples.some(s=>s.state==='queued'))?'observed_serial':'inconclusive'};
  });
  const complete=jobs.length===report.plan.dataQueries && jobs.every(j=>j.outcome==='ok') && !report.stopReason && !report.preflightError;
  return {overall:metrics(jobs,loadRequests),byProvider:providers.map(provider=>({provider,...metrics(jobs.filter(j=>j.provider===provider),loadRequests.filter(r=>r.provider===provider))})),
    byPhase:['mixed','contention'].map(phase=>({phase,...metrics(jobs.filter(j=>j.phase===phase),loadRequests.filter(r=>r.phase===phase))})),
    byUser:[1,2,3].map(user=>({user,...metrics(jobs.filter(j=>j.user===user),loadRequests.filter(r=>r.user===user))})),groups,
    concurrency:{crossProvider:overlaps.length?'observed_parallel':'inconclusive',overlaps,sameProviderViolations:violations,contention},
    isolation:{checked:report.isolation.length,rejected,expected:expectedIsolation,status:rejected===expectedIsolation?'passed':report.isolation.some(r=>r.status==='failed')?'failed':'inconclusive'},
    unfinished:jobs.filter(j=>j.unfinished||j.submissionUnconfirmed).map(j=>({user:j.user,provider:j.provider,taskId:j.taskId,requestId:j.requestId,submissionUnconfirmed:!!j.submissionUnconfirmed})),
    stability:complete?'all_queries_ok':'incomplete_or_errors',
    exitCode:report.stopReason==='CANCELLED'?130:report.preflightError?2:!complete||violations.length||rejected!==expectedIsolation?1:
      !overlaps.length||contention.some(c=>c.status==='inconclusive')?3:0,
    note:'Small sample baseline only. Running intervals are conservative sampled slot occupancy (including completing), not exact browser timings. Serial/FIFO observations are not a proof of all server execution ordering.'};
}

const htmlEscape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function htmlReport(report) {
  const s=report.summary, base=report.loadStartMs??0, span=Math.max(1,report.loadEndMs-base);
  const seconds=n=>n==null?'—':(n/1000).toFixed(2)+' s';
  const localTime=new Date(report.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MCP 压测报告</title>
<style>body{font:15px system-ui;margin:40px auto;padding:0 24px;max-width:1200px;color:#1c2737;background:#f5f7fa}h1{font-size:30px}table{border-collapse:collapse;background:white;width:100%;margin:20px 0}th,td{padding:12px;text-align:left;border-bottom:1px solid #ddd}small{color:#536174}section{margin:30px 0}.line{display:grid;grid-template-columns:260px 1fr;gap:10px;margin:8px 0}.track{position:relative;background:#e6eaf0;height:22px}.bar,.running{position:absolute;height:100%;min-width:2px}.bar{background:#99b8db}.running{background:#185b91}.bad{background:#d67e78}.muted{color:#586679}code{overflow-wrap:anywhere}summary{cursor:pointer}</style>
<h1>三用户 · ${report.plan.providers.length} 个供应商 MCP 压测</h1><p>${htmlEscape(localTime)}（北京时间） · ${htmlEscape(report.plan.url)}</p>
<p>查询 ${report.jobs.length}/${report.plan.dataQueries} · 完整成功 ${s.overall.ok} · 部分数据 ${s.overall.partial} · 无数据 ${s.overall.no_data} · 失败 ${s.overall.failed} · 超时 ${s.overall.timeout} · 取消 ${s.overall.cancelled}</p>
<p>客户端无需 HTTP 重试即成功 ${s.overall.firstPassOk??'未知'} · 经 HTTP 重试后成功 ${s.overall.recoveredQueries??'未知'} · 额外 HTTP 尝试 ${s.overall.httpRetryAttempts??0}。服务端采集恢复次数不在此口径中；原始请求错误仍保留在 CSV 和 JSON。</p>
<p>跨供应商并行：${htmlEscape(s.concurrency.crossProvider)}；账户隔离：${htmlEscape(s.isolation.status)}（${s.isolation.rejected}/${s.isolation.expected}）。停止原因：${htmlEscape(report.stopReason??'无')}。</p>
<table><tr><th>供应商</th><th>完整成功/查询</th><th>提交均值</th><th>轮询均值</th><th>成功总耗时 P50 / P95 / 最大</th><th>失败原因</th><th>缓存</th></tr>${s.byProvider.map(p=>`<tr><td>${p.provider}</td><td>${p.ok}/${p.attempted}</td><td>${seconds(p.submit.meanMs)}</td><td>${seconds(p.poll.meanMs)}</td><td>${seconds(p.fullSuccessEndToEnd.p50Ms)} / ${seconds(p.fullSuccessEndToEnd.p95Ms)} / ${seconds(p.fullSuccessEndToEnd.maxMs)}</td><td>${htmlEscape(Object.entries(p.taskErrors).map(([k,v])=>k+' × '+v).join(', ')||'—')}</td><td>${p.cached}/${p.cacheKnown}</td></tr>`).join('')}</table>
<section><h2>任务时间线</h2><p class="muted">浅蓝为提交至结束；深蓝仅表示重复采样确认的 running 区间；红色表示非完整成功。横轴总长 ${seconds(span)}。鼠标停留可查看任务编号。</p>
${report.jobs.map(j=>`<div class="line"><small>${htmlEscape(j.phase)} · U${j.user} · ${j.provider}</small><div class="track" title="${htmlEscape(j.taskId??j.requestId)} | ${htmlEscape(j.outcome)} | ${seconds(j.durationMs)}"><div class="bar ${j.outcome==='ok'?'':'bad'}" style="left:${100*(j.startMs-base)/span}%;width:${100*j.durationMs/span}%"></div>${j.runningInterval?`<div class="running" style="left:${100*(j.runningInterval[0]-base)/span}%;width:${100*(j.runningInterval[1]-j.runningInterval[0])/span}%"></div>`:''}</div></div>`).join('')}</section>
<section><h2>同供应商队列</h2><table><tr><th>供应商</th><th>观察到 queued 的任务数</th><th>取得重复 running 样本</th><th>观察到的完成顺序（用户）</th><th>判定</th></tr>${s.concurrency.contention.map(c=>`<tr><td>${c.provider}</td><td>${c.observedQueued}</td><td>${c.observedRunning}</td><td>${c.completionOrder.join(' → ')}</td><td>${c.status}</td></tr>`).join('')}</table></section>
<section><h2>账户额度</h2><table><tr><th>账户</th><th>测试前</th><th>测试后</th><th>变化</th></tr>${report.accounts.map(a=>`<tr><td>U${a.user}</td><td>${a.remainingBefore}</td><td>${a.remainingAfter??'未知'}</td><td>${a.creditsUsed??'未知'}</td></tr>`).join('')}</table></section>
<p class="muted">本次各供应商样本数见上表；有限样本的 P95 可能接近最大值，不能证明长期稳定。排队时间由轮询估算；未观察到重叠不等于没有并行。客户端停止等待不会取消服务端任务。</p>
<details><summary>失败及未完成任务</summary><pre>${htmlEscape(JSON.stringify(report.jobs.filter(j=>j.outcome!=='ok').map(j=>({user:j.user,provider:j.provider,taskId:j.taskId,requestId:j.requestId,outcome:j.outcome,errorCode:j.errorCode})),null,2))}</pre></details></html>`;
}
export async function writeReports(dir, report, secrets=[]) {
  const clean=JSON.parse(redact(report,secrets));
  await writeFile(join(dir,'summary.json'),JSON.stringify(clean,null,2));
  const columns=['phase','provider','user','action','method','tool','startedAt','durationMs','httpStatus','ok','errorCode','transportError','transportCode','retryAttempt','requestId'];
  const cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';
  await writeFile(join(dir,'requests.csv'),[columns.join(','),...clean.requests.map(r=>columns.map(k=>cell(r[k])).join(','))].join('\n')+'\n');
  await writeFile(join(dir,'timeline.html'),htmlReport(clean));
}
export async function main(argv=process.argv.slice(2)) {
  const cfg=options(argv);
  if(cfg.help) { console.log('Usage: node mcp/scripts/load-test.mjs prepare|check|run [--dry-run] [--url URL] [--credentials FILE] [--output DIR] [--rounds N] [--providers NAMES] [--targets FILE] [--poll-ms N] [--think-ms N] [--http-timeout-ms N] [--task-timeout-ms N] [--http-retries N]\nprepare uses MCP_LOAD_ADMIN_TOKEN; check/run use only the saved account keys. Default HTTP retries: 2, using the identical request_id/payload. Exit: 0 pass, 1 findings, 2 setup failure, 3 insufficient queue evidence, 130 interrupted.'); return 0; }
  if(cfg.targetsFile) cfg.targets=validateTargets(JSON.parse(await readFile(cfg.targetsFile,'utf8')),cfg.rounds);
  if(cfg.dryRun) { console.log(JSON.stringify({command:cfg.command,...plan(cfg)},null,2)); return 0; }
  if(cfg.command==='prepare') { console.log(JSON.stringify(await prepare(cfg),null,2)); return 0; }
  const data=await loadAccounts(cfg), controller=new AbortController();
  // Prevent two harness processes from turning the same three users into six.
  const runLock=cfg.command==='run'?await open(cfg.credentials+'.run.lock','wx',0o600):null;
  if(runLock) await runLock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  const interrupt=()=>controller.abort(); process.once('SIGINT',interrupt); process.once('SIGTERM',interrupt);
  try {
    if(cfg.command==='check') {
      const clients=data.users.map(u=>new Client(cfg,u,{signal:controller.signal}));
      console.log(JSON.stringify({ready:true,accounts:await preflight(clients,cfg),...plan(cfg)},null,2)); return 0;
    }
    const runId=randomUUID().replaceAll('-',''), dir=join(cfg.output,new Date().toISOString().replace(/[:.]/g,'-')+'-'+runId.slice(0,8));
    await mkdir(dir,{recursive:true});
    const secrets=data.users.map(u=>u.key), journal=join(dir,'events.jsonl');
    console.log(`Starting ${plan(cfg).dataQueries} queries with 3 accounts. Reports: ${dir}`);
    const emit=row=>{
      appendFileSync(journal,redact(row,secrets)+'\n');
      if(row.kind==='job') console.log(`${row.phase} U${row.user} ${row.provider}: ${row.outcome} ${(row.durationMs/1000).toFixed(1)}s${row.errorCode?' '+row.errorCode:''}`);
    };
    const report=await runSuite(cfg,data.users,{signal:controller.signal,emit,runId});
    await writeReports(dir,report,secrets);
    console.log(JSON.stringify({reportDirectory:dir,...report.summary.overall,concurrency:report.summary.concurrency.crossProvider,
      isolation:report.summary.isolation,unfinished:report.summary.unfinished,stopReason:report.stopReason,exitCode:report.summary.exitCode},null,2));
    return report.summary.exitCode;
  } finally {
    process.removeListener('SIGINT',interrupt); process.removeListener('SIGTERM',interrupt);
    if(runLock) {await runLock.close();await unlink(cfg.credentials+'.run.lock');}
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().then(exit=>{process.exitCode=exit;}).catch(e=>{
    // Server exception messages and response bodies can contain secrets; never print them.
    console.error(e instanceof LoadError ? `${e.code}: ${e.message}` : `Load test stopped (${e.code??e.name??'error'}).`); process.exitCode=2;
  });
}

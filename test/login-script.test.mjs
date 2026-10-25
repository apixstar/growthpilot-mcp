import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,chmod,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../plugins/growthpilot/scripts/login.sh',import.meta.url));
// A stand-in for `claude` that, like the real login, refuses to run without a terminal.
const fakeClaude=`#!/bin/sh
[ "$1 $2 $3" = "mcp login --help" ] && exit 0
[ "$3" = fail ] && { echo "Authentication timeout"; exit 7; }
if [ -t 0 ] && [ -t 1 ]; then echo "Authenticated with \\"$3\\""; exit 0; fi
echo "stdin is not a terminal"; exit 1
`;

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'growthpilot-login-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const claude=join(root,'claude');
  await writeFile(claude,fakeClaude);await chmod(claude,0o755);
  const run=(args=[],env={})=>spawnSync('sh',[script,...args],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe'],
    env:{...process.env,TMPDIR:root,CLAUDE_BIN:claude,...env}});
  return {root,run};
}

test('runs the native login in a pseudo-terminal from a shell without one',async t=>{
  const {root,run}=await fixture(t),result=run();
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/GROWTHPILOT_LOGIN_START plugin:growthpilot:growthpilot/);
  assert.match(result.stdout,/Authenticated with "plugin:growthpilot:growthpilot"/);
  assert.match(result.stdout,/GROWTHPILOT_LOGIN_EXIT 0\n$/);
  await assert.rejects(stat(join(root,'growthpilot-login.lock.d')));
});

test('reports the login exit status and accepts a standalone server name',async t=>{
  const {run}=await fixture(t),result=run(['fail']);
  assert.equal(result.status,7);
  assert.match(result.stdout,/Authentication timeout/);
  assert.match(result.stdout,/GROWTHPILOT_LOGIN_EXIT 7\n$/);
});

test('refuses a second concurrent login but recovers a stale lock',async t=>{
  const {root,run}=await fixture(t),lock=join(root,'growthpilot-login.lock.d');
  await mkdir(lock);await writeFile(join(lock,'pid'),String(process.pid));
  const busy=run();
  assert.equal(busy.status,2);
  assert.match(busy.stdout,/GROWTHPILOT_LOGIN_ERROR already_running/);
  await writeFile(join(lock,'pid'),'999999');
  assert.equal(run().status,0);
});

test('explains a missing Claude Code executable without attempting login',async t=>{
  const {run}=await fixture(t),result=run([],{CLAUDE_BIN:'/nonexistent/claude'});
  assert.equal(result.status,2);
  assert.match(result.stdout,/^GROWTHPILOT_LOGIN_ERROR claude_not_found/);
});

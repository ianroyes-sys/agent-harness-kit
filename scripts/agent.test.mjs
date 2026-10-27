import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseClaudeEnvelope } from './agent.mjs';
const adapter=fileURLToPath(new URL('./agent.mjs',import.meta.url));

// A stand-in for `claude -p --output-format json`: prompt on stdin, JSON envelope on stdout.
// It records its argv/env so tests can assert the isolation flags actually reach the binary.
function fixture(t, body) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-adapter-test-'));
  const binary=path.join(root,'claude-fixture');
  const prelude=`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(path.join(root,'calls.jsonl'))},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),capture:process.env.HARNESS_CHILD,apiKey:process.env.ANTHROPIC_API_KEY||null})+'\\n');const reply=(result,extra={})=>process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result,session_id:'s',num_turns:1,total_cost_usd:0,...extra}));\n`;
  fs.writeFileSync(binary, `#!${process.execPath}\n${prelude}${body}`, {mode:0o700});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=()=>fs.existsSync(path.join(root,'calls.jsonl'))?fs.readFileSync(path.join(root,'calls.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l)):[];
  return {root, calls, run:(args,extraEnv={})=>spawnSync(process.execPath,[adapter,...args],{env:{...process.env,HARNESS_ROOT:root,HARNESS_AGENT_CWD:root,HARNESS_CLAUDE_BIN:binary,HARNESS_REASONING_EFFORT:'medium',...extraEnv},encoding:'utf8',timeout:10000})};
}
const readStdin=`let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>`;
test('real adapter pipeline samples distinct outputs, evaluates and returns winner',t=>{
  const f=fixture(t,`${readStdin}reply(input.includes('Evaluate the following candidate drafts')?JSON.stringify({selected:1,reason:'Second meets constraints',limitations:'Proposal only'}):input.includes('Draft 1:')?'FIRST':'SECOND'));`);
  const result=f.run(['-p','Choose a draft','--candidates','2']);
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/^SECOND/);assert.match(result.stdout,/Proposal only/);
  assert.equal(f.calls().length,3);
});
test('failed model process cannot leak a successful-looking result',t=>{
  const f=fixture(t,`reply('ALL DONE');process.exitCode=1;`);
  const result=f.run(['-p','Check it']);assert.equal(result.status,1);assert.equal(result.stdout,'');
  const flagged=fixture(t,`reply('ALL DONE',{is_error:true,subtype:'error_during_execution'});`).run(['-p','Check it']);
  assert.equal(flagged.status,1);assert.equal(flagged.stdout,'');assert.match(flagged.stderr,/reported an error/);
});
test('empty successful process, empty result and timeout are explicit failures',t=>{
  const empty=fixture(t,'process.exit(0);').run(['-p','Check it']);
  assert.equal(empty.status,1);assert.match(empty.stderr,/without a final response/);
  const blank=fixture(t,`reply('   ');`).run(['-p','Check it']);
  assert.equal(blank.status,1);assert.match(blank.stderr,/without a final response/);
  const garbage=fixture(t,`process.stdout.write('not json');`).run(['-p','Check it']);
  assert.equal(garbage.status,1);assert.match(garbage.stderr,/unreadable/);
  const timeout=fixture(t,'setInterval(()=>{},1000);').run(['-p','Check it','--timeout-ms','100']);
  assert.equal(timeout.status,124);assert.equal(timeout.stdout,'');
});
test('inspect and synthetic self-test do not load the personal context packet; self-test uses haiku with zero tools',t=>{
  const f=fixture(t,`${readStdin}{if(input.includes('PERSONAL CONTEXT')||input.includes('CURATED RESEARCH'))process.exit(5);reply('AGENT_READY');});`);
  const self=f.run(['--self-test'],{HARNESS_MODEL:'opus'});assert.equal(self.status,0,self.stderr);assert.equal(self.stdout,'AGENT_READY');
  const [call]=f.calls();
  assert.equal(call.argv[call.argv.indexOf('--model')+1],'haiku');
  assert.equal(call.argv[call.argv.indexOf('--tools')+1],'');
  assert.ok(!call.argv.includes('--allowedTools'));
  assert.notEqual(call.cwd,f.root);
  const info=f.run(['-p','Debug the failure','--inspect']);assert.equal(info.status,0);assert.equal(JSON.parse(info.stdout).reasoning.profile,'deliberate');
});
test('isolation flags reach the binary; subscription auth only; capture hook suppressed',t=>{
  const f=fixture(t,`reply('ok');`);
  const result=f.run(['-p','Explain','--model','gpt-6-astra','--output-format','text'],{ANTHROPIC_API_KEY:'sk-test-should-not-pass'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'ok');
  const [call]=f.calls();const a=call.argv;
  assert.equal(a[0],'-p');assert.equal(a[a.indexOf('--output-format')+1],'json');
  assert.equal(a[a.indexOf('--model')+1],'opus');
  assert.equal(a[a.indexOf('--permission-mode')+1],'dontAsk');
  assert.ok(a.includes('--strict-mcp-config'));assert.equal(a[a.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
  assert.equal(a[a.indexOf('--setting-sources')+1],'');
  assert.equal(a[a.indexOf('--tools')+1],'Read,Grep,Glob');
  assert.ok(!a.some(x=>/bypassPermissions|dangerously/i.test(x)));
  assert.equal(call.capture,'1');assert.equal(call.apiKey,null);
  assert.equal(call.cwd,fs.realpathSync(f.root));
});
test('envelope parser accepts only non-error non-empty results',()=>{
  assert.deepEqual(parseClaudeEnvelope(JSON.stringify({is_error:false,result:' hi '})).result,'hi');
  for(const raw of ['',JSON.stringify({is_error:true,result:'x'}),JSON.stringify({is_error:false,result:''}),JSON.stringify({is_error:false}),'null','[]x']) assert.equal(parseClaudeEnvelope(raw).ok,false,raw);
});
test('context folder is injected once as data, and --no-context or an assembled packet skips it',t=>{
  const f=fixture(t,`${readStdin}reply(input.includes('== LIVE PERSONAL CONTEXT ==')?'WITH:'+(input.split('== LIVE PERSONAL CONTEXT ==').length-1):'WITHOUT'));`);
  const dir=path.join(f.root,'ctx');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'goals.md'),'# Goals\nShip the thing.');
  assert.equal(f.run(['-p','Explain'],{HARNESS_CONTEXT_DIR:dir}).stdout,'WITH:1');
  assert.equal(f.run(['-p','Explain','--no-context'],{HARNESS_CONTEXT_DIR:dir}).stdout,'WITHOUT');
  assert.equal(f.run(['-p','Explain\n== LIVE PERSONAL CONTEXT ==\nalready here'],{HARNESS_CONTEXT_DIR:dir}).stdout,'WITH:1');
  assert.equal(f.run(['-p','Explain'],{HARNESS_CONTEXT_DIR:path.join(f.root,'missing')}).stdout,'WITHOUT');
});

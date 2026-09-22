// Exercise the shipped server, not only the executor base class. All upstream calls use a local fixture.
import { fileURLToPath } from "node:url";
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const pkg = process.argv[2] || fileURLToPath(new URL("../", import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-published-catalog-'));
let child;
let logs = '';
const forwarded = [];
const remoteModels = [{ id: 'cc/claude-fable-5.1' }, { id: 'openai/example' }, { id: 'remote-combo' }];
const remote = http.createServer(async (req,res) => {
  res.setHeader('Content-Type','application/json');
  if(req.headers.authorization !== 'Bearer release-fixture-key') {res.writeHead(401).end('{}');return;}
  if(req.url === '/v1/models') {res.end(JSON.stringify({object:'list',data:remoteModels}));return;}
  if(req.url === '/v1/chat/completions') {
    let body=''; for await(const chunk of req) body+=chunk;
    forwarded.push(JSON.parse(body));
    res.end(JSON.stringify({id:'fixture-chat',object:'chat.completion',created:Math.floor(Date.now()/1000),model:JSON.parse(body).model,choices:[{index:0,message:{role:'assistant',content:'remote fixture reply'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));return;
  }
  res.writeHead(404).end('{}');
});
await new Promise(r=>remote.listen(0,'127.0.0.1',r));
const portProbe=http.createServer(); await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));
const port=portProbe.address().port; await new Promise(r=>portProbe.close(r));
const base=`http://127.0.0.1:${port}`;
let cookie='';
async function jsonRequest(route,body,auth) {
 const res=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(auth?{Authorization:`Bearer ${auth}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 const text=await res.text(); assert.ok(res.ok,`${route}: ${res.status} ${text.slice(0,500)}`);
 return JSON.parse(text);
}
try {
 child=spawn(process.execPath,[path.join(pkg,'app/server.js')],{cwd:pkg,env:{...process.env,PORT:String(port),HOSTNAME:'127.0.0.1',DATA_DIR:dataDir,INITIAL_PASSWORD:'release-local-fixture-password',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>logs+=b); child.stderr.on('data',b=>logs+=b);
 let ready=false;
 for(let i=0;i<100;i++) {try {await fetch(base+'/dashboard',{signal:AbortSignal.timeout(1000)});ready=true;break;}catch{} await new Promise(r=>setTimeout(r,300));}
 assert.ok(ready,'Published server failed to boot');
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'release-local-fixture-password'})});
 assert.equal(login.status,200); cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 const created=await jsonRequest('/api/providers',{provider:'red-router',name:'Release fixture remote',apiKey:'release-fixture-key',providerSpecificData:{baseUrl:`http://127.0.0.1:${remote.address().port}`}});
 assert.deepEqual(created.connection.providerSpecificData.discoveredModels,remoteModels);
 const key=await jsonRequest('/api/keys',{name:'Release fixture client'});
 const catalog=await jsonRequest('/v1/models',null,key.key);
 for(const m of remoteModels) assert.ok(catalog.data.some(local=>local.id===`red-router/${m.id}`),`Missing ${m.id}`);
 const local=await jsonRequest('/api/models');
 assert.ok(local.models.some(m=>m.fullModel==='red-router/cc/claude-fable-5.1'));
 const chat=await jsonRequest('/v1/chat/completions',{model:'red-router/cc/claude-fable-5.1',messages:[{role:'user',content:'hello'}],stream:false},key.key);
 assert.equal(chat.choices[0].message.content,'remote fixture reply');
 assert.equal(forwarded[0].model,'cc/claude-fable-5.1');
 console.log('PASS: published package boot, login, automatic catalog persistence, both catalogs, and end-to-end chat forwarding');
} catch(error) {console.error(error);console.error(logs.slice(-7000));process.exitCode=1;}
finally {
 if(child && child.exitCode===null) {child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
 remote.closeAllConnections(); await new Promise(r=>remote.close(r));
 fs.rmSync(dataDir,{recursive:true,force:true});
}

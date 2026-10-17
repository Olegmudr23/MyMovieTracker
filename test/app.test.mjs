import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
test('Accounts, private tracking, public sharing, comments, recommendations and restart',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'kinocircle-test-'));const file=join(dir,'test.sqlite');let child;
 async function start(){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'31987',DATABASE_PATH:file,KINOPOISK_API_KEY:'',COOKIE_SECURE:'0'},stdio:['ignore','pipe','pipe']});let logs='';child.stderr.on('data',d=>logs+=d);await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(new Error('Server exited '+code+logs)));setTimeout(()=>reject(new Error('Server startup timeout '+logs)),5000).unref();});}
 async function stop(){if(!child||child.exitCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
 t.after(stop);await start();
 async function req(path,method='GET',data,cookie,origin){const r=await fetch('http://localhost:31987'+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{}),...(origin?{origin}:{})},body:data?JSON.stringify(data):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers};}
 const page=await fetch('http://localhost:31987/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await page.text(),/lang="ru"/);
 assert.equal((await req('/api/library')).status,401);
 assert.equal((await req('/api/register','POST',{email:'a@test.test',name:'A',password:'short'})).status,400);
 const a=await req('/api/register','POST',{email:'a@test.test',name:'Alice',password:'good-password-123'});assert.equal(a.status,200);assert.match(a.headers.get('set-cookie'),/HttpOnly/);assert.match(a.headers.get('set-cookie'),/SameSite=Lax/);
 const b=await req('/api/register','POST',{email:'b@test.test',name:'Bob',password:'good-password-123'});assert.equal(b.status,200);
 assert.equal((await req('/api/login','POST',{email:'A@test.test',password:'good-password-123'})).status,200);
 assert.equal((await req('/api/login','POST',{email:'a@test.test',password:'wrong'})).status,401);
 const catalog=await req('/api/catalog?q=Дюна');assert.equal(catalog.body.movies.length,1);assert.equal(catalog.body.demo,true);
 assert.equal((await req('/api/library','POST',{id:'demo-1',status:'watched',rating:9},a.cookie,'https://evil.test')).status,403);
 assert.equal((await req('/api/library','POST',{id:'demo-1',status:'watched',rating:11},a.cookie)).status,400);
 assert.equal((await req('/api/library','POST',{id:'demo-1',status:'watched',rating:9},a.cookie)).status,200);
 await req('/api/library','POST',{id:'demo-2',status:'watching',episode:3},a.cookie);
 assert.equal((await req('/api/library','GET',null,b.cookie)).body.length,0);
 const shared=await req('/api/shared/'+a.body.slug);assert.equal(shared.body.items.length,1);assert.equal(shared.body.items[0].myRating,9);assert.equal(shared.body.user.email,undefined);
 const comment='<script>alert(1)</script>';assert.equal((await req('/api/comments','POST',{id:'demo-1',text:comment},a.cookie)).status,201);assert.equal((await req('/api/movies/demo-1')).body.comments[0].text,comment);
 assert.equal((await req('/api/recommendations','POST',{id:'demo-1',email:'b@test.test',text:'Посмотри!'},a.cookie)).status,201);const recs=(await req('/api/recommendations','GET',null,b.cookie)).body;assert.equal(recs[0].name,'Alice');assert.equal(recs[0].movie.id,'demo-1');
 const inspection=new DatabaseSync(file);const row=inspection.prepare('SELECT * FROM users WHERE id=?').get(a.body.id);assert.notEqual(row.email,'a@test.test');assert.equal(row.email.length,64);assert.notEqual(row.password,'good-password-123');assert.match(row.password,/^[a-f0-9]{32}:[a-f0-9]{128}$/);inspection.close();
 await stop();await start();assert.equal((await req('/api/library','GET',null,a.cookie)).body.length,2);assert.equal((await req('/api/login','POST',{email:'a@test.test',password:'good-password-123'})).status,200);
 await req('/api/logout','POST',{},a.cookie);assert.equal((await req('/api/library','GET',null,a.cookie)).status,401);
 assert.equal((await req('/api/library','DELETE',{id:'demo-1'},b.cookie)).status,200);
});

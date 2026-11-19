import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app/admin_web.py', import.meta.url), 'utf8');
const script = source.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/)[1];
const elements = new Map();
const all = [];
class Element {
  constructor(tag='div') { this.tagName=tag.toUpperCase(); this.children=[]; this.handlers={}; this.value=''; this.hidden=false; this.disabled=false; this.textContent=''; this.open=false; all.push(this); }
  addEventListener(name, callback) { this.handlers[name]=callback; }
  setAttribute(name,value) { this[name]=value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children=[...nodes]; }
  showModal() { this.open=true; }
  close() { this.open=false; this.handlers.close?.(); }
  remove() {}
  select() {}
  fire(name) { this.handlers[name]?.({preventDefault(){}}); }
}
const ids = ['status','loginCard','loginForm','password','dashboard','refresh','logout','users','invites','secretValue','secretDialog','usersPrev','usersNext','invitesPrev','invitesNext','defaultLimit','globalLimit','publicEnabled','userCount','resetAt','usersPage','inviteTotal','invitesPage','configForm','inviteForm','inviteCount','inviteDays','secretTitle','copySecret','closeSecret'];
for (const id of ids) { const el=new Element(/Form$/.test(id)?'form':/Prev|Next|refresh|logout|Secret/.test(id)?'button':'div'); el.id=id; elements.set(id,el); }
const get=id=>elements.get(id);
get('password').value='synthetic-admin-password';
get('inviteCount').value='1'; get('inviteDays').value='7';
const requests=[];
let expire=false;
const user={id:'synthetic-user',username:'<img src=x onerror=alert(1)>',enabled:true,managed_eligible:true,weekly_used:0,weekly_reserved:0,weekly_remaining:5,weekly_limit_override:null,total_requests:0,calls_by_kind:{chat:0}};
const config={user_weekly_limit:5,weekly_limit:350,public_enabled:true};
const pages={users:{users:[user],total:1,week:'2026-11-16',reset_at:'2026-11-23T00:00:00+08:00'},invites:{invitations:[{id:'invite-1',code:'synthetic-unused-code',expires_at:'2026-11-23T00:00:00+08:00'}],total:1}};
const windowHandlers = {};
const sandbox = {document:{getElementById:get,createElement:tag=>new Element(tag),querySelectorAll:()=>all.filter(e=>e.tagName==='BUTTON'),body:new Element('body'),execCommand:()=>true},location:{pathname:'/deepseek-api/admin'},window:{addEventListener(name, fn){windowHandlers[name]=fn;}},navigator:{clipboard:{writeText:async()=>{}}},confirm:()=>true,Intl,Date,Number,JSON,encodeURIComponent,AbortController,setTimeout,clearTimeout,console,
 fetch:async(url,options)=>{requests.push({url,...options});let status=200;let result={};if(url.endsWith('/session'))result={token:'synthetic-memory-only-token'};else if(expire){status=401;result={detail:'expired'};}else if(url.endsWith('/config'))result=config;else if(url.includes('/users?'))result=pages.users;else if(url.includes('/registration-invites'))result=pages.invites;else if(url.endsWith('/revoke-managed')){user.managed_eligible=false;result={id:user.id,managed_eligible:false};}else if(url.endsWith('/quota')){result={};}else throw new Error('Unexpected route '+url);return {ok:status===200,status,json:async()=>result};}};
vm.runInNewContext(script,sandbox);
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
windowHandlers.pageshow();await settle();
assert.equal(get('dashboard').hidden,false);assert.equal(get('loginCard').hidden,true);
assert.equal(requests[0].url,'/deepseek-api/v1/admin/session');assert.equal(requests[0].credentials,'same-origin');
assert.equal(requests.find(x=>x.url.endsWith('/config')).headers.Authorization,'Bearer synthetic-memory-only-token');
assert.equal(get('users').children[0].children[0].textContent,user.username);
assert.equal(get('invites').children[0].children[0].children[0].value,'synthetic-unused-code');
const row=get('users').children[0];row.children[5].children[0].value='3';row.children[7].children[0].children[0].fire('click');await settle();
const quota=requests.find(x=>x.url.endsWith('/quota'));assert.deepEqual(JSON.parse(quota.body),{this_week_remaining:3,week:'2026-11-16'});assert.equal(quota.method,'PATCH');
assert.equal(row.children[2].textContent,'可用免费服务');
const revoke=get('users').children[0].children[7].children[0].children.find(button=>button.textContent==='取消免费资格');
revoke.fire('click');await settle();
assert.equal(requests.find(call=>call.url.endsWith('/revoke-managed')).method,'POST');
const revoked=get('users').children[0];
assert.equal(revoked.children[2].textContent,'个人 Key');
const controls=revoked.children[7].children[0].children;
assert.equal(controls.length,1);assert.equal(controls[0].tagName,'DETAILS');
assert.deepEqual(controls[0].children[1].children.map(button=>button.textContent),['停用','重置密码']);
get('defaultLimit').value='12';get('configForm').fire('submit');await settle();
const patch=requests.find(x=>x.url.endsWith('/config')&&x.method==='PATCH');assert.deepEqual(JSON.parse(patch.body),{user_weekly_limit:12,weekly_limit:350,public_enabled:true});
expire=true;get('refresh').fire('click');await settle();assert.equal(get('dashboard').hidden,true);assert.equal(get('loginCard').hidden,false);assert.equal(get('users').children.length,0);assert.match(get('status').textContent,/登录/);
console.log('Administration forms, weekly patches, inert user text and expired-session handling passed.');

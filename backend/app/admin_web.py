"""Small administration page; all state-changing actions use existing bearer APIs."""
import asyncio
import html
import secrets
from urllib.parse import parse_qs

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from .accounts import SESSION_SECONDS
from .admin_access import _client_ip, admin_cookie_active, require_admin_origin
from .chat import ChatError, _body
from .store import ServiceError


_PAGE = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek 管理</title><style nonce="__NONCE__">
*{box-sizing:border-box}body{margin:0;background:#f5f6fa;color:#252936;font:15px/1.6 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:28px 20px 60px}h1{font-size:25px;margin:0}h2{font-size:18px;margin:0 0 16px}p{margin:6px 0;color:#737a8c}.top,.row,.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.top{justify-content:space-between;margin-bottom:24px}.card{background:white;border:1px solid #e5e8ef;border-radius:16px;padding:22px;margin-top:18px}.login{max-width:400px;margin:12vh auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}label{display:block;font-size:13px;color:#596176}input,button{font:inherit;min-height:42px;border-radius:9px}input{border:1px solid #d6dce8;padding:7px 10px;width:100%;background:transparent;color:inherit;margin:5px 0}input[type=checkbox]{width:18px;min-height:18px;margin-right:8px}button{border:0;background:#4d6bfe;color:white;padding:8px 15px;cursor:pointer;white-space:nowrap}button.secondary{background:#edf0f7;color:#405171}button.danger{background:#fff0f0;color:#b83d46}button:disabled{opacity:.45;cursor:wait}a{color:#4d6bfe;text-decoration:none}.note{font-size:13px}.status{min-height:28px;margin:12px 0;color:#347254;overflow-wrap:anywhere}.status.error{color:#b83737}.table{overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:14px}th,td{text-align:left;border-bottom:1px solid #e8ebf1;padding:12px 10px}th{font-size:12px;color:#737a8c;font-weight:500}td input{width:104px;min-height:38px}td button{min-height:36px;font-size:13px;padding:6px 10px}.more-actions summary{cursor:pointer;color:inherit;padding:6px 0}.more-actions .actions{gap:6px}.badge{font-size:12px;padding:3px 7px;background:#edf5f1;color:#3b7256;border-radius:6px}.badge.off{background:#fff0f0;color:#b83d46}.pager{justify-content:flex-end;margin-top:16px}.code{font:13px ui-monospace,monospace;min-width:260px}.empty{text-align:center;color:#737a8c;padding:24px}.spacer{margin-top:18px}dialog{border:1px solid #d8deea;border-radius:16px;padding:24px;width:min(92vw,460px);color:inherit;background:white}dialog::backdrop{background:#17203a66}[hidden]{display:none!important}small{color:#737a8c}@media(max-width:600px){main{padding:20px 12px}.card{padding:16px}.top{align-items:flex-start}h1{font-size:22px}}@media(prefers-color-scheme:dark){body{background:#17191f;color:#e3e6ef}.card,dialog{background:#22252d;border-color:#383e4a}input{border-color:#4c5363}th,td{border-color:#383e4a}p,th,label,small{color:#a0a8ba}button.secondary{background:#343d52;color:#dbe5ff}}
.permission-options{display:flex;flex-wrap:wrap;gap:4px 16px;min-width:0;border:0;padding:0;margin:12px 0}
.permission-options legend{font-size:13px;margin-bottom:4px;padding:0}
.permission-options label{display:inline-flex;align-items:center;gap:7px;min-height:36px;white-space:nowrap}
.permission-options input[type=checkbox]{height:18px;margin:0;accent-color:#4d6bfe}
.permission-cell{min-width:138px;max-width:170px;white-space:normal}
.permission-cell small{display:block;margin-bottom:4px}
</style></head><body><main>
<header class="top"><div><h1>DeepSeek 管理</h1><p>账号、服务权限与每周额度</p></div><nav class="actions"><a href="/deepseek/">返回聊天</a><button id="refresh" class="secondary" hidden>刷新</button><button id="logout" class="secondary" hidden>退出登录</button></nav></header>
<div id="status" class="status" role="status" aria-live="polite"></div>
<section id="loginCard" class="card login" hidden><a href="/deepseek-api/admin">重新登录管理后台</a></section>
<div id="dashboard" hidden>
<p id="storageStatus" role="status"></p>
<section class="card"><h2>免费服务设置</h2><form id="configForm"><div class="grid spacer"><label>默认每周次数<input id="defaultLimit" type="number" min="0" max="1000000" step="1" required></label><label>服务每周总上限<input id="globalLimit" type="number" min="0" max="1000000" step="1" required></label></div><div class="row spacer"><label><input id="publicEnabled" type="checkbox">启用受邀用户免费服务</label><button type="submit">保存设置</button></div></form><p class="note spacer">每周一零点（北京时间）刷新。未单独设置上限的账号按默认次数使用。</p></section>
<section class="card"><h2>全局功能开放</h2>
<p class="note">开启的功能对所有已登录账号开放。关闭后按各账号的权限判断。</p>
<form id="featureAccessForm">
<fieldset id="featureAccessPermissions" class="permission-options"><legend>开放项目</legend></fieldset>
<button type="submit">保存开放设置</button></form>
<p class="note spacer">配套聊天和生图受每周额度及服务配置限制。云同步由用户自行开启。</p></section>
<section class="card"><h2>自助注册</h2><form id="registrationPolicyForm" class="row"><label><input id="selfServiceRegistration" type="checkbox">允许免邀请码注册</label><button type="submit">保存注册设置</button></form>
<p class="note spacer">普通账号可开启多端同步。关闭后，新用户可用邀请码注册，已有账号继续使用。</p></section>
<section class="card"><div class="top"><div><h2>注册用户</h2><p id="userCount" class="note"></p></div><small id="resetAt"></small></div><div class="table"><table><thead><tr><th>账号</th><th>状态</th><th>账号权限</th><th>本周已用 / 预留</th><th>个人每周次数</th><th>本周剩余</th><th>累计调用</th><th>操作</th></tr></thead><tbody id="users"></tbody></table></div><div class="row pager"><button id="usersPrev" class="secondary">上一页</button><span id="usersPage"></span><button id="usersNext" class="secondary">下一页</button></div><p class="note">聊天和生图共用额度。个人次数留空表示跟随默认值。“本周剩余”仅调整当前周，不修改已用记录。</p></section>
<section class="card"><h2>邀请码</h2><p class="note">邀请码可在注册时使用，也可以由符合条件的普通账号在登录后兑换。每个邀请码只能使用一次。</p>
<form id="inviteForm"><div class="row"><label>生成数量<input id="inviteCount" type="number" min="1" max="100" value="1" required></label><label>有效天数<input id="inviteDays" type="number" min="1" max="365" value="7" required></label></div>
<fieldset id="invitePermissions" class="permission-options"><legend>注册时开通</legend></fieldset><button type="submit">生成邀请码</button></form>
<p id="inviteTotal" class="note spacer"></p><div class="table"><table><thead><tr><th>邀请码</th><th>有效期</th><th>服务权限</th><th>操作</th></tr></thead><tbody id="invites"></tbody></table></div><div class="row pager"><button id="invitesPrev" class="secondary">上一页</button><span id="invitesPage"></span><button id="invitesNext" class="secondary">下一页</button></div></section>
</div>
<dialog id="permissionsDialog" aria-labelledby="permissionsTitle"><h2 id="permissionsTitle">编辑权限</h2>
<form id="permissionsForm"><fieldset id="userPermissions" class="permission-options"><legend>单独授予的功能</legend></fieldset>
<p class="note">关闭全局开放后，按这里保存的权限判断。</p>
<p id="permissionsError" class="status error" role="alert" hidden></p>
<div class="actions spacer"><button id="cancelPermissions" class="secondary" type="button">取消</button><button type="submit">保存</button></div></form></dialog>
<dialog id="secretDialog"><h2 id="secretTitle">新密码</h2><p>请复制后安全地交给对应用户。关闭后本页不会继续保留。</p><input id="secretValue" readonly aria-label="新密码"><div class="actions spacer"><button id="copySecret">复制密码</button><button id="closeSecret" class="secondary">关闭</button></div></dialog>
</main><script nonce="__NONCE__">
'use strict';
(() => {
const $ = id => document.getElementById(id);
const base = location.pathname.replace(/\/admin\/?$/, '');
const apiBase = base + '/v1/admin';
let token = '', busy = false, settings = null, usersOffset = 0, invitesOffset = 0, userResult = null, inviteResult = null;
let permissionsUser = null;
const pageSize = 50;
const permissionLabels = {chat_api:'聊天 API', image_api:'生图 API', cloud_sync:'云同步'};
const notice = (message, error=false) => { $('status').textContent = message; $('status').className = error ? 'status error' : 'status'; };
const element = (tag, text, cls='') => { const node = document.createElement(tag); if(text!==undefined) node.textContent=String(text); if(cls) node.className=cls; return node; };
const loggedOut = () => { token=''; settings=null; userResult=null; inviteResult=null; permissionsUser=null; $('dashboard').hidden=true; $('loginCard').hidden=false; $('refresh').hidden=true; $('logout').hidden=true; $('users').replaceChildren(); $('invites').replaceChildren(); $('secretValue').value=''; if($('secretDialog').open) $('secretDialog').close(); if($('permissionsDialog').open) $('permissionsDialog').close(); };
const updateDisabled = () => { document.querySelectorAll('button').forEach(b => b.disabled=busy); $('userPermissions').disabled=busy; $('invitePermissions').disabled=busy; $('featureAccessPermissions').disabled=busy; if(!busy){ $('usersPrev').disabled=usersOffset===0; $('usersNext').disabled=!userResult||usersOffset+pageSize>=userResult.total; $('invitesPrev').disabled=invitesOffset===0; $('invitesNext').disabled=!inviteResult||invitesOffset+pageSize>=inviteResult.total; } };
async function run(action){ if(busy) return; busy=true; updateDisabled(); try{await action();}catch(error){notice(error.message||'操作未完成，请重试。',true);}finally{busy=false;updateDisabled();} }
async function request(path, method='GET', body){ const abort=new AbortController(); const timer=setTimeout(()=>abort.abort(),20000); let response; try{response=await fetch(apiBase+path,{method,credentials:(path==='/session'||path==='/logout')?'same-origin':'omit',cache:'no-store',redirect:'error',headers:{'Accept':'application/json',...(token?{'Authorization':'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:abort.signal});}catch(error){throw new Error(error.name==='AbortError'?'请求超时，操作结果尚未确认；请刷新后查看。':'网络连接失败，操作结果尚未确认；请刷新后查看。');}finally{clearTimeout(timer);} let result;try{result=await response.json();}catch{throw new Error('服务器响应无法识别，请稍后重试。');} if(!response.ok){if(response.status===401&&token){loggedOut();throw new Error('管理登录已过期，请重新登录。');}throw new Error(typeof result.detail==='string'?result.detail:'操作失败（'+response.status+'），请检查填写内容。');}return result; }
function numeric(input, blank=false){if(blank&&input.value.trim()==='')return null;const number=Number(input.value);if(!Number.isSafeInteger(number)||number<0||number>1000000)throw new Error('次数须为 0 到 1000000 的整数。');return number;}
const dateText = value => {const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(date);};
async function copy(value){try{await navigator.clipboard.writeText(value);notice('已复制。');}catch{const input=element('input');input.value=value;document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();if(!ok)throw new Error('复制未完成，请长按文本手动复制。');notice('已复制。');}}
function emptyRow(parent,columns,message){const row=element('tr');const cell=element('td',message,'empty');cell.colSpan=columns;row.append(cell);parent.append(row);}
function renderConfig(config){settings=config;$('defaultLimit').value=config.user_weekly_limit;$('globalLimit').value=config.weekly_limit;$('publicEnabled').checked=config.public_enabled;}
function permissionsFor(record, fallback=record.managed_eligible === true) {
  return Object.fromEntries(Object.keys(permissionLabels).map(key => [
    key, record.permissions == null ? fallback : record.permissions[key] === true,
  ]));
}
function permissionsSummary(permissions) {
  return Object.entries(permissionLabels)
    .filter(([key]) => permissions[key])
    .map(([, label]) => label).join(' · ') || '未开通';
}
function addPermissionControls(fieldset, checked) {
  for (const [key, name] of Object.entries(permissionLabels)) {
    const label = element('label');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.name = key;
    checkbox.checked = checked;
    label.append(checkbox, name);
    fieldset.append(label);
  }
}
function readPermissions(fieldset) {
  return Object.fromEntries(Object.keys(permissionLabels).map(key => [key, fieldset.elements.namedItem(key).checked]));
}
function writePermissions(fieldset, permissions) {
  for (const key of Object.keys(permissionLabels)) {
    fieldset.elements.namedItem(key).checked = permissions[key] === true;
  }
}
function openPermissions(user) {
  permissionsUser = user;
  $('permissionsTitle').textContent = '编辑 ' + user.username + ' 的权限';
  $('permissionsError').hidden = true;
  writePermissions($('userPermissions'), permissionsFor(user));
  $('permissionsDialog').showModal();
}
function quotaInput(value, label) {
  const input = element('input');
  input.type = 'number';
  input.min = '0';
  input.max = '1000000';
  input.value = value ?? '';
  input.setAttribute('aria-label', label);
  return input;
}
function renderUsers(result) {
  userResult = result;
  $('users').replaceChildren();
  $('userCount').textContent = '共 ' + result.total + ' 个注册账号';
  $('resetAt').textContent = '下次刷新：' + dateText(result.reset_at);
  $('usersPage').textContent = Math.floor(usersOffset/pageSize)+1 + ' / ' + Math.max(1, Math.ceil(result.total/pageSize));
  if (!result.users.length) emptyRow($('users'), 8, '暂无注册用户');
  for (const user of result.users) {
    const row = element('tr');
    const permissions = permissionsFor(user);
    const effective = user.effective_permissions;
    const hasQuota = permissions.chat_api || permissions.image_api || effective.chat_api || effective.image_api;
    const userPath = '/users/' + encodeURIComponent(user.id);
    const state = element('td');
    state.append(element('span', user.enabled ? '正常' : '已停用', 'badge' + (user.enabled ? '' : ' off')));
    const grant = element('td', undefined, 'permission-cell');
    const edit = element('button', '编辑权限', 'secondary');
    edit.setAttribute('aria-label', '编辑 ' + user.username + ' 的权限');
    edit.addEventListener('click', () => openPermissions(user));
    grant.append(element('small', permissionsSummary(permissions)));
    const inherited = Object.entries(permissionLabels).filter(([key]) => effective[key] && !permissions[key])
      .map(([, label]) => label);
    if (inherited.length) grant.append(element('small', '全局开放 ' + inherited.join(' · ')));
    grant.append(edit);
    row.append(element('td', user.username), state, grant,
      element('td', hasQuota ? user.weekly_used + ' / ' + user.weekly_reserved : '—'));

    const overrideCell = element('td');
    const remainingCell = element('td');
    const actions = element('td');
    const group = element('div', undefined, 'actions');
    if (hasQuota) {
      const override = quotaInput(user.weekly_limit_override, user.username + '的每周次数');
      override.placeholder = '默认';
      const remaining = quotaInput(user.weekly_remaining, user.username + '的本周剩余');
      overrideCell.append(override);
      remainingCell.append(remaining);
      const save = element('button', '保存额度');
      save.addEventListener('click', () => run(async () => {
        const changes = {};
        const cap = numeric(override, true);
        const left = numeric(remaining);
        if (cap !== user.weekly_limit_override) changes.weekly_limit = cap;
        if (left !== user.weekly_remaining) {
          changes.this_week_remaining = left;
          changes.week = result.week;
        }
        if (!Object.keys(changes).length) {
          notice('没有需要保存的变化。');
          return;
        }
        await request(userPath + '/quota', 'PATCH', changes);
        await loadUsers();
        notice('已更新 ' + user.username + ' 的额度。');
      }));
      group.append(save);
    } else {
      overrideCell.textContent = '—';
      remainingCell.textContent = '—';
    }
    const total = element('td', user.total_requests);
    const names = {organize:'整理', chat:'聊天', file:'附件', asr:'识音', tts:'朗读', image:'生图'};
    if (user.calls_by_kind) {
      total.title = Object.entries(user.calls_by_kind).map(([kind, count]) => (names[kind] || kind) + ' ' + count).join(' / ');
    }
    const toggle = element('button', user.enabled ? '停用' : '启用', user.enabled ? 'danger' : 'secondary');
    toggle.addEventListener('click', () => run(async () => {
      await request(userPath + '/status', 'PATCH', {enabled: !user.enabled});
      await loadUsers();
      notice('账号已' + (user.enabled ? '停用' : '启用') + '。');
    }));
    const reset = element('button', '重置密码', 'secondary');
    reset.addEventListener('click', () => {
      if (!confirm('为 ' + user.username + ' 生成新密码？该账号需要重新登录。')) return;
      run(async () => {
        const data = await request(userPath + '/reset-password', 'POST');
        $('secretTitle').textContent = user.username + ' 的新密码';
        $('secretValue').value = data.password;
        $('secretDialog').showModal();
        notice('密码已重置。');
      });
    });
    const more = element('details', undefined, 'more-actions');
    const accountActions = element('div', undefined, 'actions');
    accountActions.append(toggle, reset);
    more.append(element('summary', '账号操作'), accountActions);
    group.append(more);
    actions.append(group);
    row.append(overrideCell, remainingCell, total, actions);
    $('users').append(row);
  }
}
function renderInvites(result) {
  inviteResult = result;
  $('invites').replaceChildren();
  $('inviteTotal').textContent = '共 ' + result.total + ' 个未使用且有效的邀请码';
  $('invitesPage').textContent = Math.floor(invitesOffset/pageSize)+1 + ' / ' + Math.max(1, Math.ceil(result.total/pageSize));
  if (!result.invitations.length) emptyRow($('invites'), 4, '暂无可用邀请码');
  for (const invite of result.invitations) {
    const row = element('tr');
    const cell = element('td');
    const code = element('input');
    code.className = 'code';
    code.readOnly = true;
    code.value = invite.code || '不可显示';
    code.setAttribute('aria-label', '邀请码');
    code.addEventListener('click', () => code.select());
    cell.append(code);
    const copyCell = element('td');
    const button = element('button', '复制', 'secondary');
    button.disabled = !invite.code;
    button.addEventListener('click', () => run(() => copy(invite.code)));
    copyCell.append(button);
    row.append(cell, element('td', dateText(invite.expires_at)),
      element('td', permissionsSummary(permissionsFor(invite, true)), 'permission-cell'), copyCell);
    $('invites').append(row);
  }
}
async function loadUsers(){renderUsers(await request('/users?limit='+pageSize+'&offset='+usersOffset));}
async function loadInvites(){renderInvites(await request('/registration-invites?limit='+pageSize+'&offset='+invitesOffset));}
async function refresh() {
  const [config, features, registration, users, invites] = await Promise.all([
    request('/config'),
    request('/account-feature-access'),
    request('/registration-policy'),
    request('/users?limit='+pageSize+'&offset='+usersOffset),
    request('/registration-invites?limit='+pageSize+'&offset='+invitesOffset),
  ]);
  renderConfig(config);
  writePermissions($('featureAccessPermissions'), features);
  $('selfServiceRegistration').checked = registration.self_service === true;
  renderUsers(users);
  renderInvites(invites);
  try {
    const s = await request('/storage');
    const gib = n => (n/1073741824).toFixed(2);
    $('storageStatus').textContent = (s.warning?'空间预警 · ':'')+'同步 '+gib(s.sync)+' / '+gib(s.sync_limit)+' GiB · 公开分享 '+gib(s.shares)+' / '+gib(s.shares_limit)+' GiB · 磁盘可用 '+gib(s.disk_free)+' GiB';
  } catch {
    $('storageStatus').textContent = '暂时无法读取存储用量';
  }
}
async function enterDashboard(){try{const result=await request('/session','POST');token=result.token;if(typeof token!=='string'||!token)throw new Error('请重新登录管理后台。');await refresh();$('loginCard').hidden=true;$('dashboard').hidden=false;$('refresh').hidden=false;$('logout').hidden=false;}catch(error){loggedOut();throw error;}}
$('configForm').addEventListener('submit',event=>{event.preventDefault();run(async()=>{await request('/config','PATCH',{user_weekly_limit:numeric($('defaultLimit')),weekly_limit:numeric($('globalLimit')),public_enabled:$('publicEnabled').checked});await refresh();notice('设置已保存。');});});
$('registrationPolicyForm').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const control = $('selfServiceRegistration');
    const saved = await request('/registration-policy', 'PATCH', {self_service:control.checked});
    control.checked = saved.self_service === true;
    notice('注册设置已保存。');
  });
});
addPermissionControls($('userPermissions'), false);
addPermissionControls($('invitePermissions'), true);
addPermissionControls($('featureAccessPermissions'), false);
$('featureAccessForm').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const fieldset = $('featureAccessPermissions');
    const saved = await request('/account-feature-access', 'PATCH', readPermissions(fieldset));
    writePermissions(fieldset, saved);
    try {
      await loadUsers();
    } catch {
      notice('开放设置已保存，暂时无法刷新用户列表。', true);
      return;
    }
    notice('全局开放设置已保存。');
  });
});
$('permissionsForm').addEventListener('submit', event => {
  event.preventDefault();
  const user = permissionsUser;
  if (!user || busy) return;
  const original = permissionsFor(user);
  const permissions = readPermissions($('userPermissions'));
  const unchanged = Object.keys(permissions).every(key => permissions[key] === original[key]);
  const lockLegacyRedemption = user.invite_redeemable === true && !Object.values(permissions).some(Boolean);
  if (unchanged && !lockLegacyRedemption) {
    $('permissionsDialog').close();
    return;
  }
  const errorMessage = $('permissionsError');
  errorMessage.hidden = true;
  run(async () => {
    try {
      await request('/users/' + encodeURIComponent(user.id) + '/permissions', 'PATCH', permissions);
    } catch (error) {
      if ($('permissionsDialog').open) {
        errorMessage.textContent = error.message;
        errorMessage.hidden = false;
      }
      throw error;
    }
    $('permissionsDialog').close();
    try {
      await loadUsers();
    } catch {
      notice('权限已保存，暂时无法刷新列表。', true);
      return;
    }
    notice('已更新 ' + user.username + ' 的权限。');
  });
});
$('cancelPermissions').addEventListener('click', () => $('permissionsDialog').close());
$('permissionsDialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('permissionsDialog').addEventListener('close', () => { permissionsUser = null; });
$('inviteForm').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    await request('/registration-invites', 'POST', {
      count: numeric($('inviteCount')),
      valid_days: numeric($('inviteDays')),
      permissions: readPermissions($('invitePermissions')),
    });
    invitesOffset = 0;
    await loadInvites();
    notice('邀请码已生成，可从列表复制。');
  });
});
$('refresh').addEventListener('click',()=>run(async()=>{await refresh();notice('已刷新。');}));$('logout').addEventListener('click',()=>run(async()=>{await request('/logout','POST');loggedOut();location.replace('/deepseek/');}));
$('usersPrev').addEventListener('click',()=>run(async()=>{usersOffset=Math.max(0,usersOffset-pageSize);await loadUsers();}));$('usersNext').addEventListener('click',()=>run(async()=>{usersOffset+=pageSize;await loadUsers();}));$('invitesPrev').addEventListener('click',()=>run(async()=>{invitesOffset=Math.max(0,invitesOffset-pageSize);await loadInvites();}));$('invitesNext').addEventListener('click',()=>run(async()=>{invitesOffset+=pageSize;await loadInvites();}));
$('copySecret').addEventListener('click',()=>run(()=>copy($('secretValue').value)));$('closeSecret').addEventListener('click',()=>{$('secretDialog').close();});$('secretDialog').addEventListener('close',()=>{$('secretValue').value='';});
window.addEventListener('pagehide',loggedOut);window.addEventListener('pageshow',()=>run(enterDashboard));updateDisabled();
})();
</script></body></html>'''


_LOGIN = _PAGE.split('<body>')[0] + """<body><main><section class="card login">
<h1>登录管理后台</h1><form method="post" action="/deepseek-api/admin">
<label for="username">管理员账号</label><input id="username" name="username" autocomplete="username" required maxlength="32">
<label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128">
<p role="alert" class="status error">__ERROR__</p><div class="actions spacer"><button type="submit">登录</button><a href="/deepseek/">返回聊天</a></div>
</form></section></main></body></html>"""


def _page(template, error="", status=200):
    nonce = secrets.token_urlsafe(24)
    return HTMLResponse(template.replace("__NONCE__", nonce).replace("__ERROR__", html.escape(error)), status_code=status,
        headers={"Cache-Control": "no-store",
                 "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
                 "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY"})


def build_admin_web_router(store):
    router = APIRouter(tags=["administration-web"])

    @router.get("/admin", response_class=HTMLResponse, include_in_schema=False)
    def administration_page(request: Request):
        return _page(_PAGE if admin_cookie_active(store, request) else _LOGIN)

    @router.post("/admin", include_in_schema=False)
    async def administration_login(request: Request):
        require_admin_origin(request)
        try:
            fields = parse_qs((await _body(request, 4096)).decode("utf-8"), max_num_fields=2)
            username, password = fields["username"][0], fields["password"][0]
            account = await asyncio.to_thread(store.accounts.login, username, password, _client_ip(request), admin_only=True)
        except (ValueError, KeyError, UnicodeError):
            return _page(_LOGIN, "请填写管理员账号和密码", 400)
        except (ChatError, ServiceError) as error:
            return _page(_LOGIN, error.message, error.status)
        response = RedirectResponse("/deepseek-api/admin", status_code=303, headers={"Cache-Control": "no-store"})
        response.set_cookie("deepseek_session", account["token"], max_age=SESSION_SECONDS, path="/deepseek-api",
                            secure=True, httponly=True, samesite="strict")
        return response

    return router

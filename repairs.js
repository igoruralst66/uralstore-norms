import {STATUSES,FIELDS,EMPTY,money,today,debt,paymentLabel,overdue,validate} from './repairs-model.mjs';

const root=document.getElementById('repairsRoot');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value?new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Yekaterinburg',dateStyle:'short',...(value.length>10?{timeStyle:'short'}:{})}).format(new Date(value.length===10?value+'T12:00:00+05:00':value)):'—';
let client=null,user=null,member=null,rows=[],demo=false,epoch=0,loading=false,editing=null,saving=false,dirty=false,authBusy=false;
let scope='active',query='',filter='all',layout='board',notice='',eventsById={},lastUpdated='';
const dialog=document.createElement('dialog');dialog.id='repairDialog';dialog.setAttribute('aria-labelledby','repairTitle');document.body.append(dialog);
const find=id=>root.querySelector('#'+id);
const field=name=>dialog.querySelector(`[name="${name}"]`);
const showMessage=(target,message,bad=true)=>{target.textContent=message;target.className='repair-message '+(bad?'bad':'ok');};
const friendly=error=>{
  if(error?.code==='40001')return error.message;
  if(error?.code==='23503')return 'Предыдущий заказ не найден. Проверьте номер.';
  if(error?.code==='23514'||error?.code==='23502')return 'Проверьте обязательные поля, суммы и условия закрытия заказа.';
  if(error?.code==='42P01'||error?.code==='PGRST202'||error?.code==='PGRST205')return 'База ремонтов ещё не подключена. Обратитесь к администратору.';
  if(error?.code==='42501')return 'Нет доступа к ремонтам. Обратитесь к администратору.';
  if(/fetch|network|load failed/i.test(error?.message||''))return 'Нет связи с сервером. Данные не сохранены. Повторите при восстановлении связи.';
  return error?.message||'Не удалось выполнить действие. Повторите попытку.';
};
const seed=()=>[
  {...EMPTY,id:100,client:'Демо-клиент 1',device:'iPhone 16 Pro Max',reason:'Замена заднего стекла',owner:'Сотрудник',service:'Сервисный центр',status:'service',next_action:'Уточнить готовность у мастера',due_date:today(),client_total:7000,client_paid:7000,client_paid_date:today(),client_method:'card',service_total:5500,version:1,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},
  {...EMPTY,id:101,client:'Демо-клиент 2',device:'iPhone 14 Pro',reason:'Замена дисплея',owner:'Сотрудник',status:'waiting',waiting_reason:'Согласование цены с клиентом',next_action:'Позвонить клиенту',client_total:15000,client_paid:3000,client_paid_date:today(),service_total:10000,version:1,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},
  {...EMPTY,id:102,client:'Демо-клиент 3',device:'iPhone 13',reason:'Замена аккумулятора',owner:'Сотрудник',status:'ready',next_action:'Выдать устройство клиенту',client_total:6000,service_total:4000,service_paid:4000,service_paid_date:today(),version:1,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}
];
function login(){
  root.innerHTML=`<section class="panel repair-login"><span class="tag">Доступ для сотрудников</span><h2 style="margin-top:16px">Сервисные ремонты</h2><p class="note explain" style="margin-top:10px">Введите своё имя и общий код магазина. Имя сохранится в истории ваших действий.</p><form id="repairLogin"><label for="repairName">Ваше имя</label><input id="repairName" autocomplete="name" maxlength="120" required placeholder="Например: Иван"><label for="repairCode">Код доступа</label><input id="repairCode" type="password" autocomplete="current-password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required placeholder="4 цифры"><button class="primary" type="submit">Открыть ремонты</button></form><p id="repairAuthMessage" class="repair-message" role="status"></p><hr style="border:0;border-top:1px solid var(--line);margin:20px 0"><button id="repairDemo">Посмотреть демо</button><p class="note">Демо содержит вымышленные заказы и не сохраняется в общую базу.</p></section>`;
  find('repairDemo').onclick=()=>{epoch++;demo=true;rows=seed();eventsById={};notice='';scope='active';filter='all';query='';render();};
  const authAction=async action=>{
    if(authBusy)return;authBusy=true;
    root.querySelectorAll('button').forEach(b=>b.disabled=true);
    const output=find('repairAuthMessage');showMessage(output,'Подключение…',false);
    try{if(!client)throw new Error('Библиотека подключения не загрузилась. Обновите страницу.');await action(output);}
    catch(error){showMessage(output,friendly(error));}
    finally{authBusy=false;root.querySelectorAll('button').forEach(b=>b.disabled=false);}
  };
  find('repairLogin').onsubmit=e=>{e.preventDefault();authAction(async()=>{
    const displayName=find('repairName').value.trim(),accessCode=find('repairCode').value;
    if(displayName.length<2)throw new Error('Укажите имя сотрудника.');
    let activeUser=user;
    if(!activeUser){
      const {data,error}=await client.auth.signInAnonymously();
      if(error)throw new Error('Не удалось открыть защищённую сессию. Повторите попытку.');
      activeUser=data.user;user=activeUser;
    }
    const {data:unlockRows,error}=await client.rpc('unlock_repairs',{p_code:accessCode,p_name:displayName});
    if(error){
      if(error.code==='P0001')throw new Error(error.message);
      throw error;
    }
    const unlock=unlockRows?.[0];
    if(!unlock?.ok)throw new Error(unlock?.message||'Неверный код доступа.');
    member=null;rows=[];notice='';await load();
  });};
}
function ticket(row){
  return `<button type="button" class="repair-ticket" data-order="${row.id}"><div class="repair-card-head"><b>№ ${row.id}</b>${overdue(row)?'<span class="repair-badge bad">Срок прошёл</span>':`<span class="note">${esc(STATUSES[row.status])}</span>`}</div><strong>${esc(row.device)}</strong><p class="repair-client">${esc(row.client)}</p><p>${esc(row.reason)}</p><p><b>Дальше:</b> ${esc(row.next_action||'Заказ закрыт')}</p>${row.waiting_reason&&row.status==='waiting'?`<p class="warn">Ждём: ${esc(row.waiting_reason)}</p>`:''}<div class="repair-money"><span class="repair-badge ${debt(row,'client')===0?'ok':'warn'}">${paymentLabel(row)}</span>${debt(row,'service')>0?`<span class="repair-badge warn">Сервису: ${money(debt(row,'service'))}</span>`:''}${row.repeat_of?`<span class="repair-badge">Повтор № ${row.repeat_of}</span>`:''}</div><footer>${esc(row.owner)}${row.due_date?' · до '+date(row.due_date):''}<br>Обновлено ${date(row.updated_at)}</footer></button>`;
}
function visibleRows(){return rows.filter(r=>(scope==='history'?r.status==='closed':r.status!=='closed')&&(filter==='all'||(filter==='due'?(overdue(r)||r.due_date===today()):filter==='debt'?(debt(r,'client')>0||debt(r,'service')>0):r.status===filter))&&[r.id,r.client,r.phone,r.device,r.serial,r.owner].join(' ').toLowerCase().includes(query.toLowerCase()));}
function renderResults(){
  const list=visibleRows();const result=find('repairResults');
  if(!list.length){result.innerHTML=`<div class="panel repair-empty">${rows.length?'Нет заказов по выбранным условиям.':'Пока нет заказов. Нажмите «Новый ремонт».'}</div>`;return;}
  if(layout==='list'&&window.innerWidth>700){
    result.innerHTML=`<div class="panel repair-tablewrap"><table class="repair-table"><thead><tr><th>Заказ / устройство</th><th>Статус</th><th>Следующий шаг</th><th>Клиент</th><th>Сервис</th></tr></thead><tbody>${list.map(r=>`<tr><td><button data-order="${r.id}">№ ${r.id} · ${esc(r.device)}</button><small>${esc(r.client)}</small></td><td>${esc(STATUSES[r.status])}${overdue(r)?'<small class="bad">Срок прошёл</small>':''}</td><td>${esc(r.next_action||'—')}<small>${esc(r.owner)} · ${date(r.due_date)}</small></td><td>${paymentLabel(r)}<small>Остаток: ${money(debt(r,'client'))}</small></td><td>${money(debt(r,'service'))}</td></tr>`).join('')}</tbody></table></div>`;
  }else if(scope==='history'||window.innerWidth<=700){result.innerHTML=list.map(ticket).join('');}
  else result.innerHTML=`<div class="repair-board">${Object.entries(STATUSES).filter(([k])=>k!=='closed').map(([k,title])=>{const group=list.filter(r=>r.status===k);return `<section class="repair-column"><h3>${title}<span>${group.length}</span></h3>${group.map(ticket).join('')||'<p class="repair-empty">Нет заказов</p>'}</section>`;}).join('')}</div>`;
  result.querySelectorAll('[data-order]').forEach(b=>b.onclick=()=>openOrder(Number(b.dataset.order)));
}
function render(){
  const active=rows.filter(r=>r.status!=='closed');
  root.innerHTML=`${demo?'<div class="repair-demo">Демо · вымышленные данные. Изменения исчезнут после выхода из демо или обновления страницы.</div>':''}<div class="repair-head"><div><h2>Сервисные ремонты</h2><p class="note">Заказ, следующий шаг и расчёты в одном месте</p></div><div class="repair-row"><button id="repairReload">Обновить</button><button id="repairSignout">${demo?'Выйти из демо':'Выйти'}</button><button id="repairNew" class="primary">+ Новый ремонт</button></div></div><div class="repair-summary"><div class="card"><span class="note">Активных заказов</span><b>${active.length}</b></div><div class="card"><span class="note">Клиенты должны</span><b>${money(active.reduce((s,r)=>s+(debt(r,'client')||0),0))}</b><span class="detail">Без заказов с неуказанной стоимостью: ${active.filter(r=>r.client_total==null).length}</span></div><div class="card"><span class="note">Мы должны сервисам</span><b>${money(active.reduce((s,r)=>s+(debt(r,'service')||0),0))}</b><span class="detail">Без заказов с неуказанной стоимостью: ${active.filter(r=>r.service_total==null).length}</span></div></div><div class="repair-row"><div><button id="repairActive" ${scope==='active'?'class="primary"':''}>Активные</button> <button id="repairHistory" ${scope==='history'?'class="primary"':''}>История</button></div><div class="repair-switch"><button id="repairBoard" aria-pressed="${layout==='board'}">Доска</button><button id="repairList" aria-pressed="${layout==='list'}">Список</button></div></div><div class="repair-tools"><input id="repairSearch" aria-label="Поиск ремонта" placeholder="Номер, клиент, устройство, сотрудник" value="${esc(query)}"><select id="repairFilter" aria-label="Фильтр ремонтов"><option value="all">Все заказы</option><option value="due">Срок сегодня или прошёл</option><option value="debt">Есть долг</option>${Object.entries(STATUSES).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div><p class="repair-message bad" id="repairNotice" role="status">${esc(notice)}</p><p class="repair-refresh">${demo?'Демонстрационный режим':esc(member?.display_name||'')+' · '+(lastUpdated?'Обновлено '+date(lastUpdated):'Загрузка…')}</p><div id="repairResults"></div>`;
  find('repairFilter').value=filter;
  find('repairSearch').oninput=e=>{query=e.target.value;renderResults();};find('repairFilter').onchange=e=>{filter=e.target.value;renderResults();};
  find('repairActive').onclick=()=>{scope='active';filter='all';render();};find('repairHistory').onclick=()=>{scope='history';filter='all';render();};
  find('repairBoard').onclick=()=>{layout='board';render();};find('repairList').onclick=()=>{layout='list';render();};
  find('repairNew').onclick=()=>openOrder();find('repairReload').onclick=()=>demo?render():load();find('repairSignout').onclick=signout;
  renderResults();
}
function input(name,type='text',required=false){const val=editing[name];return `<div><label for="rf-${name}">${FIELDS[name]}${required?' *':''}</label><input id="rf-${name}" name="${name}" type="${type}" value="${esc(val??'')}" ${required?'required':''} ${type==='number'?'min="0" step="0.01" max="9999999999.99"':type==='date'?'':'maxlength="300"'}></div>`;}
function area(name,required=false){return `<div class="repair-wide"><label for="rf-${name}">${FIELDS[name]}${required?' *':''}</label><textarea id="rf-${name}" name="${name}" maxlength="${name==='notes'?10000:3000}" ${required?'required':''}>${esc(editing[name])}</textarea></div>`;}
function payment(side,title){return `<section class="repair-payment"><h4>${title}</h4>${input(side+'_total','number')}${input(side+'_paid','number')}<div class="repair-pay-action"><span id="${side}PaymentState" class="repair-badge"></span><button type="button" data-pay="${side}">${side==='client'?'Оплачено клиентом':'Оплачено сервису'}</button></div><span id="${side}Debt" class="note"></span>${input(side+'_paid_date','date')}${side==='client'?`<div><label for="rf-client_method">Способ оплаты</label><select id="rf-client_method" name="client_method"><option value="">Не указан</option><option value="cash">Наличные</option><option value="card">Карта</option><option value="transfer">Перевод</option><option value="other">Другое / смешанная</option></select></div>`:''}</section>`;}
function formData(){const data={};for(const k of Object.keys(EMPTY)){const node=field(k);data[k]=node.type==='checkbox'?node.checked:node.value.trim();}for(const key of ['client_total','service_total','repeat_of'])data[key]=data[key]===''?null:Number(data[key]);for(const key of ['client_paid','service_paid'])data[key]=Number(data[key]||0);for(const key of ['due_date','client_paid_date','service_paid_date'])data[key]=data[key]||null;return data;}
function paymentState(){const data=formData();for(const side of ['client','service']){dialog.querySelector('#'+side+'PaymentState').textContent=paymentLabel(data,side);dialog.querySelector('#'+side+'Debt').textContent='Остаток: '+money(debt(data,side));dialog.querySelector(`[data-pay="${side}"]`).disabled=data[side+'_total']!=null&&data[side+'_total']===data[side+'_paid'];}}
function closeOrder(){if(saving)return;if(dirty&&!confirm('Закрыть карточку без сохранения изменений?'))return;dialog.close();dialog.innerHTML='';editing=null;dirty=false;}
function displayValue(k,v){if(v==null||v==='')return '—';if(k==='status')return STATUSES[v]||v;if(typeof v==='boolean')return v?'Да':'Нет';if(/_(total|paid)$/.test(k))return money(v);if(k==='client_method')return {cash:'Наличные',card:'Карта',transfer:'Перевод',other:'Другое / смешанная'}[v]||'—';return String(v);}
async function history(id,guard){
  const target=dialog.querySelector('#repairTimeline');if(!id){target.innerHTML='<p class="note">История появится после первого сохранения.</p>';return;}
  try{
    let data;if(demo)data=eventsById[id]||[];else{const response=await client.from('repair_events').select('*').eq('repair_id',id).order('id',{ascending:false}).limit(100);if(response.error)throw response.error;data=response.data;}
    if(editing?.id!==id||guard!==epoch||!dialog.open)return;
    target.innerHTML=data.length?`<ol class="repair-timeline">${data.map(e=>`<li><time>${date(e.created_at)} · ${esc(e.actor_name)}</time><p>${esc(e.note)}</p><details><summary>Изменённые поля</summary><dl>${Object.entries(FIELDS).filter(([k])=>JSON.stringify(e.before_data?.[k])!==JSON.stringify(e.after_data[k])).map(([k,label])=>`<dt>${label}</dt><dd>${e.before_data?esc(displayValue(k,e.before_data[k]))+' → ':''}${esc(displayValue(k,e.after_data[k]))}</dd>`).join('')||'<dt>Только комментарий</dt>'}</dl></details></li>`).join('')}</ol>${data.length===100?'<p class="note">Показаны последние 100 событий.</p>':''}`:'<p class="note">Пока нет событий.</p>';
  }catch(error){if(editing?.id===id)target.textContent=friendly(error);}
}
function openOrder(id=null){
  editing=structuredClone(rows.find(r=>r.id===id)||{...EMPTY,owner:member?.display_name||''});dirty=false;
  dialog.innerHTML=`<div class="repair-dialog-inner"><div class="repair-row"><h2 id="repairTitle">${id?'Ремонт № '+id:'Новый ремонт'}</h2><button type="button" id="repairClose">Закрыть</button></div><p class="repair-dialog-sub">${id?'Создан '+date(editing.created_at)+' · Обновлён '+date(editing.updated_at):'Номер будет присвоен при сохранении'}</p><form id="repairForm"><fieldset id="repairFields"><h3>Клиент и устройство</h3><div class="repair-form">${input('client','text',true)}${input('phone','tel')}${input('device','text',true)}${input('serial')}${area('context')}${area('reason',true)}${input('repeat_of','number')}</div><h3>Путь заказа</h3><div class="repair-form">${input('owner','text',true)}${input('service')}${input('approver')}<div><label for="rf-status">Статус</label><select id="rf-status" name="status">${Object.entries(STATUSES).map(([k,v])=>`<option value="${k}" ${k==='closed'&&!['issued','closed'].includes(editing.status)?'disabled':''}>${v}</option>`).join('')}</select></div>${area('waiting_reason')}${area('next_action')}${input('due_date','date')}</div><h3>Расчёты</h3><p class="note">Пустая стоимость — ещё не согласована. 0 ₽ — бесплатная работа. «Оплачено» заполняет полученную сумму полностью; аванс укажите вручную.</p><div class="repair-form">${payment('client','Оплата клиента')}${payment('service','Расчёт с сервисом')}<label class="repair-check repair-wide"><input name="fs_recorded" type="checkbox" ${editing.fs_recorded?'checked':''}>Проведено в FS Склад+</label>${input('fs_reference')}</div><h3>Заметки и действие</h3><div class="repair-form">${area('notes')}<div class="repair-wide"><label for="repairAction">Что сделали сейчас</label><textarea id="repairAction" maxlength="5000" placeholder="Например: позвонил клиенту, согласовал стоимость"></textarea></div></div></fieldset><p id="repairSaveMessage" role="status" class="repair-message"></p><div class="repair-dialog-actions"><button type="button" id="repairCancel">Отмена</button><button type="submit" class="primary" id="repairSave">Сохранить${demo?' в демо':''}</button></div></form><h3>История действий</h3><div id="repairTimeline" aria-live="polite">Загрузка…</div></div>`;
  field('status').value=editing.status;field('client_method').value=editing.client_method;field('repeat_of').step='1';field('repeat_of').min='1';
  dialog.querySelector('#repairClose').onclick=closeOrder;dialog.querySelector('#repairCancel').onclick=closeOrder;
  dialog.querySelector('#repairForm').oninput=()=>{dirty=true;paymentState();};
  dialog.querySelectorAll('[data-pay]').forEach(button=>button.onclick=()=>{
    const side=button.dataset.pay,total=field(side+'_total');if(total.value===''||!total.checkValidity()){showMessage(dialog.querySelector('#repairSaveMessage'),'Сначала укажите согласованную стоимость.');total.focus();return;}
    field(side+'_paid').value=total.value;field(side+'_paid_date').value=Number(total.value)>0?today():'';dirty=true;paymentState();
  });
  dialog.querySelector('#repairForm').onsubmit=save;
  dialog.showModal();paymentState();history(id,epoch);
}
async function save(event){
  event.preventDefault();if(saving)return;
  const data=formData(),message=dialog.querySelector('#repairSaveMessage'),problem=validate(data);if(problem){showMessage(message,problem);return;}
  if(data.status==='closed'&&!['issued','closed'].includes(editing.status)){showMessage(message,'Сначала сохраните статус «Выдан».');return;}
  if(data.repeat_of!=null&&editing.id&&data.repeat_of>=editing.id){showMessage(message,'Укажите более ранний заказ.');return;}
  const note=dialog.querySelector('#repairAction').value.trim();
  if(editing.id&&!note&&Object.keys(EMPTY).every(k=>JSON.stringify(editing[k])===JSON.stringify(data[k]))){dirty=false;closeOrder();return;}
  const before=editing.id?structuredClone(editing):null,guard=epoch;
  saving=true;dialog.querySelector('#repairFields').disabled=true;dialog.querySelector('#repairSave').disabled=true;showMessage(message,'Сохранение…',false);
  try{
    let saved;if(demo){
      if(data.repeat_of!=null&&!rows.some(r=>r.id===data.repeat_of))throw new Error('Предыдущий заказ не найден.');
      saved={...editing,...data,id:editing.id||Math.max(0,...rows.map(r=>r.id))+1,version:(editing.version||0)+1,created_at:editing.created_at||new Date().toISOString(),updated_at:new Date().toISOString()};
      (eventsById[saved.id]??=[]).unshift({created_at:saved.updated_at,actor_name:'Демо-сотрудник',note:note||(before?'Карточка обновлена':'Заказ создан'),before_data:before,after_data:structuredClone(saved)});
    }else{
      const response=await client.rpc('save_repair',{p_id:editing.id||null,p_version:editing.version||null,p_data:data,p_note:note});if(response.error)throw response.error;saved=response.data;
    }
    if(guard!==epoch)return;
    rows=[saved,...rows.filter(r=>r.id!==saved.id)];notice='';dirty=false;saving=false;closeOrder();render();
  }catch(error){showMessage(message,friendly(error));}
  finally{saving=false;if(dialog.open){dialog.querySelector('#repairFields').disabled=false;dialog.querySelector('#repairSave').disabled=false;paymentState();}}
}
async function load(){
  if(loading||demo||!user)return;
  loading=true;const guard=epoch;
  try{
    const memberResult=await client.from('repair_members').select('display_name,active').eq('user_id',user.id).maybeSingle();if(memberResult.error)throw memberResult.error;
    if(guard!==epoch)return;
    if(!memberResult.data?.active){member=null;rows=[];dialog.close();dialog.innerHTML='';login();return;}
    member=memberResult.data;
    const collected=[];for(let from=0;;from+=500){const response=await client.from('repairs').select('*').order('id',{ascending:false}).range(from,from+499);if(response.error)throw response.error;collected.push(...response.data);if(response.data.length<500)break;}
    if(guard!==epoch)return;rows=collected;notice='';lastUpdated=new Date().toISOString();render();
  }catch(error){if(guard===epoch){notice=friendly(error);if(member)render();else{root.innerHTML=`<div class="panel repair-empty"><p>${esc(notice)}</p><button id="repairRetry">Повторить</button> <button id="repairExit">Выйти</button></div>`;find('repairRetry').onclick=load;find('repairExit').onclick=signout;}}}
  finally{loading=false;}
}
async function signout(){
  if(demo){epoch++;demo=false;loading=false;rows=[];eventsById={};notice='';if(user)await load();else login();return;}
  const {error}=await client.auth.signOut({scope:'local'});if(error){notice=friendly(error);render();}
}
dialog.addEventListener('cancel',event=>{event.preventDefault();closeOrder();});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
window.addEventListener('resize',()=>{if(find('repairResults'))renderResults();});
window.addEventListener('repairs-visible',()=>{if(!demo&&user&&!dialog.open)load();});
window.addEventListener('focus',()=>{if(!demo&&user&&!dialog.open&&!document.getElementById('repairsView').classList.contains('hidden'))load();});
setInterval(()=>{if(!document.hidden&&!demo&&user&&!dialog.open&&!document.getElementById('repairsView').classList.contains('hidden'))load();},60000);
function setUser(next){
  if(user?.id===next?.id&&user)return;
  epoch++;user=next;member=null;rows=[];eventsById={};loading=false;dirty=false;dialog.close();dialog.innerHTML='';editing=null;
  if(demo)return;
  if(user){root.innerHTML='<div class="panel">Проверка доступа…</div>';load();}else login();
}
login();
if(window.supabase){
  client=window.supabase.createClient('https://cwzobgsgsfbcaryspunh.supabase.co','sb_publishable_PTIm3UNI0giJKCT4DOY5JA_vh47Ec0x',{auth:{storageKey:'uralstore-repairs-auth',storage:localStorage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  client.auth.onAuthStateChange((_event,session)=>{setTimeout(()=>setUser(session?.user||null),0);});
  client.auth.getSession().then(({data,error})=>{if(error)showMessage(find('repairAuthMessage'),friendly(error));else setUser(data.session?.user||null);});
}
if(location.hash==='#repairs')document.querySelector('[data-view="repairs"]').click();

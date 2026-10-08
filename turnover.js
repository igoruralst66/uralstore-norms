import {TURNOVER_STATUSES,TURNOVER_CONDITIONS,daysInStock,stockAgeState,filterTurnoverItems} from './turnover-model.mjs';

const STORAGE_KEY='uralstore_turnover_prototype_v01';
const MEMBER_KEY='uralstore_buyback_member_v01';
const defaults={
  categories:[
    {id:'phones',name:'Телефоны'},
    {id:'laptops',name:'Ноутбуки'},
    {id:'watches',name:'Часы'},
    {id:'audio',name:'Наушники'},
    {id:'tablets',name:'Планшеты'},
    {id:'other',name:'Другое'}
  ],
  items:[]
};
const clone=value=>JSON.parse(JSON.stringify(value));
const newId=prefix=>`${prefix}-${globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`}`;
const esc=value=>(window.uralstoreUi?.escapeHtml||String)(value??'');
const money=value=>`${Number(value||0).toLocaleString('ru-RU')} ₽`;
let state=load();
let filters={query:'',category:'all',condition:'all',status:'active'};
let editingId=null;

function load(){
  try{
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
    if(saved&&Array.isArray(saved.categories)&&Array.isArray(saved.items))return saved;
  }catch{}
  return clone(defaults);
}
function save(){localStorage.setItem(STORAGE_KEY,JSON.stringify(state));render()}
function admin(){return window.uralstoreAccessRole==='admin'}
function member(){try{return String(localStorage.getItem(MEMBER_KEY)||'').trim()}catch{return ''}}
function categoryName(categoryId){return state.categories.find(category=>category.id===categoryId)?.name||'Без категории'}
function formatDate(value){if(!value)return 'Не указана';const [year,month,day]=value.split('-');return `${day}.${month}.${year}`}
function dueState(item){if(!item.actionDue||item.status==='sold')return '';const today=new Date().toISOString().slice(0,10);return item.actionDue<today?'bad':item.actionDue===today?'warn':''}
function statusTag(status){return `<span class="tag ${status==='sold'?'ok':status==='attention'?'warn':''}">${esc(TURNOVER_STATUSES[status]||status)}</span>`}
function conditionTag(condition){return `<span class="tag">${esc(TURNOVER_CONDITIONS[condition]||'Не указано')}</span>`}

function render(){
  const root=document.getElementById('turnoverRoot');if(!root)return;
  const visible=filterTurnoverItems(state.items,filters);
  const active=state.items.filter(item=>item.status!=='sold');
  const today=new Date().toISOString().slice(0,10);
  const overdue=active.filter(item=>item.actionDue&&item.actionDue<today).length;
  const transit=active.filter(item=>/пути|поставщик|достав/i.test(item.location||'')).length;
  const sold=state.items.filter(item=>item.status==='sold').length;
  root.innerHTML=`
    <section class="panel">
      <div class="turnover-head"><div><h2>Контроль товаров</h2><p class="note explain">Отдельные позиции, которым нужно внимание для более быстрой реализации.</p></div><div class="turnover-head-meta"><span class="turnover-local">Локальный прототип</span><button type="button" id="turnoverCategories">Категории</button><button type="button" class="primary" id="turnoverAdd">+ Добавить позицию</button></div></div>
    </section>
    <section class="turnover-summary"><div class="card"><span class="note">Под контролем</span><b>${active.length}</b></div><div class="card"><span class="note">Срок действия прошёл</span><b class="${overdue?'bad':''}">${overdue}</b></div><div class="card"><span class="note">Предположительно в пути</span><b>${transit}</b></div><div class="card"><span class="note">Реализовано</span><b>${sold}</b></div></section>
    <section class="panel turnover-state-tabs">
      <button type="button" data-turnover-state="active" class="${filters.status!=='sold'?'active':''}">На остатках <span>${active.length}</span></button>
      <button type="button" data-turnover-state="sold" class="${filters.status==='sold'?'active':''}">Реализовано <span>${sold}</span></button>
    </section>
    <section class="panel">
      <div class="turnover-category-tabs"><button type="button" data-turnover-category="all" class="${filters.category==='all'?'active':''}">Все товары</button>${state.categories.map(category=>`<button type="button" data-turnover-category="${category.id}" class="${filters.category===category.id?'active':''}">${esc(category.name)}</button>`).join('')}</div>
    </section>
    <section class="panel turnover-toolbar">
      <input id="turnoverSearch" value="${esc(filters.query)}" placeholder="Поиск товара, номера, места или ответственного">
      <select id="turnoverCondition"><option value="all">Новое и Б/У</option><option value="new">Только новое</option><option value="used">Только Б/У</option></select>
      ${filters.status==='sold'?'<select id="turnoverStatus" disabled><option value="sold">Реализовано</option></select>':'<select id="turnoverStatus"><option value="active">Все на остатках</option><option value="attention">Требуют внимания</option><option value="in_progress">В работе</option></select>'}
      <button type="button" id="turnoverReset">Сбросить</button>
    </section>
    <section class="turnover-list">${visible.length?visible.map(renderCard).join(''):'<div class="panel turnover-empty">По выбранным условиям позиций пока нет.</div>'}</section>`;
  root.querySelector('#turnoverCondition').value=filters.condition;
  root.querySelector('#turnoverStatus').value=filters.status;
  bind(root);
}

function renderCard(item){
  const days=daysInStock(item.receivedDate,item.status==='sold'&&item.soldAt?new Date(item.soldAt):new Date());
  const age=stockAgeState(days,item.status);
  const ageLabel=age==='fresh'?'Свежая позиция':age==='watch'?'Стоит обратить внимание':age==='stale'?'Зависшая позиция':age==='unknown'?'Срок неизвестен':'';
  return `<article class="turnover-card turnover-age-${age}">
    <div class="turnover-card-head"><div><h3>${esc(item.name||'Без названия')}</h3><div class="turnover-card-tags"><span class="tag">${esc(categoryName(item.category))}</span>${conditionTag(item.condition)}${statusTag(item.status)}${item.status!=='sold'?`<span class="tag turnover-age-tag">${esc(ageLabel)}</span>`:''}${Number(item.saleBonus)>0?`<span class="tag turnover-bonus-tag">Бонус ${money(item.saleBonus)}</span>`:''}</div></div>${item.identifier?`<span class="tag">№ ${esc(item.identifier)}</span>`:''}</div>
    <div class="turnover-card-grid">
      <div><span>Где находится</span><b>${esc(item.location||'Не указано')}</b></div>
      <div><span>Дата поступления</span><b>${formatDate(item.receivedDate)}</b></div>
      <div><span>${item.status==='sold'?'Было в наличии':'В наличии'}</span><b>${days==null?'Неизвестно':`${days} дн.`}</b></div>
      <div><span>Ответственный</span><b>${esc(item.responsible||'Не назначен')}</b></div>
      <div><span>Бонус за реализацию</span><b class="${Number(item.saleBonus)>0?'turnover-bonus-value':''}">${Number(item.saleBonus)>0?money(item.saleBonus):'Не назначен'}</b></div>
      ${item.status==='sold'?`<div><span>Дата реализации</span><b>${formatDate((item.soldAt||'').slice(0,10))}</b></div><div><span>Реализовал</span><b>${esc(item.soldBy||'Не указано')}</b></div>`:''}
      <div class="turnover-wide"><span>Причина внимания</span><p>${esc(item.reason||'Не указана')}</p></div>
      <div class="turnover-wide"><span>Рекомендация</span><p>${esc(item.recommendation||'Не указана')}</p></div>
      ${item.notes?`<div class="turnover-wide"><span>Комментарий</span><p>${esc(item.notes)}</p></div>`:''}
      <div><span>Сделать до</span><b class="${dueState(item)}">${formatDate(item.actionDue)}</b></div>
    </div>
    <footer class="turnover-card-footer"><span class="note">Обновлено: ${formatDate((item.updatedAt||'').slice(0,10))}${item.updatedBy?` · ${esc(item.updatedBy)}`:''}</span><div class="turnover-card-actions"><button type="button" class="${item.status==='sold'?'':'primary'}" data-turnover-sold="${item.id}">${item.status==='sold'?'Вернуть на остатки':'Товар реализован'}</button><button type="button" data-turnover-edit="${item.id}">Изменить</button>${admin()?`<button type="button" class="turnover-danger" data-turnover-delete="${item.id}">Удалить</button>`:''}</div></footer>
  </article>`;
}

function bind(root){
  root.querySelector('#turnoverAdd').onclick=()=>openItem();
  root.querySelector('#turnoverCategories').onclick=openCategories;
  root.querySelector('#turnoverSearch').oninput=event=>{filters.query=event.target.value;render();const input=document.getElementById('turnoverSearch');input?.focus();input?.setSelectionRange(filters.query.length,filters.query.length)};
  root.querySelector('#turnoverCondition').onchange=event=>{filters.condition=event.target.value;render()};
  root.querySelector('#turnoverStatus').onchange=event=>{filters.status=event.target.value;render()};
  root.querySelector('#turnoverReset').onclick=()=>{filters={query:'',category:'all',condition:'all',status:'active'};render()};
  root.querySelectorAll('[data-turnover-state]').forEach(button=>button.onclick=()=>{filters.status=button.dataset.turnoverState;render()});
  root.querySelectorAll('[data-turnover-category]').forEach(button=>button.onclick=()=>{filters.category=button.dataset.turnoverCategory;render()});
  root.querySelectorAll('[data-turnover-edit]').forEach(button=>button.onclick=()=>openItem(button.dataset.turnoverEdit));
  root.querySelectorAll('[data-turnover-sold]').forEach(button=>button.onclick=()=>toggleSold(button.dataset.turnoverSold));
  root.querySelectorAll('[data-turnover-delete]').forEach(button=>button.onclick=()=>deleteItem(button.dataset.turnoverDelete));
}

function ensureDialog(){
  let node=document.getElementById('turnoverDialog');
  if(!node){node=document.createElement('dialog');node.id='turnoverDialog';node.className='turnover-dialog';document.body.append(node)}
  return node;
}
function closeButtons(node){node.querySelectorAll('[data-turnover-close]').forEach(button=>button.onclick=()=>node.close())}
function memberField(){return `<div><label for="turnoverUpdatedBy">Кто изменяет</label><input id="turnoverUpdatedBy" required minlength="2" maxlength="120" value="${esc(member())}" placeholder="Ваше имя"></div>`}

function openItem(itemId=null){
  const node=ensureDialog();editingId=itemId;
  const item=state.items.find(entry=>entry.id===itemId)||{name:'',condition:'used',identifier:'',category:state.categories[0]?.id||'',location:'',receivedDate:'',reason:'',recommendation:'',responsible:'',actionDue:'',status:'attention',notes:''};
  node.innerHTML=`<form id="turnoverForm" class="turnover-dialog-inner"><div class="section-head"><div><h2>${itemId?'Изменить позицию':'Новая позиция'}</h2><p class="note">Одна карточка — одна конкретная единица товара.</p></div><button type="button" data-turnover-close>Закрыть</button></div><div class="turnover-form">
    ${memberField()}<div><label for="turnoverName">Наименование товара</label><input id="turnoverName" required maxlength="180" value="${esc(item.name)}" placeholder="Например: iPhone 15 Pro 256 GB"></div>
    <div><label for="turnoverCategory">Категория</label><select id="turnoverCategory" required>${state.categories.map(category=>`<option value="${category.id}" ${item.category===category.id?'selected':''}>${esc(category.name)}</option>`).join('')}</select></div>
    <div><label for="turnoverConditionField">Новое или Б/У</label><select id="turnoverConditionField" required>${Object.entries(TURNOVER_CONDITIONS).map(([value,label])=>`<option value="${value}" ${item.condition===value?'selected':''}>${label}</option>`).join('')}</select></div>
    <div><label for="turnoverIdentifier">Номер / идентификатор</label><input id="turnoverIdentifier" maxlength="160" value="${esc(item.identifier)}" placeholder="№ в FD, IMEI, серийный или трек-номер"></div>
    <div><label for="turnoverLocation">Где находится</label><input id="turnoverLocation" maxlength="160" value="${esc(item.location)}" list="turnoverLocations" placeholder="Напишите место или этап"><datalist id="turnoverLocations"><option value="В пути"><option value="На складе"><option value="В сервисе"><option value="У поставщика"></datalist></div>
    <div><label for="turnoverReceived">Дата поступления</label><input id="turnoverReceived" type="date" value="${esc(item.receivedDate)}"></div>
    <div><label for="turnoverResponsible">Ответственный</label><input id="turnoverResponsible" maxlength="120" value="${esc(item.responsible)}" placeholder="Имя сотрудника"></div>
    <div><label for="turnoverSaleBonus">Бонус за реализацию</label><input id="turnoverSaleBonus" type="number" min="0" step="1" value="${Number(item.saleBonus)||''}" placeholder="Необязательно, ₽"></div>
    <div><label for="turnoverDue">Сделать до</label><input id="turnoverDue" type="date" value="${esc(item.actionDue)}"></div>
    <div><label for="turnoverStatusField">Статус</label><select id="turnoverStatusField">${Object.entries(TURNOVER_STATUSES).map(([value,label])=>`<option value="${value}" ${item.status===value?'selected':''}>${label}</option>`).join('')}</select></div>
    <div class="wide"><label for="turnoverReason">Причина внимания</label><textarea id="turnoverReason" maxlength="1500" placeholder="Почему позиция требует внимания">${esc(item.reason)}</textarea></div>
    <div class="wide"><label for="turnoverRecommendation">Рекомендация</label><textarea id="turnoverRecommendation" maxlength="1500" placeholder="Что сотруднику стоит сделать">${esc(item.recommendation)}</textarea></div>
    <div class="wide"><label for="turnoverNotes">Комментарий</label><textarea id="turnoverNotes" maxlength="2000" placeholder="Необязательное дополнение">${esc(item.notes)}</textarea></div>
  </div><div class="turnover-dialog-actions">${itemId&&admin()?'<button type="button" class="turnover-danger" id="turnoverDeleteInForm">Удалить позицию</button>':''}<button type="button" data-turnover-close>Отмена</button><button class="primary" type="submit">Сохранить</button></div></form>`;
  closeButtons(node);
  const remove=node.querySelector('#turnoverDeleteInForm');if(remove)remove.onclick=()=>{node.close();deleteItem(itemId)};
  node.querySelector('#turnoverForm').onsubmit=event=>{event.preventDefault();saveItem(node);node.close()};
  node.showModal();
}

function saveItem(node){
  const previous=state.items.find(item=>item.id===editingId);
  const updatedBy=node.querySelector('#turnoverUpdatedBy').value.trim();
  localStorage.setItem(MEMBER_KEY,updatedBy);
  const next={
    id:editingId||newId('turnover'),name:node.querySelector('#turnoverName').value.trim(),category:node.querySelector('#turnoverCategory').value,
    condition:node.querySelector('#turnoverConditionField').value,identifier:node.querySelector('#turnoverIdentifier').value.trim(),location:node.querySelector('#turnoverLocation').value.trim(),
    receivedDate:node.querySelector('#turnoverReceived').value,reason:node.querySelector('#turnoverReason').value.trim(),recommendation:node.querySelector('#turnoverRecommendation').value.trim(),
    responsible:node.querySelector('#turnoverResponsible').value.trim(),saleBonus:Math.max(0,Number(node.querySelector('#turnoverSaleBonus').value)||0),actionDue:node.querySelector('#turnoverDue').value,status:node.querySelector('#turnoverStatusField').value,notes:node.querySelector('#turnoverNotes').value.trim(),
    createdAt:previous?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),updatedBy,
    soldAt:node.querySelector('#turnoverStatusField').value==='sold'?(previous?.soldAt||new Date().toISOString()):'',
    soldBy:node.querySelector('#turnoverStatusField').value==='sold'?(previous?.soldBy||updatedBy):''
  };
  state.items=previous?state.items.map(item=>item.id===editingId?next:item):[next,...state.items];save();
}

function toggleSold(itemId){
  const item=state.items.find(entry=>entry.id===itemId);if(!item)return;
  const isSold=item.status==='sold';
  const changedBy=member()||'Сотрудник';
  state.items=state.items.map(entry=>entry.id!==itemId?entry:{...entry,status:isSold?'attention':'sold',soldAt:isSold?'':new Date().toISOString(),soldBy:isSold?'':changedBy,updatedAt:new Date().toISOString(),updatedBy:changedBy});
  save();
}

function deleteItem(itemId){
  if(!admin())return;
  const item=state.items.find(entry=>entry.id===itemId);if(!item)return;
  if(!confirm(`Удалить позицию «${item.name}»? Для проданного товара лучше выбрать статус «Реализовано», чтобы сохранить историю.`))return;
  state.items=state.items.filter(entry=>entry.id!==itemId);save();
}

function openCategories(){
  const node=ensureDialog();
  const draw=()=>{
    node.innerHTML=`<div class="turnover-dialog-inner"><div class="section-head"><div><h2>Категории товаров</h2><p class="note">Категории используются как фильтры: телефоны, ноутбуки, часы и другие.</p></div><button type="button" data-turnover-close>Закрыть</button></div><div class="turnover-category-manager">${state.categories.map(category=>{const count=state.items.filter(item=>item.category===category.id).length;return `<div class="turnover-category-manager-row"><div><b>${esc(category.name)}</b><div class="note">${count} поз.</div></div>${admin()?`<button type="button" class="turnover-danger" data-turnover-category-delete="${category.id}" ${count?'disabled title="Сначала перенесите позиции в другую категорию"':''}>Удалить</button>`:''}</div>`}).join('')}</div><form id="turnoverCategoryForm" class="turnover-form"><div class="wide"><label for="turnoverCategoryName">Новая категория</label><input id="turnoverCategoryName" required maxlength="100" placeholder="Например: Игровые приставки"></div><div class="wide turnover-dialog-actions"><button type="button" data-turnover-close>Готово</button><button class="primary" type="submit">Добавить категорию</button></div></form></div>`;
    closeButtons(node);
    node.querySelector('#turnoverCategoryForm').onsubmit=event=>{event.preventDefault();const name=node.querySelector('#turnoverCategoryName').value.trim();if(!name)return;state.categories.push({id:newId('category'),name});localStorage.setItem(STORAGE_KEY,JSON.stringify(state));draw();render()};
    node.querySelectorAll('[data-turnover-category-delete]').forEach(button=>button.onclick=()=>{const category=state.categories.find(entry=>entry.id===button.dataset.turnoverCategoryDelete);if(!category||state.items.some(item=>item.category===category.id)||!confirm(`Удалить пустую категорию «${category.name}»?`))return;state.categories=state.categories.filter(entry=>entry.id!==category.id);if(filters.category===category.id)filters.category='all';localStorage.setItem(STORAGE_KEY,JSON.stringify(state));draw();render()});
  };
  draw();node.showModal();
}

window.initTurnover=render;
window.uralstoreTurnoverExport=()=>clone(state);
window.addEventListener('app-access-ready',render);
if(window.uralstoreAccessRole)render();

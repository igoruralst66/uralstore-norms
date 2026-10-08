const db=window.uralstoreDb;
const {money,escapeHtml}=window.uralstoreUi;
const $=id=>document.getElementById(id);

const SHIFT_KEY='uralstore_shifts_v01';
const MOTIVATION_KEY='uralstore_motivation_events_v01';
const SHIFT_STATUSES=[['','— Не назначено'],['rs','РС · рабочая смена'],['os','ОС · ответственный'],['zo','ЗО · зона ответственности'],['off','ВЫХ · выходной']];
const WEEKDAYS=['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
const DEFAULT_EMPLOYEES=['Настя','Ксюша','Фарида','Игорь','Костя','Арман','Сережа'];

function readLocalShifts(){
  const fallback={month:'2026-10',employees:structuredClone(DEFAULT_EMPLOYEES),cells:{},rates:DEFAULT_EMPLOYEES.map(()=>0),closed:{}};
  try{
    const stored=JSON.parse(localStorage.getItem(SHIFT_KEY)||'null');
    if(!stored||!Array.isArray(stored.employees)||!stored.cells)return fallback;
    const employees=stored.employees.filter(name=>String(name).trim()).map(name=>String(name).trim());
    return {...fallback,...stored,employees,cells:stored.cells||{},rates:employees.map((_,index)=>Math.max(0,Number(stored.rates?.[index])||0)),closed:stored.closed&&typeof stored.closed==='object'?stored.closed:{}};
  }catch{return fallback}
}

function readLocalMotivation(defaultMonth){
  try{
    const stored=JSON.parse(localStorage.getItem(MOTIVATION_KEY)||'null');
    if(stored&&Array.isArray(stored.events))return {month:stored.month||defaultMonth,events:stored.events};
  }catch{}
  return {month:defaultMonth,events:[]};
}

let shiftState=readLocalShifts();
let employeeIds=[];
let localMotivation=readLocalMotivation(shiftState.month);
let motivationMonth=localMotivation.month;
let motivationEvents=localMotivation.events;
let started=false,loading=false,realtimeChannel=null,reloadTimer=null,mobileShiftEmployee=0,mobileMotivationEmployee=0;

function setStaffSync(text,bad=false){
  document.querySelectorAll('[data-staff-sync]').forEach(node=>{node.textContent=text;node.className='sync'+(bad?' bad':' ok')});
}
function cacheLocal(){
  localStorage.setItem(SHIFT_KEY,JSON.stringify(shiftState));
  localStorage.setItem(MOTIVATION_KEY,JSON.stringify({month:motivationMonth,events:motivationEvents}));
}
function isWorkShift(value){return value==='rs'||value==='os'||value==='zo'}
function cellKey(date,index){return `${date}|${index}`}
function monthDays(month){
  const [year,number]=month.split('-').map(Number),count=new Date(year,number,0).getDate();
  return Array.from({length:count},(_,index)=>{const value=new Date(year,number-1,index+1);return {date:`${month}-${String(index+1).padStart(2,'0')}`,weekday:WEEKDAYS[value.getDay()],weekend:value.getDay()===0||value.getDay()===6}});
}
function shiftDays(){return monthDays(shiftState.month)}
function motivationDays(){return monthDays(motivationMonth)}
function shiftTotals(index){
  const days=shiftDays(),values=days.map(day=>shiftState.cells[cellKey(day.date,index)]||'');
  const rs=values.filter(value=>value==='rs').length,os=values.filter(value=>value==='os').length,zo=values.filter(value=>value==='zo').length,off=values.filter(value=>value==='off').length;
  const closed=days.filter(day=>isWorkShift(shiftState.cells[cellKey(day.date,index)]||'')&&shiftState.closed[cellKey(day.date,index)]).length;
  return {rs,os,zo,off,total:rs+os+zo,closed,salary:closed*(Number(shiftState.rates[index])||0)};
}
function employeePicker(selected,attribute){
  return `<div class="staff-mobile-picker">${shiftState.employees.map((employee,index)=>`<button type="button" data-${attribute}="${index}" class="${index===selected?'primary':''}">${escapeHtml(employee)}</button>`).join('')}</div>`;
}
function mobileShiftView(days){
  mobileShiftEmployee=Math.min(mobileShiftEmployee,Math.max(0,shiftState.employees.length-1));
  const index=mobileShiftEmployee,employee=shiftState.employees[index],total=shiftTotals(index);
  const rows=days.map(day=>{const key=cellKey(day.date,index),value=shiftState.cells[key]||'',closed=isWorkShift(value)&&Boolean(shiftState.closed[key]);return `<div class="staff-mobile-day ${day.weekend?'shift-weekend':''}"><div><b>${day.weekday}</b><span>${day.date.split('-').reverse().join('.')}</span></div><div class="shift-cell-stack"><select data-shift-cell="${key}" class="shift-${value}" aria-label="${day.date}, ${escapeHtml(employee)}">${SHIFT_STATUSES.map(([status,label])=>`<option value="${status}" ${status===value?'selected':''}>${label}</option>`).join('')}</select>${isWorkShift(value)?`<button type="button" class="shift-close ${closed?'closed':''}" data-shift-close="${key}">${closed?'✓ Закрыта':'Закрыть смену'}</button>`:''}</div></div>`}).join('');
  return `<section class="staff-mobile"><p class="note">Выберите сотрудника</p>${employeePicker(index,'mobile-shift-employee')}<div class="staff-mobile-employee"><div><label for="mobileShiftName">Имя сотрудника</label><input id="mobileShiftName" data-shift-name="${index}" value="${escapeHtml(employee)}"></div><div><label for="mobileShiftRate">Оклад / смена, ₽</label><input id="mobileShiftRate" data-shift-rate="${index}" type="number" min="0" step="1" value="${Number(shiftState.rates[index])||0}"></div></div><div class="staff-mobile-total"><b>${total.closed} из ${total.total} смен закрыто</b><span>Начислено ${money(total.salary)}</span></div><div class="staff-mobile-days">${rows}</div></section>`;
}

async function seedCloudFromThisBrowser(){
  const employees=shiftState.employees.map((name,index)=>({name,daily_rate:Number(shiftState.rates[index])||0,sort_order:index,active:true}));
  if(!employees.length)return;
  const inserted=await db.from('staff_employees').insert(employees).select('id,name,sort_order');
  if(inserted.error)throw inserted.error;
  const idsByIndex=inserted.data.sort((a,b)=>a.sort_order-b.sort_order).map(row=>row.id);
  const shifts=[];
  Object.entries(shiftState.cells).forEach(([key,status])=>{
    const [shiftDate,indexText]=key.split('|'),index=Number(indexText),employeeId=idsByIndex[index];
    if(employeeId&&status)shifts.push({employee_id:employeeId,shift_date:shiftDate,status,closed:Boolean(shiftState.closed[key])&&isWorkShift(status)});
  });
  if(shifts.length){const result=await db.from('staff_shifts').upsert(shifts,{onConflict:'employee_id,shift_date'});if(result.error)throw result.error}
  const events=motivationEvents.map(event=>{
    const index=shiftState.employees.indexOf(event.employee),employeeId=idsByIndex[index];
    return employeeId?{employee_id:employeeId,event_date:event.date,event_type:event.type,amount:Math.abs(Number(event.amount)||0),reason:String(event.reason||'Без причины').slice(0,300),notes:String(event.notes||'').slice(0,2000)}:null;
  }).filter(event=>event&&event.amount>0);
  if(events.length){const result=await db.from('staff_motivation_events').insert(events);if(result.error)throw result.error}
}

async function loadCloud({allowSeed=true}={}){
  if(loading)return;
  loading=true;setStaffSync('Синхронизация…');
  try{
    let employeesResult=await db.from('staff_employees').select('id,name,daily_rate,sort_order').eq('active',true).order('sort_order').order('id');
    if(employeesResult.error)throw employeesResult.error;
    if(!employeesResult.data.length&&allowSeed){
      await seedCloudFromThisBrowser();
      employeesResult=await db.from('staff_employees').select('id,name,daily_rate,sort_order').eq('active',true).order('sort_order').order('id');
      if(employeesResult.error)throw employeesResult.error;
    }
    const [shiftsResult,eventsResult]=await Promise.all([
      db.from('staff_shifts').select('employee_id,shift_date,status,closed'),
      db.from('staff_motivation_events').select('id,employee_id,event_date,event_type,amount,reason,notes,created_at').order('created_at')
    ]);
    if(shiftsResult.error)throw shiftsResult.error;if(eventsResult.error)throw eventsResult.error;
    const employees=employeesResult.data;
    employeeIds=employees.map(row=>Number(row.id));
    shiftState.employees=employees.map(row=>row.name);
    shiftState.rates=employees.map(row=>Number(row.daily_rate)||0);
    shiftState.cells={};shiftState.closed={};
    shiftsResult.data.forEach(row=>{const index=employeeIds.indexOf(Number(row.employee_id));if(index<0)return;const key=cellKey(row.shift_date,index);shiftState.cells[key]=row.status;if(row.closed)shiftState.closed[key]=true});
    motivationEvents=eventsResult.data.map(row=>{const index=employeeIds.indexOf(Number(row.employee_id));return index<0?null:{id:row.id,employeeId:Number(row.employee_id),date:row.event_date,employee:shiftState.employees[index],type:row.event_type,amount:Number(row.amount),reason:row.reason,notes:row.notes||''}}).filter(Boolean);
    cacheLocal();renderShifts();renderMotivation();setStaffSync('Общая база • сохранено');
  }catch(error){console.error(error);setStaffSync('Нет связи с общей базой',true)}
  finally{loading=false}
}

async function saveShiftCell(key){
  const [shiftDate,indexText]=key.split('|'),index=Number(indexText),employeeId=employeeIds[index],status=shiftState.cells[key]||'';
  if(!employeeId)return;
  setStaffSync('Сохранение…');
  const result=status
    ?await db.from('staff_shifts').upsert({employee_id:employeeId,shift_date:shiftDate,status,closed:Boolean(shiftState.closed[key])&&isWorkShift(status)},{onConflict:'employee_id,shift_date'})
    :await db.from('staff_shifts').delete().eq('employee_id',employeeId).eq('shift_date',shiftDate);
  if(result.error){setStaffSync('Не сохранено',true);await loadCloud({allowSeed:false});alert('Не удалось сохранить смену: '+result.error.message);return false}
  cacheLocal();setStaffSync('Общая база • сохранено');return true;
}

function renderShifts(){
  const month=$('shiftMonth'),target=$('shiftCalendar');if(!month||!target)return;
  month.value=shiftState.month;
  const days=shiftDays();
  if(!shiftState.employees.length){target.innerHTML='<div class="placeholder"><div class="placeholder-inner"><h2>Добавьте сотрудников</h2><p class="note">Имена можно менять вручную в любой момент.</p></div></div>';return}
  const headers=shiftState.employees.map((employee,index)=>`<th><div class="shift-name"><input data-shift-name="${index}" value="${escapeHtml(employee)}" aria-label="Имя сотрудника ${index+1}"><button type="button" class="shift-remove" data-shift-remove="${index}" title="Убрать сотрудника">×</button></div><label class="shift-rate"><span>Оклад / смена, ₽</span><input data-shift-rate="${index}" type="number" min="0" step="1" value="${Number(shiftState.rates[index])||0}" aria-label="Дневной оклад ${escapeHtml(employee)}"></label></th>`).join('');
  const rows=days.map(day=>`<tr><td class="shift-day ${day.weekend?'shift-weekend':''}">${day.weekday}</td><td class="shift-date ${day.weekend?'shift-weekend':''}">${day.date.split('-').reverse().join('.')}</td>${shiftState.employees.map((_,index)=>{const key=cellKey(day.date,index),value=shiftState.cells[key]||'',closed=isWorkShift(value)&&Boolean(shiftState.closed[key]);return `<td class="${day.weekend?'shift-weekend ':''}${closed?'shift-closed-row':''}"><div class="shift-cell-stack"><select data-shift-cell="${key}" class="shift-${value}" aria-label="${day.date}, ${escapeHtml(shiftState.employees[index])}">${SHIFT_STATUSES.map(([status,label])=>`<option value="${status}" ${status===value?'selected':''}>${label}</option>`).join('')}</select>${isWorkShift(value)?`<button type="button" class="shift-close ${closed?'closed':''}" data-shift-close="${key}">${closed?'✓ Смена закрыта':'Закрыть смену'}</button>`:''}</div></td>`}).join('')}</tr>`).join('');
  const totals=shiftState.employees.map((_,index)=>{const total=shiftTotals(index);return `<td><b>${total.closed} из ${total.total} закрыто</b><br><span class="note">Начислено ${money(total.salary)}</span></td>`}).join('');
  target.innerHTML=`<div class="staff-desktop"><table class="shift-table"><thead><tr><th>День</th><th>Дата</th>${headers}</tr></thead><tbody>${rows}</tbody><tfoot class="shift-totals"><tr><th colspan="2">Закрытые / рабочие смены</th>${totals}</tr></tfoot></table></div>${mobileShiftView(days)}<p class="note" style="margin:12px 4px 0"><b>РС</b> — рабочая смена; <b>ОС</b> — ответственный смены; <b>ЗО</b> — зона ответственности; <b>ВЫХ</b> — выходной. Оклад начисляется только за закрытые рабочие смены.</p><div class="shift-summary">${shiftState.employees.map((employee,index)=>{const total=shiftTotals(index);return `<div class="card"><span class="note">${escapeHtml(employee)}</span><b>${total.closed} из ${total.total} закрыто</b><span class="detail">Оклад: ${money(total.salary)} · ставка ${money(shiftState.rates[index]||0)}</span></div>`}).join('')}</div>`;
  target.querySelectorAll('[data-mobile-shift-employee]').forEach(button=>button.onclick=()=>{mobileShiftEmployee=Number(button.dataset.mobileShiftEmployee);renderShifts()});
  target.querySelectorAll('[data-shift-cell]').forEach(select=>select.onchange=async()=>{const key=select.dataset.shiftCell;shiftState.cells[key]=select.value;if(!isWorkShift(select.value))delete shiftState.closed[key];renderShifts();renderMotivation();await saveShiftCell(key)});
  target.querySelectorAll('[data-shift-close]').forEach(button=>button.onclick=async()=>{const key=button.dataset.shiftClose;shiftState.closed[key]=!shiftState.closed[key];if(!shiftState.closed[key])delete shiftState.closed[key];renderShifts();renderMotivation();await saveShiftCell(key)});
  target.querySelectorAll('[data-shift-rate]').forEach(input=>input.onchange=async()=>{const index=Number(input.dataset.shiftRate),employeeId=employeeIds[index],previous=shiftState.rates[index];shiftState.rates[index]=Math.max(0,Number(input.value)||0);renderMotivation();setStaffSync('Сохранение…');const result=await db.from('staff_employees').update({daily_rate:shiftState.rates[index],updated_at:new Date().toISOString()}).eq('id',employeeId);if(result.error){shiftState.rates[index]=previous;setStaffSync('Не сохранено',true);alert(result.error.message)}else{cacheLocal();setStaffSync('Общая база • сохранено')}});
  target.querySelectorAll('[data-shift-name]').forEach(input=>input.onchange=async()=>{const index=Number(input.dataset.shiftName),employeeId=employeeIds[index],next=input.value.trim(),previous=shiftState.employees[index];if(!next){input.value=previous;return}setStaffSync('Сохранение…');const result=await db.from('staff_employees').update({name:next,updated_at:new Date().toISOString()}).eq('id',employeeId);if(result.error){input.value=previous;setStaffSync('Не сохранено',true);alert(result.error.message)}else await loadCloud({allowSeed:false})});
  target.querySelectorAll('[data-shift-remove]').forEach(button=>button.onclick=async()=>{const index=Number(button.dataset.shiftRemove),employeeId=employeeIds[index];if(!confirm(`Убрать сотрудника «${shiftState.employees[index]}» из списка? История останется в базе.`))return;setStaffSync('Сохранение…');const result=await db.from('staff_employees').update({active:false,updated_at:new Date().toISOString()}).eq('id',employeeId);if(result.error){setStaffSync('Не сохранено',true);alert(result.error.message)}else await loadCloud({allowSeed:false})});
}

function initShifts(){
  const month=$('shiftMonth'),add=$('shiftAddEmployee'),name=$('shiftEmployee');if(!month||month.dataset.cloudReady)return;
  month.dataset.cloudReady='1';month.value=shiftState.month;
  month.onchange=()=>{shiftState.month=month.value||shiftState.month;cacheLocal();renderShifts()};
  add.onclick=async()=>{const next=name.value.trim();if(!next)return;add.disabled=true;setStaffSync('Сохранение…');const result=await db.from('staff_employees').insert({name:next,daily_rate:0,sort_order:employeeIds.length,active:true});add.disabled=false;if(result.error){setStaffSync('Не сохранено',true);alert(result.error.message);return}name.value='';await loadCloud({allowSeed:false})};
  renderShifts();
}

function employeeMonthEvents(employee){return motivationEvents.filter(event=>event.employee===employee&&event.date.startsWith(motivationMonth))}
function motivationSums(events){const bonus=events.filter(event=>event.type==='bonus').reduce((sum,event)=>sum+(Number(event.amount)||0),0),penalty=events.filter(event=>event.type==='penalty').reduce((sum,event)=>sum+(Number(event.amount)||0),0);return {bonus,penalty,total:bonus-penalty}}
function shiftSalaryForDay(employee,date){const index=shiftState.employees.indexOf(employee);if(index<0)return {planned:false,closed:false,amount:0};const key=cellKey(date,index),status=shiftState.cells[key]||'',planned=isWorkShift(status),closed=planned&&Boolean(shiftState.closed[key]);return {planned,closed,amount:closed?(Number(shiftState.rates[index])||0):0,status}}
function motivationDayTotals(employee,date,events){const eventSums=motivationSums(events),shift=shiftSalaryForDay(employee,date),salary=shift.amount;return {...eventSums,shift,salary,total:salary+eventSums.bonus-eventSums.penalty}}
function employeeMonthTotals(employee){const eventSums=motivationSums(employeeMonthEvents(employee)),salary=motivationDays().reduce((sum,day)=>sum+shiftSalaryForDay(employee,day.date).amount,0);return {...eventSums,salary,total:salary+eventSums.bonus-eventSums.penalty}}
function mobileMotivationView(days){
  mobileMotivationEmployee=Math.min(mobileMotivationEmployee,Math.max(0,shiftState.employees.length-1));
  const index=mobileMotivationEmployee,employee=shiftState.employees[index],monthTotal=employeeMonthTotals(employee);
  const cards=days.map(day=>{const events=motivationEvents.filter(event=>event.date===day.date&&event.employee===employee),sums=motivationDayTotals(employee,day.date,events),hasResult=events.length||sums.shift.closed,kind=!hasResult&&sums.shift.planned?'pending':!hasResult?'empty':sums.bonus&&sums.penalty?'mixed':sums.total>=0?'plus':'minus',details=[sums.shift.closed?`оклад ${money(sums.salary)}`:sums.shift.planned?'смена не закрыта':'',events.length?`${events.length} зап.`:''].filter(Boolean).join(' · ');return `<button type="button" class="staff-mobile-day motivation-mobile-day ${day.weekend?'shift-weekend':''}" data-motivation-date="${day.date}" data-motivation-employee="${index}"><span><b>${day.weekday}</b><small>${day.date.split('-').reverse().join('.')}</small></span><span class="motivation-cell ${kind}">${hasResult?`<b>${sums.total>0?'+':''}${money(sums.total)}</b><small>${details||'Есть начисление'}</small>`:sums.shift.planned?'<b>Ожидает</b><small>закрытия смены</small>':'<b>＋</b><small>Бонус или штраф</small>'}</span></button>`}).join('');
  return `<section class="staff-mobile"><p class="note">Выберите сотрудника</p>${employeePicker(index,'mobile-motivation-employee')}<div class="staff-mobile-total"><b class="${monthTotal.total<0?'bad':monthTotal.total>0?'ok':''}">${monthTotal.total>0?'+':''}${money(monthTotal.total)}</b><span>Оклад ${money(monthTotal.salary)} · бонусы ${money(monthTotal.bonus)} · штрафы ${money(monthTotal.penalty)}</span></div><div class="staff-mobile-days">${cards}</div></section>`;
}

function renderMotivation(){
  const target=$('motivationCalendar'),month=$('motivationMonth');if(!target||!month)return;month.value=motivationMonth;
  if(!shiftState.employees.length){target.innerHTML='<div class="motivation-empty">Сначала добавьте сотрудников в разделе «Смены».</div>';return}
  const headers=shiftState.employees.map(employee=>`<th>${escapeHtml(employee)}</th>`).join('');
  const rows=motivationDays().map(day=>`<tr><td class="shift-day ${day.weekend?'shift-weekend':''}">${day.weekday}</td><td class="shift-date ${day.weekend?'shift-weekend':''}">${day.date.split('-').reverse().join('.')}</td>${shiftState.employees.map((employee,index)=>{const events=motivationEvents.filter(event=>event.date===day.date&&event.employee===employee),sums=motivationDayTotals(employee,day.date,events),hasResult=events.length||sums.shift.closed,kind=!hasResult&&sums.shift.planned?'pending':!hasResult?'empty':sums.bonus&&sums.penalty?'mixed':sums.total>=0?'plus':'minus',details=[sums.shift.closed?`оклад ${money(sums.salary)}`:sums.shift.planned?'смена не закрыта':'',events.length?`${events.length} зап.`:''].filter(Boolean).join(' · ');return `<td class="${day.weekend?'shift-weekend':''}"><button type="button" class="motivation-cell ${kind}" data-motivation-date="${day.date}" data-motivation-employee="${index}">${hasResult?`<b>${sums.total>0?'+':''}${money(sums.total)}</b>${details?`<br><span>${details}</span>`:''}`:sums.shift.planned?'<b>Ожидает</b><br><span>закрытия смены</span>':'＋'}</button></td>`}).join('')}</tr>`).join('');
  const summaries=shiftState.employees.map(employee=>{const sums=employeeMonthTotals(employee);return `<div class="card"><span class="note">${escapeHtml(employee)}</span><b class="${sums.total<0?'bad':sums.total>0?'ok':''}">${sums.total>0?'+':''}${money(sums.total)}</b><span class="detail">Оклад: ${money(sums.salary)} · Бонусы: ${money(sums.bonus)} · Штрафы: ${money(sums.penalty)}</span></div>`}).join('');
  const days=motivationDays();
  target.innerHTML=`<div class="staff-desktop"><table class="shift-table"><thead><tr><th>День</th><th>Дата</th>${headers}</tr></thead><tbody>${rows}</tbody></table></div>${mobileMotivationView(days)}<div class="motivation-summary">${summaries}</div>`;
  target.querySelectorAll('[data-mobile-motivation-employee]').forEach(button=>button.onclick=()=>{mobileMotivationEmployee=Number(button.dataset.mobileMotivationEmployee);renderMotivation()});
  target.querySelectorAll('[data-motivation-date]').forEach(button=>button.onclick=()=>openMotivationDay(button.dataset.motivationDate,Number(button.dataset.motivationEmployee)));
}

function openMotivationDay(date,index){
  const employee=shiftState.employees[index],employeeId=employeeIds[index],dialog=$('motivationDialog'),events=motivationEvents.filter(event=>event.date===date&&event.employeeId===employeeId),sums=motivationDayTotals(employee,date,events);
  const salaryInfo=sums.shift.closed?`<div class="motivation-salary"><b>Оклад за закрытую смену: +${money(sums.salary)}</b></div>`:sums.shift.planned?'<div class="motivation-salary pending"><b>Смена ещё не закрыта</b><br><span>Оклад пока не входит в итог дня.</span></div>':'<div class="motivation-salary pending"><span>Рабочая смена на этот день не назначена.</span></div>';
  dialog.innerHTML=`<div class="motivation-dialog-inner"><div class="section-head"><div><h2 id="motivationDialogTitle">${escapeHtml(employee)} · ${date.split('-').reverse().join('.')}</h2><p class="note">Итог дня: ${sums.total>0?'+':''}${money(sums.total)} · оклад ${money(sums.salary)} · бонусы ${money(sums.bonus)} · штрафы ${money(sums.penalty)}</p></div><button type="button" id="motivationClose">Закрыть</button></div>${salaryInfo}<div id="motivationEvents">${events.length?events.map(event=>`<div class="motivation-event"><strong class="${event.type==='bonus'?'plus':'minus'}">${event.type==='bonus'?'+':'−'}${money(event.amount)}</strong><div><b>${escapeHtml(event.reason||'Без причины')}</b>${event.notes?`<p class="note explain">${escapeHtml(event.notes)}</p>`:''}</div><button type="button" data-motivation-event-delete="${event.id}">Удалить</button></div>`).join(''):'<p class="note">Бонусов и штрафов за этот день пока нет.</p>'}</div><hr style="border:0;border-top:1px solid var(--line);margin:16px 0"><form id="motivationEventForm"><div class="motivation-form"><div><label for="motivationType">Тип</label><select id="motivationType"><option value="bonus">Бонус</option><option value="penalty">Штраф</option></select></div><div><label for="motivationAmount">Сумма, ₽</label><input id="motivationAmount" type="number" min="0.01" step="0.01" required placeholder="Например: 500"></div><div class="wide"><label for="motivationReason">За что</label><input id="motivationReason" required maxlength="300" placeholder="Причина начисления"></div><div class="wide"><label for="motivationNotes">Комментарий</label><textarea id="motivationNotes" maxlength="2000" placeholder="Дополнительные подробности"></textarea></div></div><p id="motivationSaveMessage" class="repair-message"></p><div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="primary" type="submit">Добавить запись</button></div></form></div>`;
  dialog.querySelector('#motivationClose').onclick=()=>dialog.close();
  dialog.querySelectorAll('[data-motivation-event-delete]').forEach(button=>button.onclick=async()=>{const result=await db.from('staff_motivation_events').delete().eq('id',button.dataset.motivationEventDelete);if(result.error){alert(result.error.message);return}motivationEvents=motivationEvents.filter(event=>String(event.id)!==String(button.dataset.motivationEventDelete));cacheLocal();renderMotivation();openMotivationDay(date,index)});
  dialog.querySelector('#motivationEventForm').onsubmit=async event=>{event.preventDefault();const amount=Math.abs(Number(dialog.querySelector('#motivationAmount').value)||0),reason=dialog.querySelector('#motivationReason').value.trim(),notes=dialog.querySelector('#motivationNotes').value.trim(),type=dialog.querySelector('#motivationType').value,message=dialog.querySelector('#motivationSaveMessage');if(!amount||!reason)return;message.textContent='Сохранение…';const result=await db.from('staff_motivation_events').insert({employee_id:employeeId,event_date:date,event_type:type,amount,reason,notes}).select('id,created_at').single();if(result.error){message.textContent='Не сохранено: '+result.error.message;message.className='repair-message bad';return}motivationEvents.push({id:result.data.id,employeeId,date,employee,type,amount,reason,notes});cacheLocal();renderMotivation();openMotivationDay(date,index)};
  if(!dialog.open)dialog.showModal();
}

function initMotivation(){
  const month=$('motivationMonth');if(!month||month.dataset.cloudReady)return;
  month.dataset.cloudReady='1';month.value=motivationMonth;
  month.onchange=()=>{motivationMonth=month.value||motivationMonth;cacheLocal();renderMotivation()};
  renderMotivation();
}

async function start(){
  if(started||!db)return;started=true;
  initShifts();initMotivation();
  await loadCloud();
  realtimeChannel=db.channel('staff-shared')
    .on('postgres_changes',{event:'*',schema:'public',table:'staff_employees'},scheduleReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'staff_shifts'},scheduleReload)
    .on('postgres_changes',{event:'*',schema:'public',table:'staff_motivation_events'},scheduleReload)
    .subscribe();
}
function scheduleReload(){clearTimeout(reloadTimer);reloadTimer=setTimeout(()=>loadCloud({allowSeed:false}),250)}

window.uralstoreStaff={start,initShifts,initMotivation,loadCloud};
window.initShifts=initShifts;
window.initMotivation=initMotivation;
window.addEventListener('app-access-ready',start);
window.addEventListener('app-access-signout',async()=>{
  clearTimeout(reloadTimer);
  if(realtimeChannel)await db.removeChannel(realtimeChannel);
  realtimeChannel=null;started=false;loading=false;employeeIds=[];
});
if(window.uralstoreAccessRole)start();

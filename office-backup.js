const db=window.uralstoreDb;
const downloadButton=document.getElementById('exportBtn');
const restoreButton=document.getElementById('importBtn');
const restoreInput=document.getElementById('importFile');
const SCHEMA='uralstore-office-backup';
const VERSION=1;
const TURNOVER_KEY='uralstore_turnover_prototype_v01';
const EDITOR_KEY='uralstore_buyback_member_v01';

async function rows(table,columns='*',order=''){
  let query=db.from(table).select(columns);if(order)query=query.order(order);
  const result=await query;if(result.error)throw result.error;return result.data||[];
}
async function ensureRepairRead(){
  let result=await db.from('repairs').select('*').order('id');
  if(!result.error)return result.data||[];
  if(result.error.code!=='42501')throw result.error;
  let name='Сотрудник';try{name=localStorage.getItem(EDITOR_KEY)?.trim()||name}catch{}
  const member=await db.rpc('set_repair_member_name',{p_name:name});if(member.error)throw member.error;
  result=await db.from('repairs').select('*').order('id');if(result.error)throw result.error;return result.data||[];
}
async function collectBackup(){
  const repairs=await ensureRepairRead();
  const [norms,buyback,employees,shifts,motivation,repairEvents,turnoverRows,turnoverHistory]=await Promise.all([
    rows('norms','*','id'),rows('buyback_shared_state','*'),rows('staff_employees','*','sort_order'),rows('staff_shifts','*','shift_date'),rows('staff_motivation_events','*','event_date'),rows('repair_events','*','id'),rows('turnover_shared_state','*'),rows('turnover_events','*','id')
  ]);
  const turnover=turnoverRows[0]?.state||{categories:[],items:[]};
  let turnoverLocal=null;try{turnoverLocal=JSON.parse(localStorage.getItem(TURNOVER_KEY)||'null')}catch{}
  return {schema:SCHEMA,version:VERSION,exportedAt:new Date().toISOString(),data:{norms,buyback:buyback[0]||null,employees,shifts,motivation,repairs,repairEvents,turnover,turnoverHistory,turnoverLocal}};
}
function saveJson(payload){
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=`Офис_URALSTORE_копия_${new Date().toISOString().slice(0,10)}.json`;document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);
}
async function downloadBackup(){
  downloadButton.disabled=true;downloadButton.textContent='Подготовка копии…';
  try{saveJson(await collectBackup());alert('Общая резервная копия скачана. Контроль товаров и его журнал взяты из общей базы; исходная локальная копия также сохранена в файле.')}
  catch(error){console.error(error);alert('Не удалось создать полную копию: '+(error.message||'неизвестная ошибка'))}
  finally{downloadButton.disabled=false;downloadButton.textContent='Скачать копию'}
}
function validateBackup(payload){
  if(payload?.schema!==SCHEMA||payload?.version!==VERSION||!payload.data)throw new Error('Это не резервная копия Офиса URALSTORE.');
  for(const key of ['norms','employees','shifts','motivation','repairs','repairEvents'])if(!Array.isArray(payload.data[key]))throw new Error(`В копии повреждён раздел «${key}».`);
  if(!payload.data.turnover||!Array.isArray(payload.data.turnover.categories)||!Array.isArray(payload.data.turnover.items))throw new Error('В копии повреждён раздел контроля товаров.');
  return payload.data;
}
async function restoreNorms(norms){
  if(norms.length){const saved=await db.from('norms').upsert(norms);if(saved.error)throw saved.error}
  const ids=norms.map(item=>Number(item.id)).filter(Number.isFinite);
  const removed=ids.length?await db.from('norms').delete().not('id','in',`(${ids.join(',')})`):await db.from('norms').delete().gte('id',0);
  if(removed.error)throw removed.error;
}
async function restoreBuyback(buyback){
  if(!buyback)return;
  const result=await db.from('buyback_shared_state').upsert({id:1,state:buyback.state||{categories:[]},history:buyback.history||[],column_order:buyback.column_order||{}},{onConflict:'id'});
  if(result.error)throw result.error;
}
async function restoreStaff(data){
  for(const table of ['staff_motivation_events','staff_shifts','staff_employees']){const result=await db.from(table).delete().gte(table==='staff_employees'?'id':table==='staff_motivation_events'?'id':'employee_id',0);if(result.error)throw result.error}
  if(!data.employees.length)return;
  const employeeRows=data.employees.map(({id,updated_at,updated_by,...employee})=>employee);
  const inserted=await db.from('staff_employees').insert(employeeRows).select('id,sort_order');if(inserted.error)throw inserted.error;
  const byOrder=new Map(inserted.data.map(employee=>[Number(employee.sort_order),Number(employee.id)]));
  const oldById=new Map(data.employees.map(employee=>[String(employee.id),Number(employee.sort_order)]));
  const remap=oldId=>byOrder.get(oldById.get(String(oldId)));
  const shifts=data.shifts.map(({updated_at,updated_by,...shift})=>({...shift,employee_id:remap(shift.employee_id)})).filter(shift=>shift.employee_id);
  if(shifts.length){const result=await db.from('staff_shifts').insert(shifts);if(result.error)throw result.error}
  const motivation=data.motivation.map(({id,created_at,created_by,...event})=>({...event,employee_id:remap(event.employee_id)})).filter(event=>event.employee_id);
  if(motivation.length){const result=await db.from('staff_motivation_events').insert(motivation);if(result.error)throw result.error}
}
async function restoreBackup(file){
  const data=validateBackup(JSON.parse(await file.text()));
  const counts=`нормативов: ${data.norms.length}, сотрудников: ${data.employees.length}, смен: ${data.shifts.length}, записей мотивации: ${data.motivation.length}, ремонтов в архиве: ${data.repairs.length}`;
  if(!confirm(`Восстановить общие данные из копии?\n\n${counts}\n\nНормативы, выкуп, смены и мотивация будут заменены. В контроль товаров будут добавлены только отсутствующие позиции: более новые общие изменения сохранятся. Ремонты останутся без изменений: они включены в файл для архива и защищены от массовой перезаписи.`))return;
  restoreButton.disabled=true;restoreButton.textContent='Восстановление…';
  try{
    await restoreNorms(data.norms);await restoreBuyback(data.buyback);await restoreStaff(data);
    if(!window.uralstoreTurnoverImport)throw new Error('Раздел контроля товаров ещё не подключён.');
    await window.uralstoreTurnoverImport(data.turnover,'Администратор');
    alert('Копия восстановлена. Страница сейчас обновится. Ремонты не перезаписывались.');location.reload();
  }catch(error){console.error(error);alert('Восстановление остановлено: '+(error.message||'неизвестная ошибка')+'. Уже выполненные разделы могли сохраниться — не закрывайте исходный файл копии.')}
  finally{restoreButton.disabled=false;restoreButton.textContent='Восстановить копию';restoreInput.value=''}
}

downloadButton.onclick=downloadBackup;
restoreButton.onclick=()=>restoreInput.click();
restoreInput.onchange=()=>restoreInput.files?.[0]&&restoreBackup(restoreInput.files[0]);

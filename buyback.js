const STORAGE_KEY = 'uralstore_buyback_prototype_v01';
const MEMBER_KEY = 'uralstore_buyback_member_v01';
const COLUMN_ORDER_KEY = 'uralstore_buyback_columns_v01';
const HISTORY_KEY = 'uralstore_buyback_history_v01';
const db = window.uralstoreDb;
const COLUMN_DEFS = {
  model:{label:'Модель',width:'1.15fr'},
  memory:{label:'Память',width:'.65fr'},
  configuration:{label:'Конфигурация',width:'.95fr'},
  condition:{label:'Состояние',width:'.65fr'},
  price:{label:'Цена',width:'.75fr'},
  note:{label:'Комментарий',width:'1.2fr'}
};
const DEFAULT_COLUMNS = {
  used:['model','memory','configuration','condition','price','note'],
  new:['model','memory','configuration','price','note']
};

const now = new Date().toISOString();
const defaults = {
  categories: [
    {
      id: 'used-iphone-11', kind: 'used', name: 'iPhone 11', note: 'Демо-категория. Цены условные.', archived: false,
      items: [
        {id:'u11-1',model:'iPhone 11',memory:'64 GB',configuration:'Физическая SIM',condition:'A+',price:18000,note:'Без ремонтов, Face ID работает',sku:'',updatedAt:now,updatedBy:'Демо'},
        {id:'u11-2',model:'iPhone 11',memory:'128 GB',configuration:'Физическая SIM',condition:'A',price:18500,note:'Допустимы небольшие следы использования',sku:'',updatedAt:now,updatedBy:'Демо'}
      ]
    },
    {
      id: 'used-iphone-13', kind: 'used', name: 'iPhone 13', note: '', archived: false,
      items: [
        {id:'u13-1',model:'iPhone 13',memory:'128 GB',configuration:'Физическая SIM',condition:'A+',price:31000,note:'',sku:'',updatedAt:now,updatedBy:'Демо'},
        {id:'u13-2',model:'iPhone 13',memory:'128 GB',configuration:'Dual SIM',condition:'A',price:29500,note:'',sku:'24190',updatedAt:now,updatedBy:'Демо'}
      ]
    },
    {
      id: 'new-iphone-17', kind: 'new', name: 'iPhone 17', note: 'Новая техника. Цены условные.', archived: false,
      items: [
        {id:'n17-1',model:'iPhone 17',memory:'256 GB',configuration:'1 SIM + eSIM',condition:'',price:72000,note:'',sku:'',updatedAt:now},
        {id:'n17-2',model:'iPhone 17 Pro',memory:'256 GB',configuration:'eSIM',condition:'',price:92000,note:'',sku:'',updatedAt:now},
        {id:'n17-3',model:'iPhone 17 Pro Max',memory:'512 GB',configuration:'eSIM',condition:'',price:128000,note:'',sku:'',updatedAt:now}
      ]
    },
    {
      id: 'new-airpods', kind: 'new', name: 'AirPods', note: '', archived: false,
      items: [
        {id:'nap-1',model:'AirPods 4',memory:'',configuration:'Без активного шумоподавления',condition:'',price:9000,note:'',sku:'',updatedAt:now},
        {id:'nap-2',model:'AirPods 4',memory:'',configuration:'С активным шумоподавлением',condition:'',price:12500,note:'',sku:'',updatedAt:now}
      ]
    },
    {
      id: 'new-watch', kind: 'new', name: 'Apple Watch', note: '', archived: false,
      items: [
        {id:'nwatch-1',model:'Apple Watch SE (2024)',memory:'',configuration:'40 мм, GPS',condition:'',price:17000,note:'',sku:'31412',updatedAt:now},
        {id:'nwatch-2',model:'Apple Watch SE (2024)',memory:'',configuration:'44 мм, GPS',condition:'',price:19000,note:'',sku:'',updatedAt:now}
      ]
    },
    {
      id: 'new-macbook', kind: 'new', name: 'MacBook', note: '', archived: false,
      items: [
        {id:'nmac-1',model:'MacBook Air M4',memory:'512 GB',configuration:'15″, 16 GB RAM',condition:'',price:89000,note:'',sku:'',updatedAt:now}
      ]
    }
  ]
};

const clone = value => JSON.parse(JSON.stringify(value));
const newId = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
const ui = () => window.uralstoreUi || {money:value=>`${Number(value)||0} ₽`,escapeHtml:value=>String(value)};
let state = loadState();
let mode = 'used';
let search = '';
let showArchived = false;
let expanded = new Set(['used-iphone-11','new-iphone-17']);
let editing = null;
let columnOrder = loadColumnOrder();
let historyEntries = loadHistory();
let editPageMode = false;
let draggedCategoryId = null;
let cloudStarted = false;
let cloudLoading = false;
let cloudSaving = false;
let cloudSaveTimer = null;
let cloudReloadTimer = null;
let cloudChannel = null;
let cloudReady = false;
let syncText = 'Подключение к общей базе…';
let syncBad = false;

function loadColumnOrder(){
  try{
    const saved=JSON.parse(localStorage.getItem(COLUMN_ORDER_KEY)||'null');
    if(saved?.used&&saved?.new){
      const valid={};
      for(const kind of ['used','new']){
        const expected=DEFAULT_COLUMNS[kind];
        const clean=saved[kind].filter(key=>expected.includes(key));
        valid[kind]=[...new Set([...clean,...expected])];
      }
      return valid;
    }
  }catch{}
  return clone(DEFAULT_COLUMNS);
}

function saveColumnOrder(){
  localStorage.setItem(COLUMN_ORDER_KEY,JSON.stringify(columnOrder));
  queueCloudSave();
}

function loadHistory(){
  try{
    const saved=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
    return Array.isArray(saved)?saved:[];
  }catch{return []}
}

function addHistory(action,subject,detail='',actor=memberName()||'Имя не указано',undoState=clone(state)){
  historyEntries.unshift({id:newId('history'),createdAt:new Date().toISOString(),actor,action,subject,detail,undoState});
  let reversible=0;
  historyEntries=historyEntries.map(entry=>{
    if(entry.undoState&&!entry.undoneAt&&reversible<3){reversible++;return entry}
    const {undoState:discarded,...rest}=entry;
    return rest;
  });
  historyEntries=historyEntries.slice(0,300);
  localStorage.setItem(HISTORY_KEY,JSON.stringify(historyEntries));
  queueCloudSave();
}

function saveHistory(){
  localStorage.setItem(HISTORY_KEY,JSON.stringify(historyEntries));
  queueCloudSave();
}

function formatHistoryDate(value){
  return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
}

function gridStyle(kind){
  return `--buyback-grid:${columnOrder[kind].map(key=>COLUMN_DEFS[key].width).join(' ')} 142px`;
}

function memberName(){
  try{return String(localStorage.getItem(MEMBER_KEY)||'').trim()}catch{return ''}
}

function ensureMemberName(){
  let name=memberName();
  if(name) return name;
  name=window.prompt('Введите своё имя. Оно будет видно в истории изменений выкупа:','');
  name=String(name||'').trim();
  if(name.length<2){window.alert('Введите имя минимум из двух символов.');return ''}
  try{localStorage.setItem(MEMBER_KEY,name)}catch{}
  return name;
}

function memberField(){
  return `<div class="wide"><label for="buybackMemberName">Ваше имя</label><input id="buybackMemberName" autocomplete="name" required minlength="2" maxlength="120" value="${ui().escapeHtml(memberName())}" placeholder="Например: Иван"></div>`;
}

function saveMemberFromDialog(dialog){
  const name=String(dialog.querySelector('#buybackMemberName')?.value||'').trim();
  if(name.length<2) return '';
  try{localStorage.setItem(MEMBER_KEY,name)}catch{}
  return name;
}

function canEdit(){
  return !document.body.classList.contains('app-locked');
}

function loadState(){
  try{
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if(saved?.categories?.length) return saved;
  }catch{}
  return clone(defaults);
}

function saveState(){
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
  queueCloudSave();
}

function cacheCloudLocally(){
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
  localStorage.setItem(HISTORY_KEY,JSON.stringify(historyEntries));
  localStorage.setItem(COLUMN_ORDER_KEY,JSON.stringify(columnOrder));
}

function setSync(text,bad=false){
  syncText=text;syncBad=bad;
  const node=document.getElementById('buybackSync');
  if(node){node.textContent=text;node.className='buyback-prototype '+(bad?'bad':'ok')}
}

function queueCloudSave(){
  if(!cloudReady||!db)return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer=setTimeout(saveCloud,80);
}

async function saveCloud(){
  if(!cloudReady||cloudSaving||!db)return;
  cloudSaving=true;setSync('Сохранение…');
  try{
    const result=await db.from('buyback_shared_state').upsert({id:1,state,column_order:columnOrder,history:historyEntries,updated_at:new Date().toISOString()},{onConflict:'id'});
    if(result.error)throw result.error;
    setSync('Общая база • сохранено');
  }catch(error){
    console.error(error);setSync('Не сохранено',true);
    alert('Не удалось сохранить выкуп в общей базе: '+error.message);
  }finally{cloudSaving=false}
}

async function loadCloud({allowSeed=true}={}){
  if(cloudLoading||!db)return;
  cloudLoading=true;setSync('Синхронизация…');
  try{
    let result=await db.from('buyback_shared_state').select('state,history,column_order,updated_at').eq('id',1).maybeSingle();
    if(result.error)throw result.error;
    if(!result.data&&allowSeed){
      const seeded=await db.from('buyback_shared_state').insert({id:1,state,column_order:columnOrder,history:historyEntries}).select('state,history,column_order,updated_at').single();
      if(seeded.error)throw seeded.error;
      result=seeded;
    }
    if(result.data){
      if(result.data.state?.categories)state=result.data.state;
      if(Array.isArray(result.data.history))historyEntries=result.data.history;
      if(result.data.column_order?.used&&result.data.column_order?.new)columnOrder=result.data.column_order;
      cacheCloudLocally();cloudReady=true;render();setSync('Общая база • сохранено');
    }
  }catch(error){
    console.error(error);cloudReady=false;setSync('Нет связи с общей базой',true);
  }finally{cloudLoading=false}
}

function scheduleCloudReload(){
  if(cloudSaving)return;
  clearTimeout(cloudReloadTimer);
  cloudReloadTimer=setTimeout(()=>loadCloud({allowSeed:false}),250);
}

async function startCloud(){
  if(cloudStarted||!db)return;
  cloudStarted=true;
  await loadCloud();
  if(!cloudReady)return;
  cloudChannel=db.channel('buyback-shared').on('postgres_changes',{event:'*',schema:'public',table:'buyback_shared_state'},scheduleCloudReload).subscribe();
}

function isAdmin(){
  return window.uralstoreAccessRole === 'admin';
}

function formatUpdated(value){
  if(!value) return 'не указано';
  return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(value));
}

function itemMatches(item,query){
  return [item.model,item.memory,item.configuration,item.condition,item.note,item.sku].join(' ').toLowerCase().includes(query);
}

function renderCell(item,key){
  const {money,escapeHtml}=ui();
  if(key==='model') return `<div class="buyback-model buyback-col-model" data-label="Модель"><strong>${escapeHtml(item.model||'Без названия')}</strong>${item.sku?`<div class="note">SKU ${escapeHtml(item.sku)}</div>`:''}</div>`;
  if(key==='price') return `<div class="buyback-price buyback-col-price" data-label="Цена выкупа">${money(item.price)}</div>`;
  if(key==='note') return `<div class="buyback-row-note buyback-col-note" data-label="Комментарий">${escapeHtml(item.note||'—')}<div class="note">Обновлено ${formatUpdated(item.updatedAt)}${item.updatedBy?` · ${escapeHtml(item.updatedBy)}`:''}</div></div>`;
  return `<div class="buyback-col-${key}" data-label="${COLUMN_DEFS[key].label}">${escapeHtml(item[key]||'—')}</div>`;
}

function renderItem(item,kind){
  const editor = canEdit();
  return `<div class="buyback-row ${kind==='new'?'new':''}" style="${gridStyle(kind)}">
    ${columnOrder[kind].map(key=>renderCell(item,key)).join('')}
    ${editor?`<div class="buyback-item-actions"><button type="button" data-buyback-item-edit="${item.id}">Изменить</button><button type="button" data-buyback-item-delete="${item.id}">Удалить</button></div>`:''}
  </div>`;
}

function renderCategory(category,filteredItems){
  const {escapeHtml} = ui();
  const editor = canEdit();
  const admin = isAdmin();
  const open = expanded.has(category.id);
  const head = columnOrder[category.kind].map(key=>`<div class="buyback-col-${key}">${COLUMN_DEFS[key].label}</div>`).join('')+'<div></div>';
  return `<section class="buyback-category ${category.archived?'archived':''} ${editPageMode?'buyback-category-editing':''}" data-buyback-category="${category.id}" ${editPageMode?'draggable="true"':''}>
    <div class="buyback-category-head">
      ${editPageMode?`<div class="buyback-reorder"><span class="buyback-drag-handle" title="Перетащить категорию">⠿</span><button type="button" data-category-up="${category.id}" aria-label="Переместить ${escapeHtml(category.name)} выше">↑</button><button type="button" data-category-down="${category.id}" aria-label="Переместить ${escapeHtml(category.name)} ниже">↓</button></div>`:''}
      <button type="button" class="buyback-category-toggle" data-buyback-toggle="${category.id}" aria-expanded="${open}">
        <span class="buyback-chevron">${open?'⌄':'›'}</span>
        <span class="buyback-category-title"><b>${escapeHtml(category.name)}</b><span>${escapeHtml(category.note || (category.archived?'Скрыта от сотрудников':'Нажмите, чтобы раскрыть'))}</span></span>
      </button>
      <span class="buyback-count">${filteredItems.length} поз.</span>
      ${editor?`<div class="buyback-category-actions"><button type="button" data-buyback-category-edit="${category.id}">Изменить</button>${isAdmin()?`<button type="button" data-buyback-category-archive="${category.id}">${category.archived?'Вернуть':'Скрыть'}</button>`:''}</div>`:''}
    </div>
    ${open?`<div class="buyback-category-body"><div class="buyback-row buyback-row-head ${category.kind==='new'?'new':''}" style="${gridStyle(category.kind)}">${head}</div>${filteredItems.length?filteredItems.map(item=>renderItem(item,category.kind)).join(''):'<div class="buyback-empty">В этой категории пока нет подходящих позиций.</div>'}${editor?`<button type="button" class="buyback-add-item" data-buyback-item-add="${category.id}">+ Добавить позицию</button>`:''}</div>`:''}
  </section>`;
}

function render(){
  const root = document.getElementById('buybackRoot');
  if(!root) return;
  const {escapeHtml} = ui();
  const editor = canEdit();
  const admin = isAdmin();
  const query = search.trim().toLowerCase();
  const categories = state.categories
    .filter(category=>category.kind===mode)
    .filter(category=>showArchived || !category.archived)
    .filter(category=>admin || !category.archived)
    .map(category=>{
      const categoryMatch = category.name.toLowerCase().includes(query);
      const items = query && !categoryMatch ? category.items.filter(item=>itemMatches(item,query)) : category.items;
      return {...category,filteredItems:items,visible:!query||categoryMatch||items.length};
    }).filter(category=>category.visible);

  root.innerHTML = `
    <div class="panel">
      <div class="buyback-head"><div><h2>Выкуп техники</h2><p class="note explain">Общая памятка по актуальным закупочным ценам для сотрудников.</p></div><div class="buyback-head-meta"><span class="buyback-member">${memberName()?`Изменения от: <b>${escapeHtml(memberName())}</b>`:'Имя ещё не указано'}</span><button type="button" id="buybackMemberChange">${memberName()?'Сменить имя':'Указать имя'}</button><span id="buybackSync" class="buyback-prototype ${syncBad?'bad':'ok'}">${escapeHtml(syncText)}</span></div></div>
      <div class="buyback-switch" role="tablist" aria-label="Тип техники"><button type="button" class="${mode==='used'?'active':''}" data-buyback-mode="used">Б/У техника</button><button type="button" class="${mode==='new'?'active':''}" data-buyback-mode="new">Новая техника</button></div>
    </div>
    <div class="panel buyback-toolbar">
      <input id="buybackSearch" value="${escapeHtml(search)}" placeholder="Поиск модели, памяти, конфигурации или SKU">
      ${editor?`${admin?`<label class="buyback-hidden-toggle"><input id="buybackShowArchived" type="checkbox" ${showArchived?'checked':''}>Показывать скрытые</label>`:''}<button type="button" id="buybackHistory">Журнал изменений</button>${editPageMode?'<button type="button" id="buybackColumns">Порядок полей</button>':''}<button type="button" id="buybackEditPage" class="${editPageMode?'primary':''}">${editPageMode?'Готово':'Редактировать страницу'}</button><button type="button" id="buybackAddCategory" class="primary">+ Категория</button>`:''}
    </div>
    ${editPageMode?'<div class="buyback-edit-hint">Перетащите категории за значок ⠿ или используйте стрелки. Порядок сохраняется автоматически.</div>':''}
    <div>${categories.length?categories.map(category=>renderCategory(category,category.filteredItems)).join(''):'<div class="panel buyback-empty">Ничего не найдено. Измените поиск или создайте новую категорию.</div>'}</div>`;

  bindEvents(root);
}

function bindEvents(root){
  root.querySelectorAll('[data-buyback-mode]').forEach(button=>button.onclick=()=>{mode=button.dataset.buybackMode;search='';render()});
  root.querySelector('#buybackSearch').oninput = event=>{
    search=event.target.value;
    render();
    const nextSearch = document.getElementById('buybackSearch');
    nextSearch?.focus();
    nextSearch?.setSelectionRange(search.length,search.length);
  };
  const archived = root.querySelector('#buybackShowArchived');
  if(archived) archived.onchange = event=>{showArchived=event.target.checked;render()};
  const addCategory = root.querySelector('#buybackAddCategory');
  if(addCategory) addCategory.onclick=()=>openCategoryDialog();
  const columns = root.querySelector('#buybackColumns');
  if(columns) columns.onclick=()=>openColumnsDialog();
  const editPage = root.querySelector('#buybackEditPage');
  if(editPage) editPage.onclick=()=>{editPageMode=!editPageMode;search='';render()};
  const history = root.querySelector('#buybackHistory');
  if(history) history.onclick=()=>openHistoryDialog();
  const memberChange = root.querySelector('#buybackMemberChange');
  if(memberChange) memberChange.onclick=()=>{if(ensureMemberName()) render()};
  root.querySelectorAll('[data-buyback-toggle]').forEach(button=>button.onclick=()=>{const id=button.dataset.buybackToggle;expanded.has(id)?expanded.delete(id):expanded.add(id);render()});
  root.querySelectorAll('[data-buyback-category-edit]').forEach(button=>button.onclick=()=>openCategoryDialog(button.dataset.buybackCategoryEdit));
  root.querySelectorAll('[data-buyback-category-archive]').forEach(button=>button.onclick=()=>toggleArchive(button.dataset.buybackCategoryArchive));
  root.querySelectorAll('[data-buyback-item-add]').forEach(button=>button.onclick=()=>openItemDialog(button.dataset.buybackItemAdd));
  root.querySelectorAll('[data-buyback-item-edit]').forEach(button=>button.onclick=()=>openItemDialog(findCategoryByItem(button.dataset.buybackItemEdit)?.id,button.dataset.buybackItemEdit));
  root.querySelectorAll('[data-buyback-item-delete]').forEach(button=>button.onclick=()=>deleteItem(button.dataset.buybackItemDelete));
  root.querySelectorAll('[data-category-up]').forEach(button=>button.onclick=()=>moveCategoryByOffset(button.dataset.categoryUp,-1));
  root.querySelectorAll('[data-category-down]').forEach(button=>button.onclick=()=>moveCategoryByOffset(button.dataset.categoryDown,1));
  root.querySelectorAll('.buyback-category[draggable="true"]').forEach(category=>{
    category.ondragstart=event=>{draggedCategoryId=category.dataset.buybackCategory;category.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggedCategoryId)};
    category.ondragover=event=>{event.preventDefault();event.dataTransfer.dropEffect='move';category.classList.add('drag-over')};
    category.ondragleave=()=>category.classList.remove('drag-over');
    category.ondrop=event=>{event.preventDefault();category.classList.remove('drag-over');const targetId=category.dataset.buybackCategory;if(!draggedCategoryId||draggedCategoryId===targetId)return;const rect=category.getBoundingClientRect();moveCategory(draggedCategoryId,targetId,event.clientY>rect.top+rect.height/2)};
    category.ondragend=()=>{draggedCategoryId=null;root.querySelectorAll('.buyback-category').forEach(node=>node.classList.remove('dragging','drag-over'))};
  });
}

function categoriesForMode(){return state.categories.filter(category=>category.kind===mode)}

function applyCategoryOrder(ordered){
  let index=0;
  state.categories=state.categories.map(category=>category.kind===mode?ordered[index++]:category);
  saveState();
  render();
}

function moveCategoryByOffset(id,direction){
  const ordered=categoriesForMode();
  const from=ordered.findIndex(category=>category.id===id),to=from+direction;
  if(from<0||to<0||to>=ordered.length)return;
  const moved=ordered[from];
  [ordered[from],ordered[to]]=[ordered[to],ordered[from]];
  addHistory('Переместил категорию',moved.name,direction<0?'Выше в списке':'Ниже в списке');
  applyCategoryOrder(ordered);
}

function moveCategory(sourceId,targetId,after=false){
  const ordered=categoriesForMode();
  const sourceIndex=ordered.findIndex(category=>category.id===sourceId);
  if(sourceIndex<0)return;
  const [source]=ordered.splice(sourceIndex,1);
  let targetIndex=ordered.findIndex(category=>category.id===targetId);
  if(targetIndex<0)return;
  if(after)targetIndex++;
  ordered.splice(targetIndex,0,source);
  addHistory('Переместил категорию',source.name,`Новая позиция: ${targetIndex+1}`);
  applyCategoryOrder(ordered);
}

function ensureDialog(){
  let dialog = document.getElementById('buybackDialog');
  if(dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'buybackDialog';
  dialog.className = 'buyback-dialog';
  document.body.append(dialog);
  return dialog;
}

function openHistoryDialog(){
  const dialog=ensureDialog();
  const {escapeHtml}=ui();
  const undoableId=historyEntries.find(entry=>!entry.undoneAt&&entry.undoState)?.id;
  dialog.innerHTML=`<div class="buyback-dialog-inner buyback-history-dialog"><div class="section-head"><div><h2>Журнал изменений</h2><p class="note">Можно последовательно отменить до трёх последних действий</p></div><div class="buyback-history-actions">${isAdmin()&&historyEntries.length?'<button type="button" id="buybackHistoryClear">Очистить журнал</button>':''}<button type="button" data-buyback-dialog-close>Закрыть</button></div></div>${historyEntries.length?`<ol class="buyback-history-list">${historyEntries.map(entry=>`<li class="${entry.undoneAt?'undone':''}"><time>${formatHistoryDate(entry.createdAt)} · ${escapeHtml(entry.actor)}</time><b>${escapeHtml(entry.action)}</b><span>${escapeHtml(entry.subject)}</span>${entry.detail?`<p>${escapeHtml(entry.detail)}</p>`:''}${entry.undoneAt?'<em>Действие отменено</em>':entry.id===undoableId?`<button type="button" class="buyback-undo" data-history-undo="${entry.id}">Отменить</button>`:''}</li>`).join('')}</ol>`:'<div class="buyback-empty">Журнал пока пуст. Здесь появятся новые добавления, изменения, удаления и перестановки.</div>'}</div>`;
  dialog.querySelectorAll('[data-buyback-dialog-close]').forEach(button=>button.onclick=()=>dialog.close());
  dialog.querySelectorAll('[data-history-undo]').forEach(button=>button.onclick=()=>undoHistoryEntry(button.dataset.historyUndo,dialog));
  const clear=dialog.querySelector('#buybackHistoryClear');
  if(clear)clear.onclick=()=>clearHistory(dialog);
  dialog.showModal();
}

function clearHistory(dialog){
  if(!isAdmin()||!confirm('Очистить весь журнал изменений? Категории, позиции и цены останутся без изменений.'))return;
  historyEntries=[];
  saveHistory();
  dialog.close();
  openHistoryDialog();
}

function undoHistoryEntry(id,dialog){
  const entry=historyEntries.find(item=>!item.undoneAt&&item.undoState);
  if(!entry||entry.id!==id||!entry.undoState)return;
  if(!confirm(`Отменить последнее действие «${entry.action.toLowerCase()}»?`))return;
  state=clone(entry.undoState);
  delete entry.undoState;
  entry.undoneAt=new Date().toISOString();
  saveState();
  saveHistory();
  dialog.close();
  render();
  openHistoryDialog();
}

function openColumnsDialog(){
  const dialog=ensureDialog();
  const draw=()=>{
    const columns=columnOrder[mode];
    dialog.innerHTML=`<div class="buyback-dialog-inner"><div class="section-head"><div><h2>Настроить столбцы</h2><p class="note">Раздел: ${mode==='used'?'Б/У техника':'Новая техника'}. Порядок сверху вниз соответствует расположению слева направо.</p></div><button type="button" data-buyback-dialog-close>Закрыть</button></div><div class="buyback-column-list">${columns.map((key,index)=>`<div class="buyback-column-item"><b>${COLUMN_DEFS[key].label}</b><div><button type="button" data-column-up="${key}" ${index===0?'disabled':''} aria-label="Передвинуть ${COLUMN_DEFS[key].label} левее">↑</button><button type="button" data-column-down="${key}" ${index===columns.length-1?'disabled':''} aria-label="Передвинуть ${COLUMN_DEFS[key].label} правее">↓</button></div></div>`).join('')}</div><div class="buyback-dialog-actions"><button type="button" id="buybackColumnsReset">Сбросить порядок</button><button type="button" class="primary" data-buyback-dialog-close>Готово</button></div></div>`;
    dialog.querySelectorAll('[data-buyback-dialog-close]').forEach(button=>button.onclick=()=>{dialog.close();render()});
    dialog.querySelectorAll('[data-column-up]').forEach(button=>button.onclick=()=>moveColumn(button.dataset.columnUp,-1,draw));
    dialog.querySelectorAll('[data-column-down]').forEach(button=>button.onclick=()=>moveColumn(button.dataset.columnDown,1,draw));
    dialog.querySelector('#buybackColumnsReset').onclick=()=>{columnOrder[mode]=[...DEFAULT_COLUMNS[mode]];saveColumnOrder();draw()};
  };
  draw();
  dialog.showModal();
}

function moveColumn(key,direction,redraw){
  const columns=columnOrder[mode];
  const from=columns.indexOf(key),to=from+direction;
  if(from<0||to<0||to>=columns.length) return;
  [columns[from],columns[to]]=[columns[to],columns[from]];
  saveColumnOrder();
  redraw();
}

function openCategoryDialog(id=null){
  if(!canEdit()) return;
  const dialog = ensureDialog();
  const category = id ? state.categories.find(entry=>entry.id===id) : {name:'',note:''};
  editing = {type:'category',id};
  dialog.innerHTML = `<form id="buybackDialogForm" class="buyback-dialog-inner"><div class="section-head"><div><h2>${id?'Изменить категорию':'Новая категория'}</h2><p class="note">Раздел: ${mode==='used'?'Б/У техника':'Новая техника'}</p></div><button type="button" data-buyback-dialog-close>Закрыть</button></div><div class="buyback-dialog-form">${memberField()}<div class="wide"><label for="buybackCategoryName">Название категории</label><input id="buybackCategoryName" required maxlength="120" value="${ui().escapeHtml(category.name)}" placeholder="Например: iPhone 15"></div><div class="wide"><label for="buybackCategoryNote">Комментарий</label><textarea id="buybackCategoryNote" maxlength="500" placeholder="Необязательное пояснение">${ui().escapeHtml(category.note)}</textarea></div></div><div class="buyback-dialog-actions"><button type="button" data-buyback-dialog-close>Отмена</button><button class="primary" type="submit">Сохранить</button></div></form>`;
  bindDialog(dialog);
  dialog.showModal();
}

function openItemDialog(categoryId,itemId=null){
  if(!canEdit()) return;
  const category = state.categories.find(entry=>entry.id===categoryId);
  if(!category) return;
  const item = itemId ? category.items.find(entry=>entry.id===itemId) : {model:'',memory:'',configuration:'',condition:'',price:'',note:'',sku:''};
  const dialog = ensureDialog();
  editing = {type:'item',categoryId,itemId};
  dialog.innerHTML = `<form id="buybackDialogForm" class="buyback-dialog-inner"><div class="section-head"><div><h2>${itemId?'Изменить позицию':'Новая позиция'}</h2><p class="note">Категория: ${ui().escapeHtml(category.name)}</p></div><button type="button" data-buyback-dialog-close>Закрыть</button></div><div class="buyback-dialog-form">${memberField()}<div><label for="buybackModel">Модель</label><input id="buybackModel" required maxlength="160" value="${ui().escapeHtml(item.model)}" placeholder="Например: iPhone 17 Pro"></div><div><label for="buybackMemory">Память</label><input id="buybackMemory" maxlength="80" value="${ui().escapeHtml(item.memory)}" placeholder="Например: 256 GB"></div><div class="wide"><label for="buybackConfiguration">Конфигурация</label><input id="buybackConfiguration" maxlength="240" value="${ui().escapeHtml(item.configuration)}" list="buybackConfigurationHints" placeholder="eSIM, 46 мм GPS, ANC, 15″ 16 GB RAM…"><datalist id="buybackConfigurationHints"><option value="eSIM"><option value="Физическая SIM"><option value="1 SIM + eSIM"><option value="Dual SIM"><option value="С активным шумоподавлением"><option value="Без активного шумоподавления"><option value="GPS"><option value="GPS + Cellular"></datalist></div>${category.kind==='used'?`<div><label for="buybackCondition">Состояние</label><input id="buybackCondition" maxlength="40" value="${ui().escapeHtml(item.condition)}" placeholder="A+, A, B…"></div>`:''}<div><label for="buybackPrice">Цена выкупа, ₽</label><input id="buybackPrice" type="number" min="0" step="1" value="${Number(item.price)||''}" required></div><div><label for="buybackSku">SKU сайта</label><input id="buybackSku" maxlength="80" value="${ui().escapeHtml(item.sku)}" placeholder="Необязательно"></div><div class="wide"><label for="buybackItemNote">Комментарий</label><textarea id="buybackItemNote" maxlength="1000" placeholder="Условия выкупа или внутреннее пояснение">${ui().escapeHtml(item.note)}</textarea></div></div><div class="buyback-dialog-actions"><button type="button" data-buyback-dialog-close>Отмена</button><button class="primary" type="submit">Сохранить</button></div></form>`;
  bindDialog(dialog);
  dialog.showModal();
}

function bindDialog(dialog){
  dialog.querySelectorAll('[data-buyback-dialog-close]').forEach(button=>button.onclick=()=>dialog.close());
  dialog.querySelector('#buybackDialogForm').onsubmit=event=>{
    event.preventDefault();
    if(editing.type==='category') saveCategory(dialog);
    else saveItem(dialog);
    dialog.close();
    saveState();
    render();
  };
}

function saveCategory(dialog){
  const actor = saveMemberFromDialog(dialog);
  const beforeState = clone(state);
  const name = dialog.querySelector('#buybackCategoryName').value.trim();
  const note = dialog.querySelector('#buybackCategoryNote').value.trim();
  if(editing.id){
    const category = state.categories.find(entry=>entry.id===editing.id);
    if(category){
      const previousName=category.name;
      Object.assign(category,{name,note,updatedAt:new Date().toISOString(),updatedBy:actor});
      addHistory('Изменил категорию',name,previousName!==name?`Название: ${previousName} → ${name}`:'Обновлены настройки',actor,beforeState);
    }
  }else{
    const id = newId('category');
    state.categories.push({id,kind:mode,name,note,archived:false,items:[],updatedAt:new Date().toISOString(),updatedBy:actor});
    addHistory('Добавил категорию',name,mode==='used'?'Б/У техника':'Новая техника',actor,beforeState);
    expanded.add(id);
  }
}

function saveItem(dialog){
  const category = state.categories.find(entry=>entry.id===editing.categoryId);
  if(!category) return;
  const previous = editing.itemId ? category.items.find(item=>item.id===editing.itemId) : null;
  const actor = saveMemberFromDialog(dialog);
  const next = {
    id: editing.itemId || newId('item'),
    model: dialog.querySelector('#buybackModel').value.trim(),
    memory: dialog.querySelector('#buybackMemory').value.trim(),
    configuration: dialog.querySelector('#buybackConfiguration').value.trim(),
    condition: dialog.querySelector('#buybackCondition')?.value.trim() || '',
    price: Math.max(0,Number(dialog.querySelector('#buybackPrice').value)||0),
    sku: dialog.querySelector('#buybackSku').value.trim(),
    note: dialog.querySelector('#buybackItemNote').value.trim(),
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
    createdBy: previous?.createdBy || actor
  };
  if(previous){
    const changes=[];
    if(previous.price!==next.price)changes.push(`Цена: ${ui().money(previous.price)} → ${ui().money(next.price)}`);
    for(const [key,label] of [['model','модель'],['memory','память'],['configuration','конфигурация'],['condition','состояние'],['note','комментарий']])if((previous[key]||'')!==(next[key]||''))changes.push(`Изменено поле «${label}»`);
    addHistory('Изменил позицию',next.model||'Без названия',changes.join(' · ')||'Сохранено без изменения основных полей',actor);
  }else addHistory('Добавил позицию',next.model||'Без названия',`${category.name} · ${ui().money(next.price)}`,actor);
  if(editing.itemId) category.items = category.items.map(item=>item.id===editing.itemId?next:item);
  else category.items.push(next);
  expanded.add(category.id);
}

function toggleArchive(id){
  const category = state.categories.find(entry=>entry.id===id);
  if(!category) return;
  const beforeState=clone(state);
  category.archived = !category.archived;
  addHistory(category.archived?'Скрыл категорию':'Вернул категорию',category.name,'',memberName()||'Имя не указано',beforeState);
  saveState();
  render();
}

function findCategoryByItem(itemId){
  return state.categories.find(category=>category.items.some(item=>item.id===itemId));
}

function deleteItem(itemId){
  const category = findCategoryByItem(itemId);
  if(!category || !confirm('Удалить эту позицию из локального прототипа?')) return;
  const item=category.items.find(entry=>entry.id===itemId);
  if(item)addHistory('Удалил позицию',item.model||'Без названия',category.name);
  category.items = category.items.filter(item=>item.id!==itemId);
  saveState();
  render();
}

function init(){
  render();
  startCloud();
}

window.initBuyback = init;
window.addEventListener('app-access-ready',event=>{window.uralstoreAccessRole=event.detail?.role;render();startCloud()});
window.addEventListener('app-access-signout',async()=>{
  clearTimeout(cloudSaveTimer);clearTimeout(cloudReloadTimer);
  if(cloudChannel)await db.removeChannel(cloudChannel);
  cloudChannel=null;cloudStarted=false;cloudLoading=false;cloudSaving=false;cloudReady=false;
});
if(window.uralstoreAccessRole){render();startCloud()}

// Shared turnover storage. The original prototype key is never overwritten.
export const TURNOVER_KEYS={
  legacy:'uralstore_turnover_prototype_v01',
  backup:'uralstore_turnover_before_sync_v01',
  migration:'uralstore_turnover_migration_v01',
  cache:'uralstore_turnover_shared_cache_v01',
  pending:'uralstore_turnover_unsaved_v01'
};
const copy=value=>JSON.parse(JSON.stringify(value));
const table='turnover_shared_state';
const project='cwzobgsgsfbcaryspunh';

export function validateTurnoverState(value){
  if(!value||!Array.isArray(value.categories)||!Array.isArray(value.items))throw new Error('Некорректная копия контроля товаров.');
  const ids=new Set();
  for(const category of value.categories){
    if(!category||typeof category.id!=='string'||!/^[-A-Za-z0-9_]{1,160}$/.test(category.id)||ids.has(category.id)||typeof category.name!=='string'||!category.name.trim())throw new Error('В копии повреждены категории.');
    ids.add(category.id);
  }
  const itemIds=new Set();
  for(const item of value.items){
    if(!item||typeof item.id!=='string'||!/^[-A-Za-z0-9_]{1,160}$/.test(item.id)||itemIds.has(item.id)||!ids.has(item.category)||typeof item.name!=='string'||!item.name.trim())throw new Error('В копии повреждены позиции или их категории.');
    itemIds.add(item.id);
  }
  return value;
}

export class TurnoverSync {
  constructor({db,storage,defaults,onChange=()=>{},onStatus=()=>{},newId=()=>crypto.randomUUID()}){
    Object.assign(this,{db,storage,onChange,onStatus,newId});
    this.defaults=copy(defaults);this.state=copy(defaults);this.version=null;this.ready=false;this.busy=false;this.epoch=0;
    this.channel=null;this.timer=null;this.poll=null;this.loading=null;this.starting=null;this.migrationProblem='';
    const cache=this.read(TURNOVER_KEYS.cache);
    if(cache?.project===project){try{this.state=copy(validateTurnoverState(cache.state))}catch{}}
    else{const legacy=this.read(TURNOVER_KEYS.legacy);if(legacy){try{this.state=copy(validateTurnoverState(legacy))}catch{this.migrationProblem='Локальная копия повреждена. Сначала скачайте её для восстановления.'}}}
  }
  read(key){try{return JSON.parse(this.storage.getItem(key)||'null')}catch{return null}}
  status(message,bad=false){this.onStatus(message,bad)}
  prepareMigration(){
    const raw=this.storage.getItem(TURNOVER_KEYS.legacy);
    if(!raw)return null;
    // Persist the exact old data before reading/replacing any cloud cache.
    if(!this.storage.getItem(TURNOVER_KEYS.backup))this.storage.setItem(TURNOVER_KEYS.backup,JSON.stringify({schema:'uralstore-turnover-local-backup',version:1,exportedAt:new Date().toISOString(),origin:globalThis.location?.origin||'unknown',raw}));
    try{
      const migration=this.read(TURNOVER_KEYS.migration);
      if(migration)return migration;
      const state=copy(validateTurnoverState(JSON.parse(raw)));
      const next={id:`local-${this.newId()}`,state,done:false};
      this.storage.setItem(TURNOVER_KEYS.migration,JSON.stringify(next));
      return next;
    }catch(error){this.migrationProblem=error.message;return null}
  }
  accept(row){
    if(!row||!Number.isSafeInteger(Number(row.version)))throw new Error('Общая база вернула некорректную версию.');
    if(this.version!==null&&Number(row.version)<this.version)return;
    const state=copy(validateTurnoverState(row.state));
    this.state=state;this.version=Number(row.version);this.ready=true;
    try{this.storage.setItem(TURNOVER_KEYS.cache,JSON.stringify({project,state,version:this.version}))}catch{this.status('Общая база доступна; локальную копию сохранить не удалось',true)}
    this.onChange(copy(state));
  }
  async fetchRow(){
    const result=await this.db.from(table).select('state,version,updated_at').eq('id',1).single();
    if(result.error)throw result.error;return result.data;
  }
  async load(){
    if(this.busy)return;
    if(this.loading)return this.loading;
    const epoch=this.epoch;
    this.loading=(async()=>{
      try{const row=await this.fetchRow();if(epoch!==this.epoch)return;this.accept(row);this.status(this.migrationProblem?'Общая база • локальная копия требует проверки':'Общая база • сохранено',Boolean(this.migrationProblem))}
      catch(error){if(epoch!==this.epoch)return;this.ready=false;this.status('Нет связи с общей базой • копия сохранена на устройстве',true);throw error}
    })();
    try{return await this.loading}finally{this.loading=null}
  }
  async start(){
    if(this.starting)return this.starting;
    this.starting=this.startOnce();
    try{return await this.starting}finally{this.starting=null}
  }
  async startOnce(){
    if(this.channel||this.busy||!this.db)return;
    this.status('Подключение…');
    const epoch=this.epoch;
    let migration;
    try{
      migration=this.prepareMigration();
      await this.load();
      if(epoch!==this.epoch)return;
      if(migration&&!migration.done){
        this.busy=true;this.status('Перенос локальной копии…');
        let result;
        for(let attempt=0;attempt<3;attempt++){
          const row=await this.fetchRow();
          if(epoch!==this.epoch)return;
          result=await this.db.rpc('save_turnover_state',{p_state:migration.state,p_expected_version:Number(row.version),p_actor:'Перенос локальных данных',p_action:'import',p_import_key:migration.id});
          if(!result.error||result.error.code!=='PT409')break;
        }
        if(result.error)throw result.error;
        if(epoch!==this.epoch)return;
        this.storage.setItem(TURNOVER_KEYS.migration,JSON.stringify({...migration,done:true,receipt:result.data.receipt||null}));
        this.accept(result.data);
        const skipped=Number(result.data.receipt?.skipped||0);
        this.status(skipped?'Общая база • перенос завершён, совпадения сохранены в копии':'Общая база • сохранено');
      }
      if(epoch!==this.epoch)return;
      this.channel=this.db.channel('turnover-shared').on('postgres_changes',{event:'UPDATE',schema:'public',table},()=>this.scheduleReload()).subscribe();
      // Realtime reconnects can miss an event; refresh on focus and periodically.
      this.poll=setInterval(()=>this.scheduleReload(),30000);this.poll.unref?.();
    }catch(error){
      if(epoch!==this.epoch)return;
      this.ready=false;this.status(error.code==='PGRST205'||error.code==='42P01'?'Общая база ещё не настроена • локальная копия сохранена':'Перенос или подключение не завершены • локальная копия сохранена',true);
      throw error;
    }finally{if(epoch===this.epoch)this.busy=false}
  }
  scheduleReload(){clearTimeout(this.timer);this.timer=setTimeout(()=>this.load().catch(()=>{}),250)}
  async commit(next,{actor='Сотрудник',action='edit',expectedVersion=this.version}={}){
    if(!this.ready||this.busy)throw new Error('Дождитесь подключения к общей базе.');
    validateTurnoverState(next);
    const epoch=this.epoch;
    const pending={schema:'uralstore-turnover-unsaved',version:1,exportedAt:new Date().toISOString(),expectedVersion,state:copy(next),actor,action};
    // If storage is full, stop before a write: the unsaved draft must be recoverable.
    this.storage.setItem(TURNOVER_KEYS.pending,JSON.stringify(pending));
    this.busy=true;this.status('Сохранение…');
    try{
      const result=await this.db.rpc('save_turnover_state',{p_state:next,p_expected_version:expectedVersion,p_actor:actor,p_action:action,p_import_key:null});
      if(result.error)throw result.error;
      if(epoch!==this.epoch)return;
      this.accept(result.data);this.storage.removeItem(TURNOVER_KEYS.pending);this.status('Общая база • сохранено');
      return copy(this.state);
    }catch(error){
      if(epoch!==this.epoch)throw error;
      if(error.code==='PT409'){
        try{this.accept(await this.fetchRow())}catch{this.ready=false}
        this.status('Есть более новые изменения • ваш вариант сохранён в копии',true);
        throw new Error('Позиции уже изменены с другого устройства. Общая версия обновлена; ваш вариант сохранён в локальной копии. Закройте форму, проверьте изменения и откройте её заново.');
      }
      this.ready=false;this.status('Не сохранено в общей базе • ваш вариант сохранён в копии',true);throw error;
    }finally{if(epoch===this.epoch)this.busy=false}
  }
  async history(){const result=await this.db.from('turnover_events').select('id,action,actor_name,version,created_at,details').order('id',{ascending:false}).limit(100);if(result.error)throw result.error;return result.data||[]}
  async snapshot(){const row=await this.fetchRow();return {state:copy(validateTurnoverState(row.state)),version:Number(row.version),history:await this.history()}}
  async importCopy(state,actor='Администратор'){
    validateTurnoverState(state);
    if(!this.ready||this.busy)throw new Error('Дождитесь подключения к общей базе.');
    const epoch=this.epoch,key=`file-${this.newId()}`;
    this.storage.setItem(TURNOVER_KEYS.pending,JSON.stringify({schema:'uralstore-turnover-unsaved',version:1,exportedAt:new Date().toISOString(),state:copy(state),actor,action:'import'}));
    this.busy=true;
    try{
      const result=await this.db.rpc('save_turnover_state',{p_state:state,p_expected_version:this.version,p_actor:actor,p_action:'import',p_import_key:key});
      if(result.error)throw result.error;
      if(epoch!==this.epoch)return;
      this.accept(result.data);this.storage.removeItem(TURNOVER_KEYS.pending);return result.data.receipt;
    }finally{if(epoch===this.epoch)this.busy=false}
  }
  async stop(){
    this.epoch++;this.ready=false;this.busy=false;clearTimeout(this.timer);clearInterval(this.poll);
    const channel=this.channel;this.channel=null;if(channel)await this.db.removeChannel(channel);
  }
  localCopies(){return {original:this.storage.getItem(TURNOVER_KEYS.legacy),backup:this.read(TURNOVER_KEYS.backup),migration:this.read(TURNOVER_KEYS.migration),unsaved:this.read(TURNOVER_KEYS.pending)}}
}

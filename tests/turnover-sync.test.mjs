import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TurnoverSync,TURNOVER_KEYS,validateTurnoverState} from '../turnover-sync.mjs';
const clone=value=>JSON.parse(JSON.stringify(value));
const defaults={categories:[{id:'phones',name:'Телефоны'}],items:[]};
const local={...clone(defaults),items:[{id:'phone-1',category:'phones',name:'iPhone 15',condition:'used',status:'attention',saleBonus:1500}]};

test('SQL uses an HTTP conflict code, not the serialization code that PostgREST retries',()=>{
  const sql=readFileSync(new URL('../supabase-turnover-sync.sql',import.meta.url),'utf8');
  assert.equal((sql.match(/errcode='PT409'/g)||[]).length,2);
  assert.doesNotMatch(sql,/errcode='40001'/);
  assert.match(sql,/declare v_entry jsonb;/);
});
function storage(seed={}){const values=new Map(Object.entries(seed));return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}}
function database(seed=defaults){
  let row={state:clone(seed),version:0},calls=[],imports=new Map();let failure=null;let retryConflict=false;
  const db={
    from(name){assert.ok(['turnover_shared_state','turnover_events'].includes(name));return {select(){return this},eq(){return this},async single(){return {data:clone(row),error:null}},order(){return this},limit(){return Promise.resolve({data:[],error:null})}}},
    channel(){return {on(){return this},subscribe(){return this}}},async removeChannel(){},
    async rpc(name,args){
      assert.equal(name,'save_turnover_state');calls.push(clone(args));
      if(failure)return {error:failure};
      if(retryConflict){retryConflict=false;row.version++;return {error:{code:'PT409',message:'conflict'}}}
      if(imports.has(args.p_import_key))return {data:{...clone(row),receipt:imports.get(args.p_import_key)}};
      if(args.p_expected_version!==row.version)return {error:{code:'PT409',message:'conflict'}};
      if(args.p_import_key){
        const categories=clone(row.state.categories),items=clone(row.state.items);let skipped=0;
        for(const c of args.p_state.categories)if(!categories.some(entry=>entry.id===c.id))categories.push(clone(c));
        for(const i of args.p_state.items){if(items.some(entry=>entry.id===i.id))skipped++;else items.push(clone(i))}
        row={version:row.version+1,state:{categories,items}};
        const receipt={addedItems:items.length-seed.items.length,skipped};imports.set(args.p_import_key,receipt);return {data:{...clone(row),receipt}};
      }
      row={version:row.version+1,state:clone(args.p_state)};return {data:clone(row)};
    },
    setFailure(error){failure=error},setRetryConflict(){retryConflict=true},externalUpdate(state){row={state:clone(state),version:row.version+1}},get row(){return clone(row)},get calls(){return calls}
  };return db;
}
function client(db,store,onChange=()=>{}){return new TurnoverSync({db,storage:store,defaults,onChange,newId:()=> 'unique-device-id'})}

test('migration backs up the exact prototype before import and never rewrites its key',async()=>{
  const raw=JSON.stringify(local),store=storage({[TURNOVER_KEYS.legacy]:raw}),db=database(),sync=client(db,store);
  await sync.start();
  assert.equal(JSON.parse(store.getItem(TURNOVER_KEYS.backup)).raw,raw);
  assert.equal(store.getItem(TURNOVER_KEYS.legacy),raw);
  assert.equal(db.row.state.items[0].saleBonus,1500);
  assert.equal(JSON.parse(store.getItem(TURNOVER_KEYS.migration)).done,true);
  assert.equal(db.calls[0].p_action,'import');
  await sync.stop();
  const again=client(db,store);await again.start();assert.equal(db.calls.length,1);await again.stop();
});

test('an existing shared card wins over an older local copy, which remains in backup',async()=>{
  const remote=clone(local);remote.items[0].name='iPhone 15 — обновлено';
  const store=storage({[TURNOVER_KEYS.legacy]:JSON.stringify(local)}),db=database(remote),sync=client(db,store);
  await sync.start();assert.equal(sync.state.items[0].name,remote.items[0].name);
  assert.equal(JSON.parse(JSON.parse(store.getItem(TURNOVER_KEYS.backup)).raw).items[0].name,'iPhone 15');
  assert.equal(JSON.parse(store.getItem(TURNOVER_KEYS.migration)).receipt.skipped,1);await sync.stop();
});

test('two fresh sessions receive the same state and an older edit cannot overwrite it',async()=>{
  const db=database(local),storeA=storage(),storeB=storage(),a=client(db,storeA),b=client(db,storeB);
  await Promise.all([a.start(),b.start()]);
  const next=clone(local);next.items[0].saleBonus=2500;
  await a.commit(next,{actor:'Арман',action:'edit'});
  const stale=clone(local);stale.items[0].name='Старое редактирование';
  await assert.rejects(b.commit(stale,{actor:'Игорь'}),/другого устройства/);
  assert.deepEqual(b.state,next);assert.deepEqual(db.row.state,next);
  assert.deepEqual(JSON.parse(storeB.getItem(TURNOVER_KEYS.pending)).state,stale);
  await Promise.all([a.stop(),b.stop()]);
});

test('network failure retains the unsaved edit without changing the original copy',async()=>{
  const store=storage({[TURNOVER_KEYS.legacy]:JSON.stringify(local)}),db=database(),sync=client(db,store);
  await sync.start();const next=clone(local);next.items[0].status='sold';
  db.setFailure({code:'network',message:'Нет сети'});
  await assert.rejects(sync.commit(next,{actor:'Игорь',action:'sold'}),()=>true);
  assert.equal(sync.ready,false);assert.equal(db.row.state.items[0].status,'attention');
  assert.equal(JSON.parse(store.getItem(TURNOVER_KEYS.pending)).state.items[0].status,'sold');
  assert.equal(JSON.parse(store.getItem(TURNOVER_KEYS.legacy)).items[0].status,'attention');await sync.stop();
});

test('a failed migration keeps a stable import key; retry is safe and uses a fresh version',async()=>{
  const store=storage({[TURNOVER_KEYS.legacy]:JSON.stringify(local)}),db=database(),sync=client(db,store);
  db.setFailure({message:'Нет сети'});await assert.rejects(sync.start(),()=>true);
  const importKey=JSON.parse(store.getItem(TURNOVER_KEYS.migration)).id;
  assert.equal(JSON.parse(store.getItem(TURNOVER_KEYS.migration)).done,false);
  db.setFailure(null);db.setRetryConflict();await sync.start();
  assert.equal(db.calls.at(-1).p_import_key,importKey);assert.equal(db.row.state.items.length,1);await sync.stop();
});

test('a shared cache never becomes another local migration on reload',async()=>{
  const store=storage({[TURNOVER_KEYS.cache]:JSON.stringify({project:'cwzobgsgsfbcaryspunh',state:local,version:5})}),db=database(local),sync=client(db,store);
  await sync.start();assert.equal(db.calls.length,0);assert.equal(store.getItem(TURNOVER_KEYS.legacy),null);await sync.stop();
});

test('late responses cannot roll back a newer client version',()=>{
  const sync=client(database(),storage());sync.accept({state:local,version:3});sync.accept({state:defaults,version:2});
  assert.equal(sync.version,3);assert.deepEqual(sync.state,local);
});

test('full local storage blocks migration before any cloud write',async()=>{
  const store=storage({[TURNOVER_KEYS.legacy]:JSON.stringify(local)});store.setItem=()=>{throw new Error('QuotaExceeded')};
  const db=database(),sync=client(db,store);await assert.rejects(sync.start(),/QuotaExceeded/);
  assert.equal(db.calls.length,0);assert.equal(db.row.state.items.length,0);
});

test('malformed IDs, duplicate items and orphan categories are rejected without altering a copy',()=>{
  const broken=clone(local);broken.items.push(clone(broken.items[0]));assert.throws(()=>validateTurnoverState(broken));
  broken.items=[{...local.items[0],category:'missing'}];assert.throws(()=>validateTurnoverState(broken));
  broken.items=[{...local.items[0],id:'" onclick="alert(1)'}];assert.throws(()=>validateTurnoverState(broken));
  assert.deepEqual(validateTurnoverState(local),local);
});

test('sign-out during load prevents a late response from re-opening the registry',async()=>{
  const db=database();let finish;
  db.from=()=>({select(){return this},eq(){return this},single(){return new Promise(resolve=>{finish=resolve})}});
  const sync=client(db,storage()),pending=sync.load();await sync.stop();finish({data:{state:local,version:0}});await pending;
  assert.equal(sync.ready,false);assert.deepEqual(sync.state,defaults);
});

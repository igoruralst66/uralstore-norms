export const TURNOVER_STATUSES={attention:'Требует внимания',in_progress:'В работе',sold:'Реализовано'};
export const TURNOVER_CONDITIONS={new:'Новое',used:'Б/У'};

export function daysInStock(receivedDate,now=new Date()){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(receivedDate||'')))return null;
  const received=new Date(`${receivedDate}T12:00:00+05:00`);
  if(Number.isNaN(received.getTime()))return null;
  const current=new Date(now);
  current.setHours(12,0,0,0);
  return Math.max(0,Math.floor((current-received)/86400000));
}

export function stockAgeState(days,status='attention'){
  if(status==='sold')return 'sold';
  if(days==null)return 'unknown';
  if(days<=10)return 'fresh';
  if(days<=25)return 'watch';
  return 'stale';
}

export function filterTurnoverItems(items,{query='',category='all',condition='all',status='active'}={}){
  const needle=String(query).trim().toLowerCase();
  return items.filter(item=>{
    const matchesQuery=!needle||[item.name,item.identifier,item.location,item.reason,item.recommendation,item.responsible,item.notes].join(' ').toLowerCase().includes(needle);
    const matchesCategory=category==='all'||item.category===category;
    const matchesCondition=condition==='all'||item.condition===condition;
    const matchesStatus=status==='all'||(status==='active'?item.status!=='sold':item.status===status);
    return matchesQuery&&matchesCategory&&matchesCondition&&matchesStatus;
  });
}

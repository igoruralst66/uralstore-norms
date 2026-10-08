const button=document.getElementById('excelExportBtn');
const db=window.uralstoreDb;
const readLocal=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||'null')??fallback}catch{return fallback}};
const shortDate=value=>value?String(value).slice(0,10):'';
const labels={rs:'РС',os:'ОС',zo:'ЗО',off:'ВЫХ',bonus:'Бонус',penalty:'Штраф'};

async function cloud(table,columns='*',order=''){
  if(!db)return null;
  let query=db.from(table).select(columns);
  if(order)query=query.order(order);
  const result=await query;
  if(result.error)throw result.error;
  return result.data||[];
}

function addSheet(workbook,name,rows){
  const safeRows=rows.length?rows:[{'Информация':'Данных пока нет'}];
  const sheet=XLSX.utils.json_to_sheet(safeRows);
  sheet['!cols']=Object.keys(safeRows[0]).map(key=>({wch:Math.min(45,Math.max(12,key.length+2,...safeRows.slice(0,100).map(row=>String(row[key]??'').length+2)))}));
  XLSX.utils.book_append_sheet(workbook,sheet,name.slice(0,31));
}

async function collect(){
  const localNorms=readLocal('uralstore_norms_v02',[]);
  const localBuyback=readLocal('uralstore_buyback_prototype_v01',{categories:[]});
  const localStaff=readLocal('uralstore_shifts_v01',{employees:[],cells:{},rates:[],closed:{}});
  const localMotivation=readLocal('uralstore_motivation_events_v01',{events:[]});
  const turnover=window.uralstoreTurnoverExport?.()||readLocal('uralstore_turnover_prototype_v01',{categories:[],items:[]});
  const results=await Promise.allSettled([
    cloud('norms','*','id'),
    cloud('buyback_shared_state','state').then(rows=>rows?.[0]?.state||null),
    cloud('staff_employees','id,name,daily_rate,sort_order,active','sort_order'),
    cloud('staff_shifts','employee_id,shift_date,status,closed,updated_at','shift_date'),
    cloud('staff_motivation_events','id,employee_id,event_date,event_type,amount,reason,notes,created_at','event_date'),
    cloud('repairs','*','id')
  ]);
  const sectionNames=['Нормативы','Выкуп','Сотрудники','Смены','Мотивация','Ремонты'];
  const warnings=results.flatMap((result,index)=>result.status==='rejected'?[`${sectionNames[index]}: ${result.reason?.message||'раздел недоступен'}`]:[]);
  const value=(index,fallback)=>results[index].status==='fulfilled'&&results[index].value!=null?results[index].value:fallback;
  return {norms:value(0,localNorms),buyback:value(1,localBuyback),employees:value(2,null),shifts:value(3,null),motivation:value(4,null),repairs:value(5,[]),localStaff,localMotivation,turnover,warnings};
}

async function exportExcel(){
  if(!window.XLSX){alert('Модуль Excel не загрузился. Проверьте интернет и обновите страницу.');return}
  button.disabled=true;button.textContent='Подготовка Excel…';
  try{
    const source=await collect();
    const workbook=XLSX.utils.book_new();
    addSheet(workbook,'Сводка',[
      {'Раздел':'Офис URALSTORE','Значение':'Единая выгрузка данных'},
      {'Раздел':'Дата выгрузки','Значение':new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'}).format(new Date())},
      {'Раздел':'Назначение','Значение':'Excel предназначен для просмотра. Для восстановления используйте JSON-копию.'},
      ...source.warnings.map(warning=>({'Раздел':'Не выгружено','Значение':warning}))
    ]);

    const categories=new Map((source.turnover.categories||[]).map(category=>[category.id,category.name]));
    addSheet(workbook,'Контроль товаров',(source.turnover.items||[]).map(item=>({
      'Товар':item.name,'Категория':categories.get(item.category)||item.category,'Новое или БУ':item.condition==='new'?'Новое':'Б/У','Идентификатор':item.identifier,'Где находится':item.location,'Дата поступления':item.receivedDate,'Причина внимания':item.reason,'Рекомендация':item.recommendation,'Ответственный':item.responsible,'Бонус за реализацию':item.saleBonus||0,'Сделать до':item.actionDue,'Статус':{attention:'Требует внимания',in_progress:'В работе',sold:'Реализовано'}[item.status]||item.status,'Дата реализации':shortDate(item.soldAt),'Реализовал':item.soldBy,'Комментарий':item.notes,'Обновил':item.updatedBy,'Обновлено':shortDate(item.updatedAt)
    })));

    for(const [kind,sheetName] of [['used','Выкуп БУ'],['new','Выкуп новое']])addSheet(workbook,sheetName,(source.buyback.categories||[]).filter(category=>category.kind===kind).flatMap(category=>(category.items||[]).map(item=>({
      'Категория':category.name,'Скрыта':category.archived?'Да':'Нет','Модель':item.model,'Память':item.memory,'Конфигурация':item.configuration,'Состояние':item.condition,'Цена выкупа':Number(item.price)||0,'SKU':item.sku,'Комментарий':item.note,'Обновил':item.updatedBy,'Обновлено':shortDate(item.updatedAt)
    }))));

    addSheet(workbook,'Нормативы',(source.norms||[]).map(item=>({
      'Категория':item.category,'Название':item.name,'Тип':item.type,'Норматив шт.':item.norm_qty??item.normQty,'Норматив капитала':item.norm_capital??item.normCapital,'Остаток шт.':item.qty,'Средняя себестоимость':item.avg_cost??item.avg,'Рыночная цена':item.market_price??item.market,'Заметка':item.notes
    })));

    let employees=source.employees,shifts=source.shifts,motivation=source.motivation;
    if(!employees){
      employees=(source.localStaff.employees||[]).map((name,index)=>({id:index,name,daily_rate:source.localStaff.rates?.[index]||0,active:true}));
      shifts=Object.entries(source.localStaff.cells||{}).map(([key,status])=>{const [shift_date,employee_id]=key.split('|');return {employee_id:Number(employee_id),shift_date,status,closed:Boolean(source.localStaff.closed?.[key])}});
      motivation=(source.localMotivation.events||[]).map(event=>({...event,employee_id:(source.localStaff.employees||[]).indexOf(event.employee),event_date:event.date,event_type:event.type}));
    }
    const employeeNames=new Map((employees||[]).map(employee=>[String(employee.id),employee.name]));
    addSheet(workbook,'Сотрудники',(employees||[]).map(employee=>({'Сотрудник':employee.name,'Оклад за смену':Number(employee.daily_rate)||0,'Активен':employee.active===false?'Нет':'Да'})));
    addSheet(workbook,'Смены',(shifts||[]).map(shift=>({'Дата':shift.shift_date,'Сотрудник':employeeNames.get(String(shift.employee_id))||shift.employee_id,'Статус':labels[shift.status]||shift.status,'Смена закрыта':shift.closed?'Да':'Нет'})));
    addSheet(workbook,'Мотивация',(motivation||[]).map(event=>({'Дата':event.event_date||event.date,'Сотрудник':employeeNames.get(String(event.employee_id))||event.employee||event.employee_id,'Тип':labels[event.event_type||event.type]||event.event_type||event.type,'Сумма':Number(event.amount)||0,'Причина':event.reason,'Комментарий':event.notes})));
    addSheet(workbook,'Ремонты',(source.repairs||[]).map(row=>({'Номер':row.id,'Создан':shortDate(row.created_at),'Клиент':row.client,'Телефон':row.phone,'Устройство':row.device,'IMEI или серийный':row.serial,'Причина':row.reason,'Ответственный':row.owner,'Сервис':row.service,'Статус':row.status,'Следующее действие':row.next_action,'Сделать до':row.due_date,'Стоимость клиенту':row.client_total,'Получено от клиента':row.client_paid,'Стоимость сервиса':row.service_total,'Оплачено сервису':row.service_paid,'Комментарий':row.notes})));

    XLSX.writeFile(workbook,`Офис_URALSTORE_${new Date().toISOString().slice(0,10)}.xlsx`);
    if(source.warnings.length)alert('Excel создан, но некоторые разделы недоступны:\n\n'+source.warnings.join('\n'));
  }catch(error){console.error(error);alert('Не удалось подготовить Excel: '+(error.message||'неизвестная ошибка'))}
  finally{button.disabled=false;button.textContent='Скачать Excel'}
}

button?.addEventListener('click',exportExcel);

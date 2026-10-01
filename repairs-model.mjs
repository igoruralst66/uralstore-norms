export const STATUSES = {received:'Принят',service:'В сервисе',waiting:'Ждём',ready:'Готов к выдаче',issued:'Выдан',closed:'Закрыт'};
export const FIELDS = {client:'Клиент',phone:'Телефон',device:'Устройство',serial:'IMEI / серийный номер',context:'Состояние и комплект',reason:'Причина обращения',service:'Мастер / сервис',owner:'Ответственный',approver:'Кто согласовал',status:'Статус',waiting_reason:'Причина ожидания',next_action:'Следующее действие',due_date:'Срок действия',client_total:'Стоимость для клиента',client_paid:'Получено от клиента',client_paid_date:'Дата оплаты клиента',client_method:'Способ оплаты клиента',service_total:'Стоимость сервиса',service_paid:'Оплачено сервису',service_paid_date:'Дата оплаты сервису',fs_recorded:'Проведено в FS Склад+',fs_reference:'Запись в FS Склад+',repeat_of:'Повтор по заказу',notes:'Заметки'};
export const EMPTY = {client:'',phone:'',device:'',serial:'',context:'',reason:'',service:'',owner:'',approver:'',status:'received',waiting_reason:'',next_action:'',due_date:null,client_total:null,client_paid:0,client_paid_date:null,client_method:'',service_total:null,service_paid:0,service_paid_date:null,fs_recorded:false,fs_reference:'',repeat_of:null,notes:''};
export const money = value => value == null ? 'Не задано' : new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(value);
export const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Yekaterinburg'}).format(new Date());
export function debt(row,side){return row[side+'_total']==null?null:Math.max(0,Math.round((row[side+'_total']-row[side+'_paid'])*100)/100);}
export function paymentLabel(row,side='client'){
  const total=row[side+'_total'],paid=row[side+'_paid'];
  if(total==null)return 'Стоимость не задана';
  if(total===0)return 'Без оплаты';
  if(paid>=total)return side==='client'?'Оплачено клиентом':'Сервис оплачен';
  return paid>0?'Частично оплачено':'Не оплачено';
}
export const overdue = row => row.status!=='closed' && !!row.due_date && row.due_date<today();
export const isDraft = row => ['client','device','reason','next_action'].some(key=>!row[key]?.trim());
export function validate(row){
  if(!STATUSES[row.status])return 'Выберите статус.';
  for(const side of ['client','service']){
    const total=row[side+'_total'],paid=row[side+'_paid'];
    for(const n of [total,paid])if(n!=null&&(!Number.isFinite(n)||n<0||n>9999999999.99||Math.abs(n*100-Math.round(n*100))>0.0001))return 'Суммы должны быть неотрицательными, с точностью до копейки.';
    if(paid>0&&total==null)return 'Сначала укажите полную стоимость.';
    if(total!=null&&paid>total)return 'Оплаченная сумма не может превышать стоимость.';
    if(paid>0&&!row[side+'_paid_date'])return 'Укажите дату последней оплаты.';
    if(row[side+'_paid_date']&&row[side+'_paid_date']>today())return 'Дата оплаты не может быть в будущем.';
  }
  if(row.repeat_of!=null&&(!Number.isSafeInteger(row.repeat_of)||row.repeat_of<1))return 'Укажите корректный номер предыдущего заказа.';
  if(row.status==='closed'&&isDraft(row))return 'Перед закрытием заполните клиента, устройство, причину обращения и следующий шаг.';
  if(row.status==='closed'&&(debt(row,'client')!==0||debt(row,'service')!==0))return 'Для закрытия укажите обе стоимости (0 для бесплатного ремонта) и завершите расчёты. Пока можно выбрать «Выдан».';
  return '';
}

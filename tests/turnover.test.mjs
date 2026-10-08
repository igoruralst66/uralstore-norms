import test from 'node:test';
import assert from 'node:assert/strict';
import {daysInStock,stockAgeState,filterTurnoverItems} from '../turnover-model.mjs';

test('daysInStock counts whole days and never returns a negative value',()=>{
  assert.equal(daysInStock('2026-10-01',new Date('2026-10-08T12:00:00+05:00')),7);
  assert.equal(daysInStock('2026-10-10',new Date('2026-10-08T12:00:00+05:00')),0);
  assert.equal(daysInStock('',new Date()),null);
});

test('stockAgeState follows 10 and 25 day thresholds',()=>{
  assert.equal(stockAgeState(0),'fresh');
  assert.equal(stockAgeState(10),'fresh');
  assert.equal(stockAgeState(11),'watch');
  assert.equal(stockAgeState(25),'watch');
  assert.equal(stockAgeState(26),'stale');
  assert.equal(stockAgeState(null),'unknown');
  assert.equal(stockAgeState(40,'sold'),'sold');
});

test('filterTurnoverItems combines search, category, condition and status',()=>{
  const items=[
    {name:'iPhone 15 Pro',identifier:'FD-15',category:'phones',condition:'used',status:'attention',location:'На складе'},
    {name:'MacBook Air',identifier:'TRACK-1',category:'laptops',condition:'new',status:'sold',location:'В пути'}
  ];
  assert.deepEqual(filterTurnoverItems(items,{query:'FD-15',category:'phones',condition:'used',status:'active'}).map(item=>item.name),['iPhone 15 Pro']);
  assert.deepEqual(filterTurnoverItems(items,{status:'sold'}).map(item=>item.name),['MacBook Air']);
});

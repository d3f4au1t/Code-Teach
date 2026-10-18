import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorationHistory } from '../src/history';

test('cross-file round trip, breadcrumbs, and circular paths stay finite', () => {
  const h = new ExplorationHistory();
  const a = {file:'/demo/service.ts',offset:20};
  const b = {file:'/demo/route.ts',offset:30};
  const c = {file:'/demo/package.ts',offset:10};
  h.visit(a, 'service'); h.visit(b, 'route'); h.visit(c, 'package');
  assert.equal(h.back()?.name, 'route');
  assert.equal(h.go(0)?.name, 'service');
  h.visit(b, 'route');
  assert.equal(h.visit(a, 'service'), true);
  assert.equal(h.entries.length, 1);
  assert.equal(h.go(-1), undefined);
});

test('edit offsets track unsaved insertions and replacements', () => {
  const h = new ExplorationHistory();
  h.visit({file:'/a.ts',offset:20}, 'a');
  h.visit({file:'/b.ts',offset:20}, 'b');
  h.adjust('/a.ts', [{rangeOffset:0,rangeLength:0,text:'// new\n'}]);
  assert.equal(h.entries[0].query.offset,27);
  assert.equal(h.entries[1].query.offset,20);
  h.adjust('/a.ts', [{rangeOffset:25,rangeLength:10,text:'x'}]);
  assert.equal(h.entries[0].query.offset,25);
});

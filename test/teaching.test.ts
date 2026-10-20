import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Analyzer} from '../src/analyzer';

function project(text: string) {
  const file = '/audit/main.ts';
  const analyzer = new Analyzer({root:'/audit',files:[{file,text}]});
  return (name: string) => analyzer.explain({file,offset:text.indexOf(name)})!;
}

test('object shorthand connects the supplied value and its consumer', () => {
  const explain = project('const price = 12; export const order = {price};');
  assert.ok(explain('order').upstream.some(edge => edge.kind === 'data source' && edge.target?.label === 'price'));
  assert.ok(explain('price').downstream.some(edge => edge.kind === 'consumer' && edge.target?.label === 'order'));
});

test('creating a callback container does not execute its deferred body', () => {
  const explain = project('let count = 0; function write() {} export const callbacks = [() => { count++; write(); }];');
  assert.ok(!explain('callbacks').downstream.some(edge => edge.kind === 'callee' && edge.target?.label === 'write'));
  assert.ok(!explain('callbacks').effects.some(effect => effect.includes('Updates the outer variable count')));
});

test('concise arrows consume the value returned by a call', () => {
  const explain = project('function plus(n:number){return n + 1;} export const pick = () => plus(1);');
  assert.ok(explain('plus').downstream.some(edge => edge.kind === 'consumer' && edge.target?.label === 'pick'));
});


test('teaching explains source steps and maps a real call to parameters', () => {
  const text = `function calculateTotal(prices: number[]) { return prices.reduce((sum, price) => sum + price, 0); }
function saveOrder(customerId: string, total: number) { return {customerId, total}; }
export function checkout(prices: number[], customerId: string) {
  const total = calculateTotal(prices);
  return saveOrder(customerId, total);
}
checkout([12, 8], 'customer-1');`;
  const result = project(text)('checkout');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].title, 'Calculate total');
  assert.match(result.steps[0].code, /const total = calculateTotal/);
  assert.match(result.steps[1].detail, /caller/);
  assert.equal(result.steps[1].kind, 'return');
  assert.deepEqual(result.examples[0].bindings, [
    {parameter:'prices', argument:'[12, 8]'}, {parameter:'customerId', argument:"'customer-1'"}
  ]);
  assert.match(result.examples[0].note, /not executed/);
  assert.ok(result.steps.every(step => text.slice(step.source.start, step.source.end) === step.code));
});

test('branches, loops and deferred definitions are not presented as straight-line execution', () => {
  const result = project('function visit(n: number) { if(n < 0) return 0; for(let i=0;i<n;i++) { console.log(i); } function later(){ throw 1; } return n; }')('visit');
  assert.deepEqual(result.steps.map(step => step.kind), ['branch','loop','declaration','return']);
  assert.match(result.steps[0].detail, /condition|true/);
  assert.match(result.steps[2].detail, /does not run|not run/);
});

test('examples disclose spread arguments and handle omitted defaults and rest parameters', () => {
  const result = project('function take(n = 2, ...rest: number[]) { return n; } take(); take(1,2,3); take(...values);')('take');
  assert.match(result.examples[0].bindings[0].argument, /default 2/);
  assert.equal(result.examples[1].bindings[1].argument, '[2, 3]');
  assert.equal(result.examples[2].bindings.length, 0);
  assert.match(result.examples[2].note, /spread/);
});

test('type-only this parameters do not shift actual argument examples', () => {
  const result = project('function take(this:void,n:number){return n;} take(5);')('take');
  assert.deepEqual(result.examples[0].bindings,[{parameter:'n',argument:'5'}]);
});

test('teaching content is bounded and refreshes after edits', () => {
  const text = `function many(n:number){${Array.from({length:20},(_,i)=>`const x${i}=n+${i};`).join('')}return n;} many(1);`;
  const analyzer = new Analyzer({root:'/audit',files:[{file:'/audit/a.ts',text}]});
  const before = analyzer.explain({file:'/audit/a.ts',offset:9})!;
  assert.equal(before.steps.length,12);
  assert.match(before.notes.join(' '), /12.*steps/);
  analyzer.update('/audit/a.ts', 'function many(n:number){return n * 2;} many(9);');
  const after = analyzer.explain({file:'/audit/a.ts',offset:9})!;
  assert.equal(after.steps.length,1);
  assert.match(after.sourceCode,/n \* 2/);
  assert.equal(after.examples[0].bindings[0].argument,'9');
});


test('expression steps do not invent a function return', () => {
  const text = 'const total = 2 + 3;';
  const analyzer = new Analyzer({root:'/audit',files:[{file:'/audit/a.ts',text}]});
  const result = analyzer.explain({file:'/audit/a.ts',offset:text.indexOf('2'),scope:'expression'})!;
  assert.equal(result.steps[0].kind,'compute');
  assert.doesNotMatch(result.steps[0].detail,/caller/);
  const arrow = project('const twice = (n:number) => n * 2;')('twice');
  assert.equal(arrow.steps[0].kind,'return');
});

test('array examples distinguish reduction, mutation and custom methods', () => {
  const total = project('function total(prices:number[]){return prices.reduce((sum,n)=>sum+n,0);}')('total');
  assert.match(total.steps[0].detail,/combine.*starting with 0/);
  assert.match(total.steps[0].detail,/assumes the standard reduce/);
  const save = project('const orders=[]; function save(order:unknown){ orders.push(order); }')('save');
  assert.match(save.effects.join(' '),/Likely change.*same array/);
  const custom = project('const custom={push(n:number){return n;}}; function save(){custom.push(1);}')('save');
  assert.doesNotMatch(custom.effects.join(' '),/Array pattern/);
});

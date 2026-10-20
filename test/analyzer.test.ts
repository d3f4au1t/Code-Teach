import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { Analyzer } from '../src/analyzer';
import { Explanation } from '../src/model';

const root = path.resolve('/virtual/code-teach');
const file = (name: string) => path.join(root, name);
const fixtures = {
  'math.ts': '/** Multiply a unit price by its quantity. */\nexport function total(price: number, quantity = 1) { return price * quantity; }\nexport const fee = 2;',
  'checkout.ts': "import { total as subtotal, fee } from './math';\nexport function checkout(price: number) { return subtotal(price, 2) + fee; }",
  'entry.ts': "import { checkout } from './checkout';\nexport function start() { return checkout(10); }",
  'math.test.ts': "import { total } from './math';\nexport const tested = total(3, 2);",
};
const make = (files: Record<string, string> = fixtures, compilerOptions?: Record<string, unknown>): Analyzer =>
  new Analyzer({ root, files: Object.entries(files).map(([name, text]) => ({ file: file(name), text })), compilerOptions });
const at = (analyzer: Analyzer, name: string, text: string, occurrence: string): Explanation => {
  const explanation = analyzer.explain({ file: file(name), offset: text.indexOf(occurrence) + 1 });
  assert.ok(explanation, `Expected an explanation for ${name}:${occurrence}`);
  return explanation;
};

test('hover follows imported aliases, documents intent, and links both caller paths across files', () => {
  const analyzer = make();
  const result = at(analyzer, 'checkout.ts', fixtures['checkout.ts'], 'subtotal(price');
  assert.equal(result.name, 'total');
  assert.equal(result.source.file, file('math.ts'));
  assert.match(result.summary, /Documented purpose: Multiply a unit price/);
  assert.deepEqual(result.inputs, ['price: number', 'quantity: number; default 1']);
  assert.ok(result.outputs.some(output => output.includes('price multiplied by quantity')));
  const callers = result.upstream.filter(item => item.kind === 'caller');
  assert.equal(callers.length, 2);
  assert.ok(callers.some(item => item.target?.label === 'checkout' && item.target.file === file('checkout.ts')));
  assert.ok(callers.some(item => item.target?.file === file('math.test.ts')));
  assert.match(result.role, /exported/);
  assert.match(result.role, /checkout/);
  assert.match(result.role, /test file/);
  assert.ok(result.evidence.some(item => item.label.startsWith('Test reference:')));
  assert.ok(result.upstream.some(item => item.kind === 'import' && item.target?.file === file('checkout.ts')));
});

test('complete flow: function → upstream caller → downstream dependency → return target', () => {
  const analyzer = make();
  const total = at(analyzer, 'math.ts', fixtures['math.ts'], 'total(');
  const caller = total.upstream.find(item => item.kind === 'caller' && item.target?.label === 'checkout')!.target!;
  const checkout = analyzer.explain({ file: caller.file, offset: caller.start })!;
  assert.equal(checkout.name, 'checkout');
  const dependency = checkout.downstream.find(item => item.kind === 'callee' && item.target?.label === 'total')!.target!;
  const back = analyzer.explain({ file: dependency.file, offset: dependency.start })!;
  assert.equal(back.id, total.id);
  assert.match(checkout.role, /start/);
  assert.match(checkout.role, /total/);
});

test('edits invalidate definitions and cached consumers; deletion removes stale links', () => {
  const analyzer = make();
  const before = at(analyzer, 'checkout.ts', fixtures['checkout.ts'], 'checkout(');
  assert.ok(before.downstream.some(item => item.kind === 'callee' && item.target?.label === 'total'));
  const cached = at(analyzer, 'checkout.ts', fixtures['checkout.ts'], 'checkout(');
  assert.equal(cached.stats.cached, true);
  const replacement = 'export function checkout(price: number) { return price; }';
  analyzer.update(file('checkout.ts'), replacement);
  const after = at(analyzer, 'checkout.ts', replacement, 'checkout(');
  assert.equal(after.stats.cached, false);
  assert.equal(after.downstream.filter(item => item.kind === 'callee').length, 0);
  const total = at(analyzer, 'math.ts', fixtures['math.ts'], 'total(');
  assert.ok(!total.upstream.some(item => item.kind === 'caller' && item.target?.label === 'checkout'));
  analyzer.update(file('math.test.ts'), null);
  assert.equal(at(analyzer, 'math.ts', fixtures['math.ts'], 'total(').upstream.filter(item => item.kind === 'caller').length, 0);
  analyzer.update(file('math.ts'), 'export function total(price: string) { return price; }');
  assert.match(at(analyzer, 'math.ts', 'export function total(price: string)', 'total(').inputs[0], /string/);
});

test('recursion and circular imports are finite, repeatable relationships', () => {
  const files = {
    'a.ts': "import { b } from './b'; export function a(n: number): number { return n ? a(n - 1) + b(n - 1) : 0; }",
    'b.ts': "import { a } from './a'; export function b(n: number): number { return n ? a(n - 1) : 0; }",
  };
  const analyzer = make(files);
  const result = at(analyzer, 'a.ts', files['a.ts'], 'a(n:');
  assert.deepEqual(result.downstream.filter(item => item.kind === 'callee').map(item => item.target?.label), ['a', 'b']);
  assert.equal(result.upstream.filter(item => item.kind === 'caller').length, 2);
  const again = at(analyzer, 'a.ts', files['a.ts'], 'a(n:');
  assert.equal(again.stats.cached, true);
  assert.equal(again.downstream.length, result.downstream.length);
});

test('tsconfig path aliases and workspace package exports resolve only supplied sources', () => {
  const files = {
    'src/use.ts': "import { plus } from '@lib/math'; import { double } from '@demo/util'; export function use(n: number) { return double(plus(n, 1)); }",
    'src/lib/math.ts': 'export function plus(a: number, b: number) { return a + b; }',
    'packages/util/package.json': '{"name":"@demo/util","exports":{".":{"types":"./index.ts","default":"./index.js"}}}',
    'packages/util/index.ts': 'export function double(value: number) { return value * 2; }',
  };
  const analyzer = make(files, { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } });
  const result = at(analyzer, 'src/use.ts', files['src/use.ts'], 'use(n:');
  assert.deepEqual(result.downstream.filter(item => item.kind === 'callee').map(item => item.target?.label), ['double', 'plus']);
  assert.ok(result.downstream.every(item => item.certainty === 'verified'));
});

test('callback references are consumers, while unresolved dynamic targets remain explicit', () => {
  const files = {
    'events.ts': 'export function handler(value: number) { return value * 2; }\ndeclare function subscribe(cb: (n: number) => number): void;\nsubscribe(handler);\nexport function run(cb: () => void, path: string) { cb(); unknownRuntime(); return import(path); }',
  };
  const analyzer = make(files);
  const handler = at(analyzer, 'events.ts', files['events.ts'], 'handler(value');
  assert.equal(handler.upstream.filter(item => item.kind === 'caller').length, 0);
  assert.ok(handler.downstream.some(item => item.kind === 'consumer' && item.target?.label === 'subscribe'));
  const run = at(analyzer, 'events.ts', files['events.ts'], 'run(cb:');
  assert.ok(run.downstream.some(item => item.certainty === 'inferred' && item.detail.includes('unknownRuntime')));
  assert.ok(run.notes.some(note => note.includes('runtime implementation of cb')));
  assert.ok(run.notes.some(note => note.includes('computed path')));
});

test('expression, class, file, module and project scopes expose concrete children and imports', () => {
  const files = {
    'src/a.ts': 'export class Box { value = 2; getValue() { return this.value * 3; } }',
    'src/b.ts': "import { Box } from './a'; export const box = new Box();",
    'README.md': '# Demo\nUse Box to store a value.',
  };
  const analyzer = make(files);
  const expression = analyzer.explain({ file: file('src/a.ts'), offset: files['src/a.ts'].indexOf('this.value') + 6, scope: 'expression' })!;
  assert.equal(expression.scope, 'expression');
  assert.match(expression.summary, /multiplied by 3/);
  const klass = analyzer.explain({ file: file('src/a.ts'), offset: 14, scope: 'class' })!;
  assert.equal(klass.name, 'Box');
  assert.deepEqual(klass.children.map(item => item.label), ['value', 'getValue']);
  const single = analyzer.explain({ file: file('src/b.ts'), offset: 0, scope: 'file' })!;
  assert.equal(single.children[0].label, 'box');
  assert.ok(single.downstream.some(item => item.kind === 'import' && item.target?.file === file('src/a.ts')));
  const module = analyzer.explain({ file: file('src/a.ts'), offset: 0, scope: 'module' })!;
  assert.equal(module.name, 'src');
  assert.equal(module.children.length, 2);
  const project = analyzer.explain({ file: file('src/a.ts'), offset: 0, scope: 'project' })!;
  assert.equal(project.children.length, 2);
  assert.equal(project.sourceCode, '', 'a project overview must not display one file as project source');
  assert.ok(project.evidence.some(item => item.file === file('README.md')));
});

test('data sources and consumers are tied to actual initializer reads', () => {
  const files = { 'data.ts': 'export const seed = 4; export const doubled = seed * 2; export function show() { return doubled; }' };
  const analyzer = make(files);
  const seed = at(analyzer, 'data.ts', files['data.ts'], 'seed =');
  assert.ok(seed.downstream.some(item => item.kind === 'consumer' && item.target?.label === 'doubled'));
  const doubled = at(analyzer, 'data.ts', files['data.ts'], 'doubled =');
  assert.ok(doubled.upstream.some(item => item.kind === 'data source' && item.target?.label === 'seed'));
  assert.ok(doubled.upstream.some(item => item.kind === 'reference' && item.target?.label === 'show'));
});

test('outer writes and nested function behavior are not confused with local execution', () => {
  const text = 'let count = 0; export function outer(obj: { value: number }) { function nested() { throw new Error("nested"); } count++; obj.value = 2; return count; }';
  const analyzer = make({ 'effects.ts': text });
  const result = at(analyzer, 'effects.ts', text, 'outer(obj');
  assert.ok(result.effects.some(effect => effect.includes('outer variable count')));
  assert.ok(result.effects.some(effect => effect.includes('Writes obj.value')));
  assert.ok(!result.effects.some(effect => effect.includes('May throw')));
  assert.ok(!result.downstream.some(item => item.detail.includes('Error')));
});

test('large fan-out is bounded and omitted paths are disclosed', () => {
  const text = 'export function shared() { return 1; }\n' + Array.from({ length: 80 }, (_, i) => `export function caller${i}() { return shared(); }`).join('\n');
  const result = at(make({ 'many.ts': text }), 'many.ts', text, 'shared()');
  assert.equal(result.upstream.length, 60);
  assert.ok(result.notes.some(note => note.includes('first 60 of 80')));
});

test('already-parsed compiler options retain numeric enums and resolve path aliases', () => {
  const files = {
    'use.ts': "import { value } from '@demo/value'; export function use() { return value(); }",
    'lib/value.ts': 'export function value() { return 42; }',
  };
  const result = at(make(files, { target: 9, module: 99, moduleResolution: 2, baseUrl: root, paths: { '@demo/*': ['lib/*'] }, configFilePath: file('tsconfig.json') }), 'use.ts', files['use.ts'], 'use()');
  assert.ok(result.downstream.some(item => item.target?.label === 'value'));
  assert.ok(!result.notes.some(note => note.includes('compiler options were invalid')));
});

test('deferred callback bodies do not become evaluated initializer data sources', () => {
  const text = 'export const seed = 1; export const callback = () => seed; export const bag = { handler: () => seed };';
  const analyzer = make({ 'closure.ts': text });
  const callback = at(analyzer, 'closure.ts', text, 'callback =');
  assert.ok(!callback.upstream.some(item => item.kind === 'data source' && item.target?.label === 'seed'));
  const bag = at(analyzer, 'closure.ts', text, 'bag =');
  assert.ok(!bag.upstream.some(item => item.kind === 'data source' && item.target?.label === 'seed'));
  const seed = at(analyzer, 'closure.ts', text, 'seed =');
  assert.ok(!seed.downstream.some(item => item.kind === 'consumer'));
  assert.equal(analyzer.explain({ file: file('closure.ts'), offset: text.indexOf('seed ='), scope: 'class' }), null);
});

test('function result consumers describe stored, passed and returned values', () => {
  const text = 'export function produce() { return 2; } function consume(n: number) { return n; } export const stored = produce(); consume(produce()); export function forward() { return produce(); } let mutable = 0; mutable = produce();';
  const result = at(make({ 'results.ts': text }), 'results.ts', text, 'produce()');
  const consumers = result.downstream.filter(item => item.kind === 'consumer');
  assert.ok(consumers.some(item => item.target?.label === 'stored' && item.detail.includes('initializer')));
  assert.ok(consumers.some(item => item.target?.label === 'consume' && item.detail.includes('argument 1')));
  assert.ok(consumers.some(item => item.target?.label === 'forward' && item.detail.includes('returned')));
  assert.ok(consumers.some(item => item.target?.label === 'mutable' && item.detail.includes('assigned')));
  assert.ok(consumers.every(item => item.certainty === 'verified'));
});

test('dynamic callable declarations are inferred and overloads prefer implementations', () => {
  const text = 'export function convert(x: number): number; export function convert(x: string): string; export function convert(x: string | number) { return x; } export function run(cb: () => void) { cb(); return convert(2); }';
  const analyzer = make({ 'overload.ts': text });
  const run = at(analyzer, 'overload.ts', text, 'run(cb:');
  assert.equal(run.downstream.find(item => item.kind === 'callee' && item.target?.label === 'cb')?.certainty, 'inferred');
  const convert = run.downstream.find(item => item.kind === 'callee' && item.target?.label === 'convert')!;
  assert.equal(convert.certainty, 'verified');
  assert.equal(convert.target?.start, text.indexOf('convert(x: string | number)'));
});

test('file links retain file scope and overview uses attributed documentation', () => {
  const files = {
    'src.ts': 'export function example() { return 2; }',
    'package.json': '{"name":"demo","description":"Compute example values."}',
    'README.md': '# Demo\n\nThis demonstration computes example values for learners.',
  };
  const analyzer = make(files);
  const project = analyzer.explain({ file: file('src.ts'), offset: 0, scope: 'project' })!;
  assert.equal(project.children[0].scope, 'file');
  assert.match(project.role, /Package description \(documented\): Compute example/);
  assert.match(project.role, /README context \(documented\): This demonstration/);
});

test('large class member lists and function inputs are capped with omission notes', () => {
  const text = 'export class Large { ' + Array.from({ length: 70 }, (_, i) => `value${i} = ${i};`).join(' ') + ' }\nexport function wide(' + Array.from({ length: 70 }, (_, i) => `p${i}: number`).join(', ') + ') { return p0; }';
  const analyzer = make({ 'large.ts': text });
  const klass = at(analyzer, 'large.ts', text, 'Large {');
  assert.equal(klass.children.length, 60);
  assert.ok(klass.notes.some(note => note.includes('children shows the first 60 of 70')));
  const fn = at(analyzer, 'large.ts', text, 'wide(');
  assert.equal(fn.inputs.length, 60);
  assert.ok(fn.notes.some(note => note.includes('inputs shows the first 60 of 70')));
});

test('explicit array and promise annotations survive absent standard libraries', () => {
  const text = 'export async function total(prices: number[]): Promise<number> { return prices.length; } export const values: string[] = []; export const inferred = [];';
  const analyzer = make({ 'types.ts': text });
  const fn = at(analyzer, 'types.ts', text, 'total(prices');
  assert.deepEqual(fn.inputs, ['prices: number[]']);
  assert.equal(fn.outputs[0], 'Return type: Promise<number>.');
  assert.match(fn.signature!, /prices: number\[\]/);
  assert.match(fn.signature!, /Promise<number>/);
  assert.equal(at(analyzer, 'types.ts', text, 'values:').outputs[0], 'Value type: string[].');
  assert.match(at(analyzer, 'types.ts', text, 'inferred =').outputs[0], /unavailable/);
});

test('unavailable class/function scales return null rather than mislabeling another symbol', () => {
  const text = 'export function standalone() { return 1; } export class Box { value = 1; }';
  const analyzer = make({ 'scales.ts': text });
  assert.equal(analyzer.explain({ file: file('scales.ts'), offset: text.indexOf('standalone'), scope: 'class' }), null);
  assert.equal(analyzer.explain({ file: file('scales.ts'), offset: text.indexOf('Box'), scope: 'function' }), null);
});

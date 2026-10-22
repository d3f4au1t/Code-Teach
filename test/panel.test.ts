import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Explanation, SourceLink } from '../src/model';
import { renderPanel } from '../src/panel';

const source: SourceLink = { file: '/project/src/price.ts', start: 10, end: 40, label: 'price' };
const explanation: Explanation = {
  sourceCode: 'return quantity * 2;', steps: [{title:'Return',detail:'Multiply quantity by 2.',kind:'return',code:'return quantity * 2;',source}], examples: [{code:'price(3)',source,bindings:[{parameter:'quantity',argument:'3'}],note:'Not executed.'}],
  id: 'price', name: 'price', kind: 'function', scope: 'function', source,
  summary: 'Calculates a price.', role: 'Used by checkout to price the basket.', signature: '(quantity: number): number',
  inputs: ['quantity: number'], outputs: ['number'], effects: [], notes: ['Runtime values cannot be determined.'],
  evidence: [source],
  upstream: [{ kind: 'caller', certainty: 'verified', detail: 'checkout calls price.', target: { ...source, label: 'checkout', file: '/project/checkout.ts' }, evidence: source }],
  downstream: [{ kind: 'callee', certainty: 'inferred', detail: 'A dynamic callback cannot be resolved.', evidence: source }],
  children: [{ ...source, label: 'tax' }], stats: { files: 4, elapsedMs: 5.2, cached: false },
};
const history = [{ name: 'project', query: { file: source.file, offset: 0 } }, { name: 'price', query: { file: source.file, offset: 10 } }];

test('panel includes scales, precise relationships, source links, navigation and uncertainty', () => {
  const html = renderPanel(explanation, history);
  for (const label of ['Usage', 'Inputs', 'Outputs', 'Side effects', 'Upstream', 'Downstream', 'Sources', 'Contents', 'caller', 'callee', 'verified', 'inferred']) assert.ok(html.includes(label), label);
  for (const scope of ['expression', 'function', 'class', 'file', 'module', 'project']) assert.ok(html.includes(`data-scope="${scope}"`));
  assert.match(html, /data-action="source" data-index="-1"/);
  assert.match(html, /data-action="breadcrumb" data-index="1" aria-current="page"/);
  assert.match(html, /data-action="navigate" data-direction="upstream" data-index="0" title="Explore checkout in \/project\/checkout.ts"/);
  assert.match(html, /data-action="navigate" data-direction="downstream" data-index="0" disabled/);
  assert.match(html, /No navigable target: dynamic behavior or code outside the indexed project/);
  assert.match(html, /No side effects identified statically. This does not prove there are none/);
  assert.match(html, /4 indexed files · 5 ms/);
  assert.doesNotMatch(html, /<a\b|href=|src=/);
  assert.match(renderPanel(explanation, history.slice(0, 1)), /data-action="back" disabled/);
});

test('project text is escaped in every output position and never injected into script', () => {
  const attack = `</script><img src=x onerror="alert('x')">&`;
  const maliciousSource = { ...source, file: attack, label: attack };
  const html = renderPanel({
    ...explanation, name: attack, kind: attack, summary: attack, role: attack, signature: attack,
    sourceCode: attack, steps:[{title:attack,detail:attack,kind:'compute',code:attack,source:maliciousSource}], examples:[{code:attack,source:maliciousSource,bindings:[{parameter:attack,argument:attack}],note:attack}],
    source: maliciousSource, inputs: [attack], outputs: [attack], effects: [attack], notes: [attack],
    evidence: [maliciousSource], children: [maliciousSource], upstream: [{ kind: 'reference', certainty: 'inferred', detail: attack, target: maliciousSource, evidence: maliciousSource }],
  }, [{ name: attack, query: { file: attack, offset: 0 } }], attack);
  assert.ok(!html.includes(attack));
  assert.ok(html.includes('&lt;/script&gt;&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;'));
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.equal((html.match(/<img\b/g) || []).length, 0);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  assert.ok(!script.includes('alert'));
});

test('CSP blocks resources and permits only the matching random script/style nonce', () => {
  const html = renderPanel(explanation, history);
  const nonce = html.match(/<script nonce="([^"]+)">/)![1];
  assert.match(nonce, /^[A-Za-z0-9+/]{24}$/);
  assert.ok(html.includes(`style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`));
  assert.ok(html.includes(`<style nonce="${nonce}">`));
  assert.match(html, /default-src 'none'; base-uri 'none'; form-action 'none'/);
  assert.ok(!renderPanel(explanation, history).includes(`<script nonce="${nonce}">`));
});

class Button {
  disabled = false;
  tabIndex = 0;
  focused = false;
  attributes: Record<string, string> = {};
  constructor(public dataset: Record<string, string> = {}) {}
  closest(selector: string): Button | null { return selector === 'button' || (selector === '[role="tab"]' && !!this.dataset.tab) ? this : null; }
  getAttribute(name: string): string { return this.attributes[name]; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  focus(): void { this.focused = true; }
}

test('panel sends only indexed navigation messages and supports accessible keyboard tabs', () => {
  const html = renderPanel(explanation, history, undefined, 7);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  const messages: unknown[] = [];
  const listeners: Record<string, (event: { target: Button; key?: string; preventDefault?: () => void }) => void> = {};
  const upstream = new Button({ tab: 'upstream' });
  upstream.setAttribute('aria-controls', 'upstream-panel');
  const downstream = new Button({ tab: 'downstream' });
  downstream.setAttribute('aria-controls', 'downstream-panel');
  const panels: Record<string, { hidden: boolean }> = { 'upstream-panel': { hidden: false }, 'downstream-panel': { hidden: true } };
  let saved: unknown;
  const cards = [ {dataset:{stepCard:'0'},hidden:false}, {dataset:{stepCard:'1'},hidden:true} ];
  const steps = [new Button({step:'0'}),new Button({step:'1'})];
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ getState:() => ({symbol:'price',step:1,direction:'downstream'}), setState:(state:unknown) => { saved = JSON.parse(JSON.stringify(state)); }, postMessage: (message: unknown) => messages.push(JSON.parse(JSON.stringify(message))) }),
    document: {
      body:{dataset:{revision:'7',symbol:'price'}},
      addEventListener: (name: string, handler: typeof listeners[string]) => { listeners[name] = handler; },
      querySelectorAll: (selector:string) => selector === '[data-tab]' ? [upstream,downstream] : selector === '[data-step-card]' ? cards : steps,
      getElementById: (id: string) => panels[id],
    },
  });
  assert.equal(cards[1].hidden, false);
  assert.equal(panels['downstream-panel'].hidden, false);
  listeners.click({target:steps[0]});
  assert.equal(cards[0].hidden, false);
  assert.equal(cards[1].hidden, true);
  assert.deepEqual(saved,{symbol:'price',direction:'downstream',step:0});
  const actions: Array<Record<string, string>> = [
    { action: 'back' }, { action: 'breadcrumb', index: '0' }, { action: 'scope', scope: 'project' },
    { action: 'navigate', index: '0', direction: 'upstream' }, { action: 'source', index: '-1' },
    { action: 'child', index: '0' }, { action: 'refresh' },
  ];
  for (const dataset of actions) listeners.click({ target: new Button(dataset) });
  assert.deepEqual(messages, [
    { action: 'back' }, { action: 'breadcrumb', index: 0 }, { action: 'scope', scope: 'project' },
    { action: 'navigate', index: 0, direction: 'upstream' }, { action: 'source', index: -1 },
    { action: 'child', index: 0 }, { action: 'refresh' },
  ].map(message => ({...message,revision:7})));
  const disabled = new Button({ action: 'navigate' }); disabled.disabled = true;
  listeners.click({ target: disabled });
  listeners.click({ target: downstream });
  assert.equal(messages.length, 7);
  assert.equal(panels['upstream-panel'].hidden, true);
  assert.equal(panels['downstream-panel'].hidden, false);
  assert.equal(downstream.getAttribute('aria-selected'), 'true');
  assert.equal(downstream.tabIndex, 0);
  let prevented = false;
  listeners.keydown({ target: downstream, key: 'ArrowLeft', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(upstream.focused, true);
  assert.equal(upstream.getAttribute('aria-selected'), 'true');
  assert.equal(panels['downstream-panel'].hidden, true);
});

test('connection tree includes data and style paths with their original navigation indexes', () => {
  const html=renderPanel({...explanation,upstream:[],downstream:[
    {kind:'import',certainty:'inferred',detail:'Unresolved import.',evidence:source},
    {kind:'consumer',certainty:'inferred',detail:'Matches a button.',evidence:source,target:{...source,label:'button',file:'/project/index.html'}},
  ]},history);
  const map=html.slice(html.indexOf('aria-label="Connection tree"'),html.indexOf('class="tree-key"'));
  assert.match(map,/data-action="navigate" data-direction="downstream" data-index="1"/);
  assert.match(map,/>consumer <span class="certainty inferred">inferred<\/span>/);
  assert.match(map,/<strong>button<\/strong>/);
  assert.match(map,/<small>index.html<\/small>/);
  assert.match(map,/data-index="0" disabled/);
  assert.match(html,/<table class="io-table"><caption>Behavior summary<\/caption>/);
});

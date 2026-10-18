import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisClient} from '../src/client';

test('worker reads cross-file callers and invalidates after edits', async () => {
  const client = new AnalysisClient();
  try {
    const service = 'export function twice(value: number) { return value * 2; }';
    await client.initialize({root:'/project',files:[{file:'/project/service.ts',text:service},
      {file:'/project/main.ts',text:"import {twice} from './service'; export function main() { return twice(2); }"}]});
    const query = {file:'/project/service.ts',offset:service.indexOf('twice')};
    const first = await client.explain(query);
    assert.ok(first?.upstream.some(edge => edge.kind === 'caller' && edge.target?.file === '/project/main.ts'));
    await client.update('/project/main.ts', 'export function main() { return 4; }');
    const changed = await client.explain(query);
    assert.ok(!changed?.upstream.some(edge => edge.kind === 'caller'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.explain(query, controller.signal), /Cancelled/);
    assert.ok(await client.explain(query));
  } finally { client.dispose(); }
});

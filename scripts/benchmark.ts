import {performance} from 'node:perf_hooks';
import * as os from 'node:os';
import {Analyzer} from '../src/analyzer';
import {AnalysisClient} from '../src/client';

async function benchmark() {
  const results = [];
  for (const scenario of [{count:100,dense:false},{count:1000,dense:false},{count:1000,dense:true}]) {
    const {count,dense} = scenario;
    const files = Array.from({length:count}, (_, i) => ({ file:`/benchmark/module${i}.ts`, text: i === 0
      ? 'export function step0(value: number) { return value + 1; }'
      : `import { step${i - 1} } from './module${i - 1}'; export function step${i}(value: number) { return step${i - 1}(value) + 1; }` }));
    if (dense) for (const [i,file] of files.entries()) file.text += Array.from({length:35},(_,j)=>`\n/** Transforms a record using deterministic local arithmetic. */\nexport function transform${i}_${j}(input: {price: number; quantity: number}, discount: number) { const subtotal = input.price * input.quantity; const net = subtotal - discount; if (net < 0) return 0; return net; }`).join('');
    const project = {root:'/benchmark',files};
    const start = performance.now();
    const analyzer = new Analyzer(project);
    const query = {file:'/benchmark/module0.ts',offset:16};
    const first = analyzer.explain(query);
    const coldMs = performance.now() - start;
    const warm: number[] = [];
    for (let i = 0; i < 50; i++) { const t = performance.now(); analyzer.explain(query); warm.push(performance.now() - t); }
    warm.sort((a,b) => a-b);
    const edit = performance.now();
    analyzer.update('/benchmark/module1.ts','export function step1(value: number) { return value; }');
    const updated = analyzer.explain(query);
    const afterEditMs = performance.now() - edit;
    if (!first?.upstream.some(edge => edge.kind === 'caller') || updated?.upstream.some(edge => edge.kind === 'caller')) throw new Error('Benchmark relationship correctness check failed');
    const client = new AnalysisClient();
    let ticks = 0;
    const interval = setInterval(() => ticks++, 5);
    const workerStart = performance.now();
    try { await client.initialize(project); await client.explain(query); }
    finally { clearInterval(interval); client.dispose(); }
    results.push({scenario:dense?'dense':'small',files:count,bytes:files.reduce((n,f)=>n+Buffer.byteLength(f.text),0),coldMs:+coldMs.toFixed(2),cachedP50Ms:+warm[25].toFixed(3),cachedP95Ms:+warm[47].toFixed(3),afterEditMs:+afterEditMs.toFixed(2),workerRoundTripMs:+(performance.now()-workerStart).toFixed(2),mainThreadTimerTicks:ticks,rssMiB:+(process.memoryUsage().rss/1024/1024).toFixed(1)});
  }
  console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,results},null,2));
}
benchmark().catch(error => {console.error(error);process.exitCode=1;});

import { performance } from 'node:perf_hooks';
import * as os from 'node:os';
import { ProjectAnalyzer } from '../src/project';
import { AnalysisClient } from '../src/client';
import { IndexedFile } from '../src/model';

async function main() {
  const results=[];
  for (const language of ['Java','Python','HTML/CSS']) for (const count of [100,1000]) {
    let files:IndexedFile[], query:{file:string;offset:number}, changed:IndexedFile;
    if(language==='Java') {
      files=Array.from({length:count},(_,i)=>({file:`/benchmark/Step${i}.java`,text:`package bench; class Step${i} { static int run(int value) { return ${i?`Step${i-1}.run(value)`:'value'} + 1; } }`}));
      query={file:files[0].file,offset:files[0].text.indexOf('run(')};
      changed={file:files[1].file,text:'package bench; class Step1 { static int run(int value) { return value; } }'};
    } else if(language==='Python') {
      files=Array.from({length:count},(_,i)=>({file:`/benchmark/step${i}.py`,text:`${i?`from step${i-1} import run as previous\n`:''}def run(value):\n    return ${i?'previous(value)':'value'} + 1\n`}));
      query={file:files[0].file,offset:4};changed={file:files[1].file,text:'def run(value):\n    return value\n'};
    } else {
      files=Array.from({length:count/2},(_,i)=>[
        {file:`/benchmark/page${i}.html`,text:`<link rel="stylesheet" href="style${i}.css"><button class="primary">Go</button>`},
        {file:`/benchmark/style${i}.css`,text:'.primary { color: blue; padding: 1rem; }'},
      ]).flat();
      query={file:files[1].file,offset:1};changed={file:files[0].file,text:'<link rel="stylesheet" href="style0.css"><button>Go</button>'};
    }
    const project={root:'/benchmark',files}, start=performance.now();
    const analyzer=new ProjectAnalyzer(project), first=analyzer.explain(query)!;
    const coldMs=performance.now()-start, warm=[];
    for(let i=0;i<50;i++){const t=performance.now();analyzer.explain(query);warm.push(performance.now()-t);}
    warm.sort((a,b)=>a-b);
    const edit=performance.now();analyzer.update(changed.file,changed.text);const updated=analyzer.explain(query)!;const afterEditMs=performance.now()-edit;
    const relation=language==='HTML/CSS'?'consumer':'caller';
    if(![...first.upstream,...first.downstream].some(e=>e.kind===relation)||[...updated.upstream,...updated.downstream].some(e=>e.kind===relation))throw new Error(language+' edit correctness check failed');
    const workerStart=performance.now(), client=new AnalysisClient();let ticks=0;
    const interval=setInterval(()=>ticks++,5);
    try {await client.initialize(project);await client.explain(query);}finally{clearInterval(interval);client.dispose();}
    results.push({language,files:count,bytes:files.reduce((n,f)=>n+Buffer.byteLength(f.text),0),coldMs:+coldMs.toFixed(2),cachedP95Ms:+warm[47].toFixed(3),afterEditMs:+afterEditMs.toFixed(2),workerRoundTripMs:+(performance.now()-workerStart).toFixed(2),mainThreadTimerTicks:ticks});
  }
  console.log(JSON.stringify({date:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,results},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});

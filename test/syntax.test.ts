import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProjectAnalyzer } from '../src/project';
import { collectProject, isAllowedFile } from '../src/workspace';

const root=path.resolve(__dirname,'../../demo');
const file=(name:string)=>path.join(root,'languages',name);
const source=(name:string)=>fs.readFileSync(file(name),'utf8');
const create=async()=>new ProjectAnalyzer(await collectProject(root));
const query=(name:string,needle:string)=>({file:file(name),offset:source(name).indexOf(needle)});

test('Java: hover → upstream caller → downstream cross-file dependency → edits',async()=>{
  const analyzer=await create(), q=query('java/Checkout.java','checkout(');
  const result=analyzer.explain(q)!;
  assert.equal(result.name,'checkout');assert.match(result.summary,/Turns the cart/);
  assert.equal(result.scope,'function');assert.match(result.inputs.join(),/double\[\] prices/);
  assert.match(result.outputs.join(),/double/);
  const caller=result.upstream.find(e=>e.kind==='caller')!;
  assert.equal(caller.certainty,'inferred');assert.equal(caller.target?.label,'handle');
  assert.equal(analyzer.explain({file:caller.target!.file,offset:caller.target!.start})?.name,'handle');
  const dependency=result.downstream.find(e=>e.kind==='callee')!;
  assert.equal(dependency.target?.label,'total');assert.equal(dependency.certainty,'inferred');
  const total=analyzer.explain({file:dependency.target!.file,offset:dependency.target!.start})!;
  assert.ok(total.steps.some(s=>s.kind==='loop'));assert.equal(total.source.file,file('java/Pricing.java'));
  analyzer.update(file('java/Route.java'),source('java/Route.java').replace('Checkout.checkout(prices)','0'));
  assert.equal(analyzer.explain(q)!.upstream.filter(e=>e.kind==='caller').length,0);
  analyzer.update(file('java/Route.java'),source('java/Route.java'));
  assert.equal(analyzer.explain(q)!.upstream.filter(e=>e.kind==='caller').length,1);
});

test('Python: imported functions, docs, parameters, actual calls, cycles and edits',async()=>{
  const analyzer=await create(),q=query('python/checkout.py','checkout('), result=analyzer.explain(q)!;
  assert.equal(result.name,'checkout');assert.match(result.summary,/customer/);
  assert.equal(result.downstream.find(e=>e.kind==='callee')?.target?.label,'total');
  assert.equal(result.upstream.find(e=>e.kind==='caller')?.target?.label,'handle');
  assert.equal(result.examples[0].bindings.find(b=>b.parameter==='customer_id')?.argument,'"customer-1"');
  analyzer.update(file('python/pricing.py'),'from checkout import checkout\ndef total(prices):\n    return checkout(prices)\n');
  const total=analyzer.explain({file:file('python/pricing.py'),offset:33})!;
  assert.ok(total);assert.ok(analyzer.explain(q)!.upstream.length<60);
  analyzer.update(file('python/route.py'),null);
  assert.ok(!analyzer.explain(q)!.upstream.some(e=>e.target?.label==='handle'));
});

test('HTML and CSS: linked stylesheet → literal selector → consuming element; JS resource',async()=>{
  const analyzer=await create(),q=query('web/style.css','.primary');
  const result=analyzer.explain(q)!;
  assert.equal(result.kind,'style rule');assert.ok(result.steps.some(s=>s.code.includes('padding')));
  const consumer=result.downstream.find(e=>e.kind==='consumer')!;
  assert.equal(consumer.target?.label,'button');assert.equal(consumer.certainty,'inferred');
  const element=analyzer.explain({file:consumer.target!.file,offset:consumer.target!.start})!;
  assert.equal(element.kind,'element');assert.match(element.summary,/clickable/);
  assert.ok(element.upstream.some(e=>e.target?.label==='.primary'));
  const page=analyzer.explain({...query('web/index.html','<html'),scope:'file'})!;
  assert.ok(page.downstream.some(e=>e.kind==='import'&&e.target?.file===file('web/app.js')&&e.certainty==='verified'));
  const js=analyzer.explain({file:file('web/app.js'),offset:0,scope:'file'})!;
  assert.ok(js.children.some(c=>c.label==='formatTotal'));
  analyzer.update(file('web/index.html'),source('web/index.html').replace('class="primary"','class="secondary"'));
  assert.equal(analyzer.explain(q)!.downstream.filter(e=>e.kind==='consumer').length,0);
});

test('project overview includes all languages and scopes drill down',async()=>{
  const analyzer=await create();
  const project=analyzer.explain({file:file('java/Checkout.java'),offset:0,scope:'project'})!;
  for(const extension of ['.java','.py','.html','.css','.ts','.js'])assert.ok(project.children.some(c=>c.file.endsWith(extension)),extension);
  const klass=analyzer.explain({...query('java/Checkout.java','Checkout'),scope:'class'})!;
  assert.ok(klass.children.some(c=>c.label==='checkout'));
  assert.equal(analyzer.explain({...query('python/checkout.py','checkout'),scope:'class'}),null);
});

test('ambiguous overloads and shadowed Python names do not become verified targets',()=>{
  const analyzer=new ProjectAnalyzer({root:'/project',files:[
    {file:'Test.java',text:'class Test { void f(int a) {} void f(String a) {} void g() { f(null); } }'},
    {file:'test.py',text:'def target():\n    return 1\ndef call(target):\n    return target()\n'},
  ]});
  const java=analyzer.explain({file:'/project/Test.java',offset:55})!;
  assert.ok(java.downstream.some(e=>e.kind==='callee'&&!e.target&&e.certainty==='inferred'));
  const python=analyzer.explain({file:'/project/test.py',offset:40,scope:'function'})!;
  assert.ok(python.downstream.some(e=>e.kind==='callee'&&!e.target));
});

test('new source extensions obey the same exclusions as JS/TS',async()=>{
  const os=await import('node:os');const temp=await fs.promises.mkdtemp(path.join(os.tmpdir(),'teach-languages-'));
  try {
    for(const folder of ['src','venv','target','generated','.gradle'])await fs.promises.mkdir(path.join(temp,folder));
    for(const ext of ['java','py','css','html'])for(const folder of ['src','venv','target','generated','.gradle'])await fs.promises.writeFile(path.join(temp,folder,'sample.'+ext),'content');
    await fs.promises.writeFile(path.join(temp,'src','.env.py'),'private');
    const project=await collectProject(temp);
    assert.equal(project.files.length,4);
    assert.equal(await isAllowedFile(temp,path.join(temp,'venv','sample.py')),false);
    assert.equal(await isAllowedFile(temp,path.join(temp,'src','.env.py')),false);
  } finally {await fs.promises.rm(temp,{recursive:true,force:true});}
});


test('mixed project and JS resource links remain stable when served from cache',async()=>{
  const analyzer=await create();const q={file:file('web/app.js'),offset:0,scope:'project' as const};
  const first=analyzer.explain(q)!;assert.ok(first.downstream.some(e=>e.detail.includes('@demo/pricing')));
  assert.deepEqual(analyzer.explain(q)!.downstream,first.downstream);
  const fileQuery={...q,scope:'file' as const};const js=analyzer.explain(fileQuery)!;
  assert.ok(js.upstream.some(e=>e.target?.file.endsWith('index.html')));
  assert.deepEqual(analyzer.explain(fileQuery)!.upstream,js.upstream);
});

test('declared Java receiver fields, variables and constructors are navigable candidates',()=>{
  const text='class Motor { void set(double power) {} } class Robot { private Motor motor; void run(double power) { motor.set(power); } Motor create() { return new Motor(); } }';
  const analyzer=new ProjectAnalyzer({root:'/p',files:[{file:'Robot.java',text}]});
  const run=analyzer.explain({file:'/p/Robot.java',offset:text.indexOf('run(')})!;
  assert.ok(run.downstream.some(e=>e.target?.label==='set'&&e.certainty==='inferred'));
  const variable=analyzer.explain({file:'/p/Robot.java',offset:text.indexOf('power);')})!;
  assert.equal(variable.kind,'variable');assert.ok(variable.downstream.some(e=>e.kind==='consumer'));
  const create=analyzer.explain({file:'/p/Robot.java',offset:text.indexOf('create(')})!;
  assert.ok(create.downstream.some(e=>e.target?.label==='Motor'));
});

test('Python keyword argument order and unpacking do not invent parameter values',()=>{
  const text='def target(first, second=2):\n    return first\ndef call():\n    target(second=3, first=1)\n    target(*values)\n';
  const analyzer=new ProjectAnalyzer({root:'/p',files:[{file:'a.py',text}]});
  const result=analyzer.explain({file:'/p/a.py',offset:4})!;
  assert.deepEqual(result.examples[0].bindings,[{parameter:'first',argument:'1'},{parameter:'second',argument:'3'}]);
  assert.ok(result.examples[1].bindings.every(b=>b.argument.includes('Cannot bind statically')));
});

test('Java receiver chains and nested class types link across packages',()=>{
  const source='package app; import devices.Robot; import devices.Factory; class Loop { Robot robot; Factory.Controller controller; void tick() { robot.motor.set(1); controller.update(); } }';
  const analyzer=new ProjectAnalyzer({root:'/p',files:[
    {file:'Loop.java',text:source},
    {file:'Robot.java',text:'package devices; class Robot { Motor motor; }'},
    {file:'Motor.java',text:'package devices; class Motor { void set(double power) {} }'},
    {file:'Factory.java',text:'package devices; class Factory { static class Controller { void update() {} } }'},
  ]});
  const tick=analyzer.explain({file:'/p/Loop.java',offset:source.indexOf('tick(')})!;
  assert.deepEqual(tick.downstream.filter(e=>e.kind==='callee').map(e=>[e.target?.label,e.target?.file]),[['set','/p/Motor.java'],['update','/p/Factory.java']]);
  analyzer.update('Motor.java','package devices; class Motor { void stop() {} }');
  assert.ok(!analyzer.explain({file:'/p/Loop.java',offset:source.indexOf('tick(')})!.downstream.some(e=>e.target?.label==='set'));
});

test('Python relative aliases resolve locally while absolute imports disclose search-path uncertainty',()=>{
  const source='from .pricing import total as calculate\nimport external\ndef checkout():\n    return calculate(1)\n';
  const analyzer=new ProjectAnalyzer({root:'/p',files:[{file:'shop/checkout.py',text:source},{file:'shop/pricing.py',text:'def total(value):\n    return value\n'},{file:'another/external.py',text:'def run():\n    pass\n'}]});
  const result=analyzer.explain({file:'/p/shop/checkout.py',offset:source.indexOf('checkout(')})!;
  assert.equal(result.downstream.find(e=>e.kind==='callee')?.target?.file,'/p/shop/pricing.py');
  const imports=analyzer.explain({file:'/p/shop/checkout.py',offset:0,scope:'file'})!.downstream.filter(e=>e.kind==='import');
  assert.equal(imports[0].certainty,'verified');assert.equal(imports[1].certainty,'inferred');
});

test('CSS import cycles terminate and unlinked styles do not match page elements',()=>{
  const analyzer=new ProjectAnalyzer({root:'/p',files:[
    {file:'index.html',text:'<link rel="stylesheet" href="a.css"><button class="primary">Go</button>'},
    {file:'a.css',text:'@import url(b.css);'},
    {file:'b.css',text:'@import "a.css"; .primary { color: blue; }'},
    {file:'unlinked.css',text:'.primary { color: red; }'},
  ]});
  assert.equal(analyzer.explain({file:'/p/b.css',offset:19})!.downstream.filter(e=>e.kind==='consumer').length,1);
  assert.equal(analyzer.explain({file:'/p/unlinked.css',offset:1})!.downstream.filter(e=>e.kind==='consumer').length,0);
});

test('argument examples preserve equality expressions and Java parameters named self',()=>{
  const py='def target(value):\n    return value\ndef caller():\n    return target(left == right)\n';
  const java='class C { void target(int self, int... values) {} void caller() { target(1, 2, 3); } }';
  const analyzer=new ProjectAnalyzer({root:'/p',files:[{file:'a.py',text:py},{file:'C.java',text:java}]});
  const klass=analyzer.explain({file:'/p/C.java',offset:6})!;
  assert.equal(klass.kind,'class');assert.ok(klass.children.some(c=>c.label==='target'));
  assert.equal(analyzer.explain({file:'/p/a.py',offset:4})!.examples[0].bindings[0].argument,'left == right');
  const bindings=analyzer.explain({file:'/p/C.java',offset:java.indexOf('target(')})!.examples[0].bindings;
  assert.equal(bindings[0].parameter,'self');assert.equal(bindings[0].argument,'1');assert.match(bindings[1].argument,/Variadic/);
});

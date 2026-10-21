import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Explanation} from '../src/model';

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 15_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(predicate(), message);
}

export async function run() {
  const extension = vscode.extensions.getExtension('code-teach-local.code-teach');
  assert.ok(extension, 'extension installed in development host');
  const api = await extension.activate() as {getCurrentExplanation():Explanation | undefined; getRevision():number; handlePanelMessage(message:unknown):Promise<void>; getHistory():unknown[]};
  const action = (message:object) => api.handlePanelMessage({...message,revision:api.getRevision()});
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const file = path.join(root, 'src/checkout.ts');
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  const offset = document.getText().indexOf('function checkout') + 'function '.length;
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position);
  assert.ok(hovers?.some(hover => hover.contents.some(content => (typeof content === 'string' ? content : content.value).includes('Explain more'))), 'teaching hover has persistent panel action');
  const teachingHover = hovers!.flatMap(hover => hover.contents).find(content => (typeof content === 'string' ? content : content.value).includes('Explain more'))!;
  const hoverText = typeof teachingHover === 'string' ? teachingHover : teachingHover.value;
  assert.doesNotMatch(hoverText, /&nbsp;|\u00a0/, 'hover prose must wrap naturally in narrow editors');
  assert.match(hoverText, /…/, 'bounded prose clearly marks omitted text instead of cutting off a word');
  await vscode.commands.executeCommand('codeTeach.explain', {file,offset});
  const current = () => api.getCurrentExplanation()!;
  assert.equal(current().name, 'checkout');
  assert.equal(current().steps.length,2);
  assert.ok(current().examples.some(example=>example.bindings.some(binding=>binding.argument==='[12, 8]')));
  await action({action:'step',index:0});
  assert.equal(document.offsetAt(vscode.window.visibleTextEditors.find(e=>e.document.uri.fsPath===file)!.selection.start),current().steps[0].source.start);
  await action({action:'example',index:0});
  const exampleSource = current().examples[0].source;
  const exampleEditor = vscode.window.visibleTextEditors.find(e=>e.document.uri.fsPath===exampleSource.file)!;
  assert.equal(exampleEditor.document.offsetAt(exampleEditor.selection.start), exampleSource.start);
  const staleRevision = api.getRevision();
  const callerIndex = current().upstream.findIndex(edge=>edge.kind==='caller' && edge.target?.file.endsWith('route.ts'));
  assert.ok(callerIndex>=0,'cross-file upstream caller');
  await action({action:'navigate',direction:'upstream',index:callerIndex});
  assert.equal(current().name,'checkoutRoute');
  await api.handlePanelMessage({action:'back',revision:staleRevision});
  assert.equal(current().name,'checkoutRoute','stale panel messages are ignored');
  await action({action:'back'});
  assert.equal(current().name,'checkout');
  const dependency = current().downstream.findIndex(edge=>edge.kind==='callee' && edge.target?.file.includes('pricing'));
  assert.ok(dependency>=0,'cross-package downstream dependency');
  await action({action:'navigate',direction:'downstream',index:dependency});
  assert.equal(current().name,'calculateTotal');
  assert.match(current().steps[0].detail,/combine.*starting with 0/);
  await action({action:'back'});
  assert.equal(current().name,'checkout');
  await action({action:'scope',scope:'project'});
  assert.equal(current().scope,'project');
  assert.ok(current().children.length>0);
  await action({action:'back'});
  assert.equal(current().name,'checkout');

  const route = await vscode.workspace.openTextDocument(path.join(root,'src/route.ts'));
  const original = route.getText();
  const replace = async (text:string) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(route.uri,new vscode.Range(route.positionAt(0),route.positionAt(route.getText().length)),text);
    assert.ok(await vscode.workspace.applyEdit(edit));
  };
  try {
    await replace('export function checkoutRoute() { return null; }');
    await until(()=>!!api.getCurrentExplanation() && !current().upstream.some(edge=>edge.kind==='caller' && edge.target?.file.endsWith('route.ts')),'unsaved edits automatically refresh the panel');
  } finally { await replace(original); }
  await until(()=>current()?.upstream.some(edge=>edge.kind==='caller' && edge.target?.file.endsWith('route.ts')),'restoring a caller refreshes it');

  const configPath = path.join(root,'tsconfig.json');
  const configText = await fs.readFile(configPath,'utf8');
  const basePath = path.join(root,'tsconfig.base.json');
  const config = JSON.parse(configText);
  const paths = config.compilerOptions.paths;
  const alternative = path.join(root,'src/other-pricing.ts');
  try {
    await fs.writeFile(alternative,'export function calculateTotal(prices:number[]) { return 99; }');
    await fs.writeFile(basePath, JSON.stringify({compilerOptions:{paths}}));
    delete config.compilerOptions.paths;
    config.extends='./tsconfig.base.json';
    await fs.writeFile(configPath, JSON.stringify(config));
    await action({action:'refresh'});
    await until(()=>!!api.getCurrentExplanation() && current().downstream.some(edge=>edge.target?.label==='calculateTotal'),'inherited paths resolve before the edit');
    await fs.writeFile(basePath,JSON.stringify({compilerOptions:{paths:{'@demo/pricing':['./src/other-pricing.ts']}}}));
    await until(()=>!!api.getCurrentExplanation() && current().downstream.some(edge=>edge.target?.file===alternative),'saved inherited configuration changes automatically refresh resolution');
  } finally {
    await fs.writeFile(configPath,configText);
    await fs.rm(basePath,{force:true});
    await fs.rm(alternative,{force:true});
  }
  await action({action:'refresh'});
  console.log('Code Teach extension-host demo passed: hover → steps/examples → caller → package dependency → Back → automatic edit/config refresh; stale messages rejected.');
}

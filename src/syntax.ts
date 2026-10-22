import * as path from 'node:path';
import { SyntaxNode, Tree } from '@lezer/common';
import { parser as java } from '@lezer/java';
import { parser as python } from '@lezer/python';
import { parser as html } from '@lezer/html';
import { parser as css } from '@lezer/css';
import { AnalysisQuery, Explanation, IndexedFile, ProjectInput, Relationship, Scope, SourceLink, TeachingStep } from './model';
import { languageFor, sourcePattern } from './languages';

const LIMIT = 60;
const short = (s: string, n = 240) => s.length > n ? s.slice(0, n - 1) + '…' : s;
const compact = (s: string, n = 240) => short(s.replace(/\s+/g, ' ').trim(), n);
const children = (n?: SyntaxNode | null): SyntaxNode[] => {
  const result: SyntaxNode[] = [];
  for (let c = n?.firstChild; c; c = c.nextSibling) result.push(c);
  return result;
};
const inside = (a: SyntaxNode, b: SyntaxNode) => a.from <= b.from && a.to >= b.to;
interface Parameter { name: string; declaration: string; fallback?: string; }
interface Unit { file: File; node: SyntaxNode; nameNode: SyntaxNode; name: string; kind: string; scope: Scope; body?: SyntaxNode; parameters: Parameter[]; owner?: Unit; }
interface Import { node: SyntaxNode; module: string; alias?: string; member?: string; target?: File; }
interface Call { unit: Unit; node: SyntaxNode; expression: string; arguments: string[]; target?: Unit; }
interface File { path: string; text: string; language: string; tree: Tree; units: Unit[]; imports: Import[]; calls: Call[]; package: string; errors: boolean; }
interface Edge { from: Unit; to?: Unit; kind: Relationship['kind']; certainty: Relationship['certainty']; evidence: SourceLink; detail: string; }
const getText = (file: File, node?: SyntaxNode | null) => node ? file.text.slice(node.from, node.to) : '';
const textChild = (file: File, node: SyntaxNode, name: string) => getText(file, node.getChild(name));
function parts(file: File, node?: SyntaxNode | null): string[] {
  if (!node) return [];
  const result: string[] = []; let start = node.from + 1;
  for (const child of children(node)) if (child.name === ',') { result.push(file.text.slice(start, child.from).trim()); start = child.to; }
  const last = file.text.slice(start, node.to - 1).trim();
  if (last) result.push(last);
  return result;
}
function link(unit: Unit, node = unit.nameNode): SourceLink {
  return { file: unit.file.path, start: node.from, end: node.to, label: unit.name, scope: unit.scope, line: unit.file.text.slice(0, node.from).split('\n').length };
}
function docs(unit: Unit): string | undefined {
  if (unit.file.language === 'Java' && unit.node.prevSibling?.name === 'BlockComment') {
    const comment = getText(unit.file, unit.node.prevSibling);
    if (comment.startsWith('/**')) return compact(comment.replace(/^\/\*\*|\*\/$/g, '').replace(/^\s*\* ?/gm, '').split(/\n\s*@/)[0]);
  }
  if (unit.file.language === 'Python') {
    const first = children(unit.body).find(n => n.name !== ':');
    if (first?.name === 'ExpressionStatement' && first.firstChild?.name === 'String') return compact(getText(unit.file, first.firstChild).replace(/^[ru]*["']{1,3}|["']{1,3}$/gi, ''));
  }
}
function collect(input: IndexedFile): File {
  const language = languageFor(input.file);
  const parser = ({Java:java, Python:python, HTML:html, CSS:css} as Record<string, typeof java>)[language];
  const tree = parser ? parser.parse(input.text) : new Tree(java.nodeSet.types[0], [], [], input.text.length);
  const file: File = { path: input.file, text: input.text, language, tree, units: [], imports: [], calls: [], package: '', errors: false };
  const root: Unit = {file,node:tree.topNode,nameNode:tree.topNode,name:path.basename(input.file),kind:'file',scope:'file',parameters:[]};
  file.units.push(root);
  if (!parser) return file;
  tree.iterate({enter: ref => {
    const n = ref.node;
    if (n.type.isError) file.errors = true;
    if (n.name === 'PackageDeclaration') file.package = getText(file,n).replace(/^package\s+|;$/g,'').trim();
    let nameNode: SyntaxNode | null = null, kind = '', scope: Scope = 'expression', body: SyntaxNode | null = null;
    if (/^(?:Class|Interface|Enum|Record)Declaration$/.test(n.name) || n.name === 'ClassDefinition') {
      nameNode = n.getChild(language === 'Java' ? 'Definition' : 'VariableName'); kind='class'; scope='class'; body=n.getChild('ClassBody') ?? n.getChild('Body');
    } else if (['MethodDeclaration','ConstructorDeclaration','FunctionDefinition'].includes(n.name)) {
      nameNode = n.getChild(language === 'Java' ? 'Definition' : 'VariableName'); kind='function'; scope='function'; body=n.getChild('Block') ?? n.getChild('ConstructorBody') ?? n.getChild('Body');
    } else if (['VariableDeclarator','FormalParameter','SpreadParameter'].includes(n.name)) { nameNode=n.getChild('Definition'); kind='variable'; }
    else if (language === 'Python' && n.name === 'VariableName' && n.parent?.name === 'ParamList') { nameNode=n; kind='variable'; }
    else if (n.name === 'AssignStatement' && n.firstChild?.name === 'VariableName') { nameNode=n.firstChild; kind='variable'; }
    else if (n.name === 'Element') { nameNode=(n.getChild('OpenTag') ?? n.getChild('SelfClosingTag'))?.getChild('TagName') ?? null; kind='element'; body=n; }
    else if (n.name === 'RuleSet') { nameNode=n.firstChild; kind='style rule'; body=n.getChild('Block'); }
    else if (language === 'CSS' && n.name === 'Declaration') { nameNode=n.firstChild; kind='CSS property'; }
    if (nameNode) {
      const unit: Unit = {file,node:n,nameNode,name:getText(file,nameNode),kind,scope,body:body ?? undefined,parameters:[]};
      if (kind === 'element') unit.name=unit.name.toLowerCase();
      if (kind === 'style rule') unit.name=compact(file.text.slice(n.from,body?.from ?? n.to));
      if (kind === 'function') {
        const params=n.getChild('FormalParameters') ?? n.getChild('ParamList');
        unit.parameters=parts(file,params).filter(p=>p!=='/' && p!=='*').map(p=>{
          const [declaration,...rest]=p.split('=');
          const name=language==='Java' ? declaration.trim().match(/([\w$]+)\s*(?:\[\])?$/)?.[1] : declaration.trim().match(/^\*{0,2}(\w+)/)?.[1];
          return {name:name ?? declaration.trim(),declaration:p,fallback:rest.length?rest.join('=').trim():undefined};
        });
      }
      file.units.push(unit);
    }
    if (language === 'Java' && n.name === 'ImportDeclaration') {
      const value=getText(file,n).replace(/^import\s+|;$/g,'').trim();
      const isStatic=value.startsWith('static '), module=value.replace(/^static\s+/,'');
      file.imports.push({node:n,module:isStatic?module.slice(0,module.lastIndexOf('.')):module,member:isStatic?module.split('.').at(-1):undefined});
    }
    if (language === 'Python' && n.name === 'ImportStatement') {
      const value=getText(file,n).replace(/\\\r?\n/g,' ');
      const from=value.match(/^from\s+([.\w]+)\s+import\s+([\s\S]+)$/);
      const values=(from?.[2] ?? value.replace(/^import\s+/,'')).replace(/[()]/g,'').split(',');
      for (const item of values) { const match=item.trim().match(/^([.\w]+)(?:\s+as\s+(\w+))?$/); if(match)file.imports.push({node:n,module:from?.[1]??match[1],member:from?match[1]:undefined,alias:match[2]??match[1]}); }
    }
    if (language === 'CSS' && n.name === 'ImportStatement') {
      const match=getText(file,n).match(/@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s);]+))/); const value=match?.[1]??match?.[2]??match?.[3]; if(value)file.imports.push({node:n,module:value});
    }
  }});
  for (const unit of file.units.slice(1)) unit.owner=file.units.filter(other=>other!==unit && inside(other.node,unit.node) && ['file','function','class','element','style rule'].includes(other.kind)).sort((a,b)=>(a.node.to-a.node.from)-(b.node.to-b.node.from)||Number(a.kind==='file')-Number(b.kind==='file'))[0] ?? root;
  if (language==='HTML') for(const unit of file.units.filter(u=>u.kind==='element')) {
    const attrs=attributes(unit);
    const url=unit.name==='link' && attrs.rel?.split(/\s+/).includes('stylesheet') ? attrs.href : unit.name==='script'?attrs.src:undefined;
    if(url)file.imports.push({node:unit.node,module:url});
  }
  tree.iterate({enter:ref=>{
    const n=ref.node;
    if (!(language==='Java' && ['MethodInvocation','ObjectCreationExpression'].includes(n.name)) && !(language==='Python' && n.name==='CallExpression')) return;
    const args=n.getChild('ArgumentList') ?? n.getChild('ArgList');
    if (!args) return;
    const unit=file.units.filter(u=>u.scope==='function' && inside(u.node,n)).sort((a,b)=>(a.node.to-a.node.from)-(b.node.to-b.node.from))[0] ?? root;
    file.calls.push({unit,node:n,expression:file.text.slice(n.from,args.from).trim().replace(/^new\s+/,''),arguments:parts(file,args)});
  }});
  return file;
}
function attributes(unit: Unit): Record<string,string> {
  const tag=unit.node.getChild('OpenTag') ?? unit.node.getChild('SelfClosingTag');
  return Object.fromEntries(children(tag).filter(n=>n.name==='Attribute').map(n=>[textChild(unit.file,n,'AttributeName').toLowerCase(),textChild(unit.file,n,'AttributeValue').replace(/^["']|["']$/g,'')]));
}

/** Grammar-backed source navigation. Calls are hypotheses, never a substitute for a compiler/runtime. */
export class SyntaxAnalyzer {
  private files=new Map<string,File>();
  private context=new Map<string,string>();
  private edges: Edge[]=[];
  private dirty=true;
  private cache=new Map<string,Explanation>();
  constructor(private input:ProjectInput) { for(const f of input.files) this.update(f.file,f.text); }
  update(file:string,text:string|null):void {
    file=path.resolve(this.input.root,file);
    if(text===null) { this.files.delete(file); this.context.delete(file); }
    else if(sourcePattern.test(file) && this.files.get(file)?.text!==text) this.files.set(file,collect({file,text}));
    else if(!sourcePattern.test(file) && text!==null)this.context.set(file,text);
    this.dirty=true; this.cache.clear();
  }
  private unique<T>(items:T[]):T|undefined { return items.length===1?items[0]:undefined; }
  private module(file:File,specifier:string):File|undefined {
    if(file.language==='Python') {
      const dots=specifier.match(/^\.+/)?.[0].length ?? 0;
      const name=specifier.slice(dots).replaceAll('.',path.sep);
      const relative=dots?path.resolve(path.dirname(file.path),...Array(dots-1).fill('..'),name):undefined;
      return this.unique([...this.files.values()].filter(f=>f.language==='Python' && (relative ? [relative+'.py',path.join(relative,'__init__.py')].includes(f.path) : [path.sep+name+'.py',path.sep+path.join(name,'__init__.py')].some(s=>f.path.endsWith(s)))));
    }
    if(file.language==='Java') return this.unique([...this.files.values()].filter(f=>f.language==='Java' && f.units.some(u=>u.kind==='class' && `${f.package?f.package+'.':''}${u.name}`===specifier)));
    if (/^(?:[a-z]+:|\/\/|#)/i.test(specifier)) return;
    let decoded:string; try { decoded=decodeURIComponent(specifier.split(/[?#]/)[0]); } catch { return; }
    const target=path.resolve(decoded.startsWith('/')?this.input.root:path.dirname(file.path),decoded.replace(/^\//,''));
    return this.files.get(target);
  }
  private classFor(file:File,name:string):Unit|undefined {
    const qualified=(u:Unit):string=>{const names=[u.name];for(let owner=u.owner;owner;owner=owner.owner)if(owner.kind==='class')names.unshift(owner.name);return [u.file.package,...names].filter(Boolean).join('.');};
    const first=name.split('.')[0], rest=name.slice(first.length);
    const imports=file.imports.filter(i=>!i.member && (i.module.endsWith('.'+first)||i.module.endsWith('.*'))).map(i=>i.module.endsWith('.*')?i.module.slice(0,-1)+name:i.module+rest);
    const names=[name,[file.package,name].filter(Boolean).join('.'),...imports];
    return this.unique([...this.files.values()].flatMap(f=>f.units.filter(u=>u.kind==='class' && (names.includes(qualified(u)) || f===file&&u.name===name))));
  }
  private declaredType(unit:Unit):string|undefined {
    return getText(unit.file,children(unit.node.parent).find(n=>/Type/.test(n.name))).replace(/<.*>|\[\]/g,'').trim()||undefined;
  }
  private target(call:Call):Unit|undefined {
    const file=call.unit.file, parts=call.expression.split('.'), name=parts.pop()!, receiver=parts.join('.');
    if (!/^[\w$.]+$/.test(call.expression)) return;
    const owner=call.unit.owner;
    let candidates:Unit[]=[];
    if(file.language==='Java') {
      if(call.node.name==='ObjectCreationExpression') { const klass=this.classFor(file,call.expression); if(!klass)return; return this.unique(klass.file.units.filter(u=>u.owner===klass&&u.name===klass.name&&u.parameters.length===call.arguments.length)) ?? klass; }
      let klass:Unit|undefined;
      if(!receiver||receiver==='this') klass=owner?.kind==='class'?owner:undefined;
      else {
        klass=this.classFor(file,receiver);
        if(!klass) {
          const names=receiver.split('.'), first=names.shift()!;
          if(first==='this')klass=owner?.kind==='class'?owner:undefined;
          else {
            const parameter=call.unit.parameters.find(p=>p.name===first);
            const variables=file.units.filter(u=>u.kind==='variable'&&u.name===first&&(u.owner===call.unit||u.owner===owner));
            const variable=this.unique(variables.filter(u=>u.owner===call.unit)) ?? this.unique(variables);
            const type=parameter?.declaration.replace(/^(?:final\s+)?/,'').match(/^([\w.]+)/)?.[1] ?? (variable?this.declaredType(variable):undefined);
            if(type)klass=this.classFor(file,type);
          }
          for(const name of names) {
            const field=klass?this.unique(klass.file.units.filter(u=>u.owner===klass&&u.kind==='variable'&&u.name===name)):undefined;
            const type=field?this.declaredType(field):undefined;
            klass=type&&klass?this.classFor(klass.file,type):undefined;
          }
        }
      }
      if(klass)candidates=klass.file.units.filter(u=>u.owner===klass && u.scope==='function' && u.name===name && (u.parameters.length===call.arguments.length || u.parameters.some(p=>p.declaration.includes('...'))));
      if(!receiver && !candidates.length) for(const i of file.imports.filter(i=>i.member===name && i.target)) candidates.push(...i.target!.units.filter(u=>u.scope==='function' && u.name===name));
    } else {
      // Python can rebind any name; choose only lexical/import candidates and label every call inferred.
      if(!receiver) {
        if(file.units.some(u=>u.kind==='variable' && u.name===name && (u.owner===call.unit || u.owner?.kind==='file')) || call.unit.parameters.some(p=>p.name===name)) return;
        candidates=file.units.filter(u=>u.name===name && (u.scope==='function'||u.kind==='class') && (u.owner?.kind==='file'||u.owner===call.unit));
        if(!candidates.length) for(const i of file.imports.filter(i=>i.alias===name && i.member && i.target)) candidates.push(...i.target!.units.filter(u=>u.owner?.kind==='file' && u.name===i.member));
      } else if(receiver==='self'||receiver==='cls') {
        candidates=file.units.filter(u=>u.owner===owner && owner?.kind==='class' && u.name===name && u.scope==='function');
      } else for(const i of file.imports.filter(i=>!i.member && i.alias===receiver && i.target)) candidates.push(...i.target!.units.filter(u=>u.owner?.kind==='file' && u.name===name));
    }
    return this.unique(candidates);
  }
  private prepare():void {
    if(!this.dirty)return;
    this.edges=[];
    const add=(from:Unit,to:Unit|undefined,kind:Edge['kind'],certainty:Edge['certainty'],node:SyntaxNode,detail:string)=>this.edges.push({from,to,kind,certainty,evidence:link(from,node),detail});
    for(const f of this.files.values())for(const i of f.imports)i.target=this.module(f,i.module);
    for(const file of this.files.values()) {
      for(const i of file.imports) {
        const inferred=file.language==='Python'&&!i.module.startsWith('.');
        add(file.units[0],i.target?.units[0],'import',i.target&&!inferred?'verified':'inferred',i.node,`Source imports ${i.module}${i.member?'.'+i.member:''}. ${i.target?inferred?'A unique local candidate is linked; Python search paths may select a different module.':'The local indexed file is linked.':'External, ambiguous, or unavailable in this index.'}`);
      }
      for(const call of file.calls) {
        call.target=this.target(call);
        add(call.unit,call.target,'callee','inferred',call.node,`${call.unit.name} contains ${compact(getText(file,call.node))}. ${call.target?'This is a candidate from lexical scope, imports, or declared receiver type; dispatch, overloads and rebinding are not compiler-verified.':'The target cannot be determined from the indexed source.'}`);
      }
      if(file.language==='Java'||file.language==='Python') {
        const variables=new Map<string,Unit[]>();
        for(const u of file.units.filter(u=>u.kind==='variable'))variables.set(u.name,[...variables.get(u.name)??[],u]);
        file.tree.iterate({enter:ref=>{
          const n=ref.node;
          if(!['Identifier','VariableName'].includes(n.name) || !variables.has(getText(file,n)))return;
          if(file.units.some(u=>u.nameNode.from===n.from&&u.nameNode.to===n.to))return;
          if(['MethodName','PropertyName','ImportStatement','ImportDeclaration','PackageDeclaration'].includes(n.parent?.name??''))return;
          const owner=file.units.filter(u=>u.scope==='function'&&inside(u.node,n)).sort((a,b)=>(a.node.to-a.node.from)-(b.node.to-b.node.from))[0];
          if(!owner)return;
          const matches=variables.get(getText(file,n))!;
          const local=matches.filter(u=>u.owner===owner);
          const variable=this.unique(local.length?local:matches.filter(u=>u.owner===owner.owner));
          if(variable && (n.parent?.name!=='FieldAccess'||/^this\./.test(getText(file,n.parent)))) add(variable,owner,'consumer','inferred',n,`${owner.name} reads or writes ${variable.name} at this location. This lexical candidate does not establish runtime values or aliasing.`);
        }});
      }
      if(file.language==='HTML') for(const element of file.units.filter(u=>u.kind==='element')) {
        const attrs=attributes(element);
        const styles=new Set<File>();
        const expand=(f:File)=>{if(styles.has(f)||f.language!=='CSS')return;styles.add(f);for(const i of f.imports)if(i.target)expand(i.target);};
        for(const i of file.imports)if(i.target)expand(i.target);
        for(const style of styles)for(const rule of style.units.filter(u=>u.kind==='style rule')) {
          const matches=rule.name.split(',').map(s=>s.trim()).some(s=>/^\.[\w-]+$/.test(s)?attrs.class?.split(/\s+/).includes(s.slice(1)):/^#[\w-]+$/.test(s)?attrs.id===s.slice(1):/^[a-z][\w-]*$/i.test(s)?element.name.toLowerCase()===s.toLowerCase():false);
          if(matches)add(rule,element,'consumer','inferred',rule.node,`${rule.name} matches a literal tag, class or id in a document that links this stylesheet. Cascade, conditions and DOM changes decide the actual appearance.`);
        }
        const resource=file.imports.find(i=>i.node.from===element.node.from);
        if(resource)add(element,resource.target?.units[0],'import',resource.target?'verified':'inferred',element.node,`This ${element.name} element loads ${resource.module}; remote URLs and excluded files are not read.`);
      }
    }
    this.dirty=false;
  }
  explain(query:AnalysisQuery):Explanation|null {
    const started=performance.now(), file=this.files.get(path.resolve(this.input.root,query.file));
    if(!file)return null;
    const key=JSON.stringify(query), cached=this.cache.get(key);
    if(cached)return {...cached,stats:{...cached.stats,cached:true,elapsedMs:performance.now()-started}};
    this.prepare();
    const available=file.units.filter(u=>u.node.from<=query.offset && u.node.to>=query.offset).sort((a,b)=>(a.node.to-a.node.from)-(b.node.to-b.node.from)||Number(a.kind==='file')-Number(b.kind==='file'));
    let unit=query.scope==='file'?file.units[0]:available.find(u=>query.scope==='function'?u.scope==='function':query.scope==='class'?u.kind==='class':true) ?? file.units[0];
    const word=file.tree.resolveInner(query.offset,1);
    if(!query.scope && ['Identifier','VariableName','PropertyName','MethodName'].includes(word.name)) {
      const call=file.calls.find(c=>inside(c.node,word) && query.offset < (c.node.getChild('ArgumentList')??c.node.getChild('ArgList'))!.from);
      if(call?.target)unit=call.target;
      else { const variables=file.units.filter(u=>u.kind==='variable' && u.name===getText(file,word) && (u.owner===unit||u.owner===unit.owner)); unit=this.unique(variables) ?? unit; }
    }
    const grouped=query.scope==='project'||query.scope==='module';
    if((query.scope==='class'||query.scope==='function')&&unit.scope!==query.scope)return null;
    const scope=grouped?query.scope!:query.scope??unit.scope;
    const selected=grouped?[...this.files.values()].filter(f=>scope==='project'||path.dirname(f.path)===path.dirname(file.path)).map(f=>f.units[0]):[unit];
    const contains=(u:Unit)=>selected.some(s=>s.file===u.file && (s===u || (['file','class'].includes(s.kind)&&inside(s.node,u.node))));
    const outgoing=this.edges.filter(e=>contains(e.from)),incoming=this.edges.filter(e=>e.to&&contains(e.to)&&!contains(e.from));
    const relation=(e:Edge,reverse:boolean):Relationship=>({kind:reverse?(e.kind==='callee'?'caller':e.kind==='consumer'?'data source':e.kind):e.kind,certainty:e.certainty,detail:e.detail,target:reverse?link(e.from):e.to?link(e.to):undefined,evidence:e.evidence});
    const upstream=incoming.slice(0,LIMIT).map(e=>relation(e,true)),downstream=outgoing.slice(0,LIMIT).map(e=>relation(e,false));
    const name=grouped?(scope==='project'?path.basename(this.input.root):path.basename(path.dirname(file.path))):unit.name;
    const purpose=docs(unit), steps=grouped?[]:this.steps(unit);
    const kind=grouped?scope:unit.kind;
    const summary=purpose?`Documented purpose: ${purpose}`:this.summary(unit);
    const childrenLinks=grouped?selected.slice(0,LIMIT).map(u=>({...link(u),label:path.relative(this.input.root,u.file.path)})):unit.file.units.filter(u=>u.owner===unit).slice(0,LIMIT).map(u=>link(u));
    const notes=[...this.input.notes??[],`${unit.file.language} uses local syntax trees. Calls are inferred candidates, not compiler-verified dispatch. Dynamic loading, inheritance, overload selection and runtime values are not determined.`, 'No project code is executed and no source is sent to external AI.'];
    if([...this.files.values()].some(f=>f.errors))notes.push('Some files contain incomplete or unsupported syntax. Relationships may be missing while editing.');
    if(unit.file.language==='HTML'||unit.file.language==='CSS')notes.push('Only local linked resources and simple tag, .class and #id selectors are connected. Embedded scripts/styles, templates, complex selectors, cascade and computed layout are not analyzed.');
    if(upstream.length<incoming.length||downstream.length<outgoing.length||childrenLinks.length>=LIMIT)notes.push(`Lists are limited to ${LIMIT} paths; remaining paths may be omitted.`);
    const exampleCalls=[...this.files.values()].flatMap(f=>f.calls).filter(c=>c.target===unit).slice(0,3);
    const result:Explanation={id:`${unit.file.path}:${unit.node.from}:${scope}`,name,kind,scope,source:link(unit),sourceCode:grouped?'':short(getText(unit.file,unit.node),3000),summary:grouped?`${selected.length} indexed source files. Choose a file to move from the project map into concrete code.`:summary,
      role:grouped?`Local source map for ${name}. Imports and linked web resources connect files; source exclusions and index limits still apply.`:`Defined in ${path.relative(this.input.root,unit.file.path)}${unit.owner&&unit.owner.kind!=='file'?` inside ${unit.owner.name}`:''}. ${incoming.filter(e=>e.kind==='callee').length} candidate caller(s); ${outgoing.filter(e=>e.kind==='callee').length} written call(s). Follow source links to inspect each connection.`,
      signature:grouped?undefined:compact(unit.file.text.slice(unit.node.from,unit.body?.from??unit.node.to),500),
      inputs:unit.parameters.map(p=>p.declaration),outputs:[],effects:[],steps,examples:exampleCalls.map(c=>({source:link(c.unit,c.node),code:short(getText(c.unit.file,c.node),500),bindings:this.bindings(unit,c),note:'Written arguments at a candidate call site, not evaluated values. Keywords, unpacking and overloads may change binding.'})),
      upstream,downstream,children:childrenLinks,evidence:[],notes,stats:{files:this.files.size,elapsedMs:performance.now()-started,cached:false}};
    if(unit.scope==='function') {
      const type=unit.file.language==='Python'?textChild(unit.file,unit.node,'TypeDef'):getText(unit.file,children(unit.node).find(n=>/Type/.test(n.name)||n.name==='void'));
      if(type)result.outputs.push(`Declared return type: ${type.replace(/^->\s*/,'')}.`);
      for(const step of steps)if(step.kind==='return')result.outputs.push(`Returns the expression written here: ${compact(step.code.replace(/^return\s+|;$/g,''))}.`);
      if(!result.outputs.length)result.outputs.push('No explicit return found in the direct source steps; nested paths or constructors may behave differently.');
    }
    result.effects=steps.filter(s=>s.kind==='effect').map(s=>s.detail);
    const context=[...this.context.entries()].filter(([name])=>path.dirname(name)===path.dirname(unit.file.path)||path.dirname(name)===path.resolve(this.input.root)).slice(0,5).map(([file,text])=>({file,start:0,end:Math.min(text.length,400),label:path.basename(file),line:1}));
    result.evidence=[link(unit),...context,...upstream.map(e=>e.evidence),...downstream.map(e=>e.evidence)].filter((v,i,a)=>a.findIndex(x=>x.file===v.file&&x.start===v.start)===i).slice(0,LIMIT);
    this.cache.set(key,result);if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
  private bindings(unit:Unit,call:Call):{parameter:string;argument:string}[] {
    const parameters=unit.parameters.filter((p,i)=>!(unit.file.language==='Python' && i===0 && unit.owner?.kind==='class' && ['self','cls'].includes(p.name)));
    const unpacking=unit.file.language==='Python' && call.arguments.some(a=>a.startsWith('*'));
    const positional=unit.file.language==='Python'?call.arguments.filter(a=>!/^\w+\s*=(?!=)/.test(a)):call.arguments;
    return parameters.slice(0,12).map((p,i)=>{
      const keyword=unit.file.language==='Python'?call.arguments.find(a=>a.match(/^(\w+)\s*=(?!=)/)?.[1]===p.name):undefined;
      const argument=keyword?keyword.slice(keyword.indexOf('=')+1).trim():unpacking?'Cannot bind statically: call uses unpacking':p.declaration.startsWith('*')||p.declaration.includes('...')?'Variadic arguments; inspect the call':positional[i]??p.fallback??'Not supplied';
      return {parameter:p.name,argument};
    });
  }
  private summary(u:Unit):string {
    if(u.kind==='element') {
      const attrs=attributes(u), roles:Record<string,string>={button:'Offers a clickable control.',a:'Creates a link to another location.',form:'Groups controls for submitting values.',input:'Accepts a value from the user.',img:'Displays an image.',script:'Loads or contains browser code.',link:'Connects this document to an external resource.',div:'Groups page content.',section:'Groups a section of content.'};
      return `<${u.name}>: ${roles[u.name]??'Defines part of the document structure.'}${attrs.id?` Its id is ${attrs.id}.`:''}${attrs.class?` CSS classes: ${attrs.class}.`:''}`;
    }
    if(u.kind==='style rule')return `Selects ${u.name} and declares how matching elements should look. The cascade decides which declarations win.`;
    if(u.kind==='CSS property')return `${u.name} declares a style value: ${compact(getText(u.file,u.node))}. Its effect depends on the matching element and cascade.`;
    if(u.kind==='class')return `${u.name} groups related state and operations. Explore its fields and methods below.`;
    if(u.kind==='function')return `${u.name} receives ${u.parameters.length} declared parameter(s) and performs the source steps below. Business purpose is not documented here.`;
    if(u.kind==='variable')return `${u.name} names a value used by the surrounding code. Its declaration is shown below.`;
    return `${u.name} contains ${u.file.language} source. Explore its declarations and file connections below.`;
  }
  private steps(u:Unit):TeachingStep[] {
    const statements=u.kind==='file'?children(u.node):u.kind==='element'?children(u.node).filter(n=>['OpenTag','SelfClosingTag','Text','Element'].includes(n.name)):u.body?children(u.body):[u.node];
    return statements.filter(n=>!['{','}',':',';'].includes(n.name)).slice(0,8).map(n=>{
      const code=getText(u.file,n);let title='Read this statement',detail='This is the source written at this location.',kind:TeachingStep['kind']='compute';
      if(n.name==='ReturnStatement'){title='Give back a result';detail=`Return ${compact(code.replace(/^return\s*|;$/g,''))||'without a value'} to the caller.`;kind='return';}
      else if(/^(If|Switch|Match|Try)/.test(n.name)){title='Choose a path';detail='Conditions or exceptions decide which block runs. These branches are not executed by Code Teach.';kind='branch';}
      else if(/^(For|EnhancedFor|While|DoStatement)/.test(n.name)){title='Repeat a block';detail='Run this block for the written loop condition or iterable. The iteration count is not known statically.';kind='loop';}
      else if(/^(AssignStatement|ExpressionStatement)$/.test(n.name) && /^(?:self|this)\.[\w.]+\s*=(?!=)/.test(code.trim())){title='Change object state';detail=`Write to the object state shown in ${compact(code)}.`;kind='effect';}
      else if(/^(AssignStatement|LocalVariableDeclaration|VariableDeclarator|FieldDeclaration|FormalParameter)/.test(n.name)){title='Store or receive a value';detail=`${compact(code)} gives a value a name for later use.`;kind='declaration';}
      else if(n.name==='Declaration'){title='Set a style value';detail=`Declare ${compact(code)} for matching elements. Other rules can override this value.`;kind='effect';}
      else if(['FunctionDefinition','MethodDeclaration','ClassDefinition','ClassDeclaration','ConstructorDeclaration'].includes(n.name)){title='Define reusable code';detail='This declares code for later use; declaring it does not mean its body runs now.';kind='declaration';}
      else if(['OpenTag','SelfClosingTag','Element'].includes(n.name)){title='Build document structure';detail='This tag and its attributes describe an element in the page. Linked resources and styles can affect it.';kind='declaration';}
      if(title==='Read this statement' && /ExpressionStatement/.test(n.name) && children(n).some(c=>['CallExpression','MethodInvocation'].includes(c.name))) { title='Call another operation'; detail='Pass the written arguments to this operation. Follow Downstream to inspect the candidate implementation and its effects.'; }
      return {title,detail,kind,code:short(code,700),source:link(u,n)};
    });
  }
}

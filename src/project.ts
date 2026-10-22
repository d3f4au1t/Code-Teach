import * as path from 'node:path';
import { Analyzer } from './analyzer';
import { SyntaxAnalyzer } from './syntax';
import { AnalysisQuery, Explanation, ProjectInput } from './model';
const isTS=(file:string)=>/\.[cm]?[jt]sx?$/i.test(file);

/** Keep TypeScript's semantic analysis and share the same worker/panel for every language. */
export class ProjectAnalyzer {
  private typescript: Analyzer;
  private syntax: SyntaxAnalyzer;
  private sourceFiles:Set<string>;
  constructor(private input:ProjectInput) {
    this.typescript=new Analyzer(input); this.syntax=new SyntaxAnalyzer(input);
    this.sourceFiles=new Set(input.files.filter(f=>isTS(f.file)).map(f=>path.resolve(input.root,f.file)));
  }
  update(file:string,text:string|null):void {
    this.typescript.update(file,text); this.syntax.update(file,text);
    if(isTS(file)){if(text===null)this.sourceFiles.delete(path.resolve(this.input.root,file));else this.sourceFiles.add(path.resolve(this.input.root,file));}
  }
  explain(query:AnalysisQuery):Explanation|null {
    if(query.scope==='project') {
      const result=this.syntax.explain(query), first=this.sourceFiles.values().next().value;
      if(result&&first) {
        const ts=this.typescript.explain({file:first,offset:0,scope:'project'});
        if(ts)return {...result,downstream:[...ts.downstream,...result.downstream].slice(0,60),evidence:[...result.evidence,...ts.evidence].slice(0,60),notes:[...new Set([...result.notes,...ts.notes,...(ts.downstream.length+result.downstream.length>60?['Project connections are limited to 60 paths; remaining paths are omitted.']:[])])]};
      }
      return result;
    }
    if(!isTS(query.file))return this.syntax.explain(query);
    const result=this.typescript.explain(query);
    if(result?.scope==='file') {
      const web=this.syntax.explain({...query,scope:'file'});
      if(web)return {...result,upstream:[...result.upstream,...web.upstream].slice(0,60),evidence:[...result.evidence,...web.upstream.map(r=>r.evidence)].slice(0,60),notes:[...result.notes,...(result.upstream.length+web.upstream.length>60?['Upstream connections are limited to 60 paths; remaining paths are omitted.']:[])]};
    }
    return result;
  }
}

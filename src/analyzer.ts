import * as path from 'node:path';
import * as ts from 'typescript';
import { teachingSteps, callExamples, arrayMethodHint } from './teaching';
import { AnalysisQuery, Explanation, ProjectInput, Relationship, Scope, SourceLink } from './model';

const SOURCE = /\.[cm]?[jt]sx?$/i;
const LIMIT = 60;
const compact = (text: string, limit = 180): string => text.replace(/\s+/g, ' ').trim().slice(0, limit);
const walk = (node: ts.Node, visit: (child: ts.Node) => void): void => {
  visit(node);
  node.forEachChild(child => walk(child, visit));
};
const callable = (node: ts.Node): node is ts.SignatureDeclaration & { body?: ts.ConciseBody } =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
const nameOf = (node: ts.Node): ts.Node | undefined => (node as ts.NamedDeclaration).name;
const functionOf = (node: ts.Node): (ts.SignatureDeclaration & { body?: ts.ConciseBody }) | undefined =>
  callable(node) ? node : (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer && callable(node.initializer) ? node.initializer : undefined;
const namedFunction = (node: ts.Node): ts.Node =>
  (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && (ts.isVariableDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) ? node.parent : node;
const enclosing = (node: ts.Node | undefined, predicate: (node: ts.Node) => boolean): ts.Node | undefined => {
  for (let current = node; current; current = current.parent) if (predicate(current)) return current;
  return undefined;
};

interface FileState { text: string; source?: ts.SourceFile; facts?: Facts; }
interface ImportSite { node: ts.Node; specifier: string; typeOnly: boolean; }
interface Facts { identifiers: ts.Identifier[]; calls: (ts.CallExpression | ts.NewExpression)[]; imports: ImportSite[]; }
interface CallSite { call: ts.CallExpression | ts.NewExpression; caller: ts.Node; symbol?: ts.Symbol; }
interface ResolvedImport extends ImportSite { file: string; resolved?: string; }

/** A local, in-memory semantic model. Source files are never opened or executed here. */
export class Analyzer {
  private readonly root: string;
  private readonly files = new Map<string, FileState>();
  private readonly options: ts.CompilerOptions;
  private readonly projectNotes: string[];
  private readonly cache = new Map<string, Explanation>();
  private readonly packages = new Map<string, { directory: string; json: Record<string, unknown> }>();
  private program?: ts.Program;
  private checker!: ts.TypeChecker;
  private dirty = true;
  private references = new Map<ts.Symbol, ts.Identifier[]>();
  private callsByFile = new Map<string, CallSite[]>();
  private callers = new Map<ts.Symbol, CallSite[]>();
  private imports: ResolvedImport[] = [];
  private host!: ts.CompilerHost;

  constructor(input: ProjectInput) {
    this.root = path.resolve(input.root);
    this.projectNotes = [...(input.notes ?? [])];
    const suppliedOptions = input.compilerOptions ?? {};
    const alreadyParsed = 'configFilePath' in suppliedOptions || 'pathsBasePath' in suppliedOptions ||
      ['target', 'module', 'moduleResolution', 'jsx', 'newLine'].some(key => typeof suppliedOptions[key] === 'number');
    const converted = alreadyParsed ? { options: suppliedOptions as ts.CompilerOptions, errors: [] } :
      ts.convertCompilerOptionsFromJson(suppliedOptions, this.root);
    this.options = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10, allowJs: true, checkJs: true,
      ...converted.options, noLib: true, noEmit: true, types: [],
    };
    if (converted.errors.length) this.projectNotes.push('Some compiler options were invalid; type resolution may be incomplete.');
    for (const file of input.files) this.files.set(this.absolute(file.file), { text: file.text });
  }

  update(file: string, text: string | null): void {
    const key = this.absolute(file);
    if (text === null ? !this.files.has(key) : this.files.get(key)?.text === text) return;
    if (text === null) this.files.delete(key); else this.files.set(key, { text });
    this.dirty = true;
    this.cache.clear();
  }

  explain(query: AnalysisQuery): Explanation | null {
    const started = performance.now();
    const file = this.absolute(query.file);
    const key = `${file}:${query.offset}:${query.scope ?? 'symbol'}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { ...cached, stats: { ...cached.stats, cached: true, elapsedMs: performance.now() - started } };
    }
    this.prepare();
    const source = this.program?.getSourceFile(file);
    if (!source) return null;
    let result: Explanation;
    if (query.scope === 'project' || query.scope === 'module') {
      result = this.explainGroup(source, query.scope);
    } else {
      const focus = this.focus(source, query.offset, query.scope);
      if (!focus) return null;
      result = this.explainNode(focus, query.scope ?? this.scopeOf(focus));
    }
    result.stats.elapsedMs = performance.now() - started;
    this.cache.set(key, result);
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  private absolute(file: string): string { return path.resolve(this.root, file); }
  private relative(file: string): string { return path.relative(this.root, file).replaceAll(path.sep, '/'); }
  private source(file: string): ts.SourceFile | undefined {
    const state = this.files.get(this.absolute(file));
    if (!state || !SOURCE.test(file)) return undefined;
    return state.source ??= ts.createSourceFile(file, state.text, this.options.target ?? ts.ScriptTarget.ES2022, true);
  }

  private facts(source: ts.SourceFile): Facts {
    const state = this.files.get(source.fileName)!;
    if (state.facts) return state.facts;
    const facts: Facts = { identifiers: [], calls: [], imports: [] };
    walk(source, node => {
      if (ts.isIdentifier(node)) facts.identifiers.push(node);
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        facts.calls.push(node);
        if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
          facts.imports.push({ node, specifier: node.arguments[0].text, typeOnly: false });
        }
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        facts.imports.push({ node, specifier: node.moduleSpecifier.text, typeOnly: ts.isExportDeclaration(node) ? node.isTypeOnly : node.importClause?.isTypeOnly ?? false });
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
        facts.imports.push({ node, specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly });
      }
    });
    return state.facts = facts;
  }

  private prepare(): void {
    if (!this.dirty) return;
    this.packages.clear();
    for (const [file, state] of this.files) {
      if (path.basename(file) !== 'package.json') continue;
      try {
        const json = JSON.parse(state.text) as Record<string, unknown>;
        if (typeof json.name === 'string') this.packages.set(json.name, { directory: path.dirname(file), json });
      } catch { /* Invalid metadata does not prevent source analysis. */ }
    }
    const directories = new Set<string>();
    for (const file of this.files.keys()) {
      for (let dir = path.dirname(file); !directories.has(dir); dir = path.dirname(dir)) {
        directories.add(dir);
        if (path.dirname(dir) === dir) break;
      }
    }
    this.host = {
      getSourceFile: file => this.source(file), getDefaultLibFileName: () => '__code_teach_no_lib__.d.ts',
      writeFile: () => {}, getCurrentDirectory: () => this.root, getDirectories: dir =>
        [...directories].filter(child => child !== dir && path.dirname(child) === dir),
      getCanonicalFileName: file => this.absolute(file), useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
      fileExists: file => this.files.has(this.absolute(file)), readFile: file => this.files.get(this.absolute(file))?.text,
      directoryExists: dir => directories.has(this.absolute(dir)), realpath: file => this.absolute(file),
      resolveModuleNames: (names, containingFile) => names.map(name => this.resolveModule(name, containingFile)),
    };
    const rootNames = [...this.files.keys()].filter(file => SOURCE.test(file));
    this.program = ts.createProgram({ rootNames, options: this.options, host: this.host, oldProgram: this.program });
    this.checker = this.program.getTypeChecker();
    this.references = new Map();
    this.callsByFile = new Map();
    this.callers = new Map();
    this.imports = [];
    // shortcut: rebuild semantic links after edits; add dependency-scoped invalidation when measured edit latency warrants it.
    for (const source of this.program.getSourceFiles()) {
      const facts = this.facts(source);
      for (const node of facts.identifiers) {
        const symbol = this.symbol(node);
        if (symbol) {
          const entries = this.references.get(symbol) ?? [];
          entries.push(node);
          this.references.set(symbol, entries);
        }
      }
      for (const call of facts.calls) {
        const symbol = this.symbol(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression);
        const caller = namedFunction(enclosing(call.parent, callable) ?? source);
        const site: CallSite = { call, caller, symbol };
        const outgoing = this.callsByFile.get(source.fileName) ?? [];
        outgoing.push(site);
        this.callsByFile.set(source.fileName, outgoing);
        if (symbol) {
          const entries = this.callers.get(symbol) ?? [];
          entries.push(site);
          this.callers.set(symbol, entries);
        }
      }
      for (const item of facts.imports) {
        if (ts.isCallExpression(item.node) && ts.isIdentifier(item.node.expression) && this.symbol(item.node.expression)?.declarations?.length) continue;
        this.imports.push({ ...item, file: source.fileName, resolved: this.resolveModule(item.specifier, source.fileName)?.resolvedFileName });
      }
    }
    this.dirty = false;
  }

  private resolveModule(name: string, containingFile: string): ts.ResolvedModuleFull | undefined {
    const resolved = ts.resolveModuleName(name, containingFile, this.options, this.host).resolvedModule;
    if (resolved) return resolved;
    const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
    const pkg = this.packages.get(packageName);
    if (!pkg) return undefined;
    const subpath = name.slice(packageName.length);
    const choose = (value: unknown): string | undefined => {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        for (const condition of ['types', 'import', 'require', 'default']) {
          const target = choose(record[condition]);
          if (target) return target;
        }
      }
      return undefined;
    };
    const exports = pkg.json.exports;
    let entry: string | undefined;
    if (exports !== undefined) {
      entry = exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some(key => key.startsWith('.'))
        ? choose((exports as Record<string, unknown>)[subpath ? `.${subpath}` : '.'])
        : !subpath ? choose(exports) : undefined;
      if (!entry) return undefined;
    } else entry = subpath ? `.${subpath}` : choose(pkg.json.types) ?? choose(pkg.json.module) ?? choose(pkg.json.main) ?? './index';
    const absolute = path.resolve(pkg.directory, entry);
    if (!absolute.startsWith(`${pkg.directory}${path.sep}`)) return undefined;
    const relative = `./${path.relative(path.dirname(containingFile), absolute).replaceAll(path.sep, '/')}`;
    const workspaceModule = ts.resolveModuleName(relative, containingFile, this.options, this.host).resolvedModule;
    return workspaceModule ? { ...workspaceModule, resolvedUsingTsExtension: false } : undefined;
  }

  private symbol(node: ts.Node): ts.Symbol | undefined {
    let symbol = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? this.checker.getShorthandAssignmentValueSymbol(node.parent) : this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    return symbol;
  }

  private declaration(symbol?: ts.Symbol): ts.Declaration | undefined {
    return symbol?.declarations?.find(node => !!functionOf(node)?.body) ?? symbol?.valueDeclaration ??
      symbol?.declarations?.find(node => this.files.has(node.getSourceFile().fileName));
  }

  private focus(source: ts.SourceFile, offset: number, scope?: Scope): ts.Node | undefined {
    if (scope === 'file') return source;
    if (!Number.isFinite(offset) || offset < 0 || offset > source.end) return undefined;
    let token: ts.Node = source;
    const find = (node: ts.Node): void => {
      if (node.getStart(source) <= offset && offset < node.end) { token = node; node.forEachChild(find); }
    };
    source.forEachChild(find);
    if (scope === 'expression') {
      let expression = enclosing(token, ts.isExpression);
      if (!expression) return undefined;
      while (expression.parent && (ts.isPropertyAccessExpression(expression.parent) || ts.isBinaryExpression(expression.parent) ||
        ts.isCallExpression(expression.parent) && expression.parent.expression === expression)) expression = expression.parent;
      return expression;
    }
    if (scope === 'function' || scope === 'class') {
      const ancestor = enclosing(token, scope === 'function' ? node => !!functionOf(node) : ts.isClassLike);
      if (ancestor) return namedFunction(ancestor);
    }
    const symbol = this.symbol(ts.isPropertyAccessExpression(token) ? token.name : token);
    const declaration = this.declaration(symbol);
    if (declaration) {
      if (scope === 'function' && !functionOf(declaration) || scope === 'class' && !ts.isClassLike(declaration)) return undefined;
      return namedFunction(declaration);
    }
    if (scope === 'function' || scope === 'class') return undefined;
    const ancestor = enclosing(token, node => callable(node) || ts.isClassLike(node) || ts.isVariableDeclaration(node) || ts.isParameter(node));
    return ancestor ? namedFunction(ancestor) : undefined;
  }

  private scopeOf(node: ts.Node): Scope {
    return ts.isSourceFile(node) ? 'file' : ts.isClassLike(node) ? 'class' : functionOf(node) ? 'function' : 'expression';
  }

  private label(node: ts.Node): string {
    if (ts.isSourceFile(node)) return this.relative(node.fileName);
    if (ts.isConstructorDeclaration(node)) return 'constructor';
    return compact((nameOf(node) ?? node).getText(), 90) || 'anonymous function';
  }

  private link(node: ts.Node, label = this.label(node), nameOnly = false): SourceLink {
    const target = nameOnly ? nameOf(node) ?? node : node;
    return { file: node.getSourceFile().fileName, start: target.getStart(), end: target.end, line: target.getSourceFile().getLineAndCharacterOfPosition(target.getStart()).line + 1, label, ...(ts.isSourceFile(node) ? { scope: 'file' as const } : {}) };
  }

  private inNode(node: ts.Node, focus: ts.Node): boolean {
    if (node.getSourceFile() !== focus.getSourceFile() || node.pos < focus.pos || node.end > focus.end) return false;
    const fn = functionOf(focus);
    if (fn) return enclosing(node.parent, callable) === fn;
    if (ts.isSourceFile(focus) || ts.isClassLike(focus)) return true;
    return enclosing(node.parent, callable) === enclosing(focus.parent, callable);
  }

  private type(node: ts.Node): string {
    const annotation = (node as ts.ParameterDeclaration).type;
    if (annotation) return compact(annotation.getText(), 250);
    const inferred = this.checker.typeToString(this.checker.getTypeAtLocation(node));
    return inferred === '{}' ? 'unavailable (standard-library types are not loaded)' : compact(inferred, 250);
  }

  private describe(expression: ts.Expression): string {
    if (ts.isBinaryExpression(expression)) {
      const operators: Partial<Record<ts.SyntaxKind, string>> = {
        [ts.SyntaxKind.PlusToken]: 'combined with + (addition or string concatenation)', [ts.SyntaxKind.MinusToken]: 'minus',
        [ts.SyntaxKind.AsteriskToken]: 'multiplied by', [ts.SyntaxKind.SlashToken]: 'divided by',
        [ts.SyntaxKind.QuestionQuestionToken]: 'with a fallback, when null or undefined, of',
        [ts.SyntaxKind.AmpersandAmpersandToken]: 'and, only when truthy,', [ts.SyntaxKind.BarBarToken]: 'with a fallback, when falsy, of',
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: 'strictly compared for equality with',
      };
      return `${compact(expression.left.getText(), 65)} ${operators[expression.operatorToken.kind] ?? expression.operatorToken.getText()} ${compact(expression.right.getText(), 65)}`;
    }
    if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) return `${ts.isNewExpression(expression) ? 'a new instance from' : 'the result of calling'} ${compact(expression.expression.getText(), 75)}`;
    if (ts.isConditionalExpression(expression)) return `${compact(expression.whenTrue.getText(), 60)} when ${compact(expression.condition.getText(), 60)} is truthy; otherwise ${compact(expression.whenFalse.getText(), 60)}`;
    if (ts.isAwaitExpression(expression)) return `the awaited result of ${compact(expression.expression.getText(), 100)}`;
    if (ts.isObjectLiteralExpression(expression)) return `an object with ${expression.properties.length} declared properties`;
    if (ts.isArrayLiteralExpression(expression)) return `an array with ${expression.elements.length} written elements (spreads can add more)`;
    return compact(expression.getText());
  }

  private base(node: ts.Node, scope: Scope): Explanation {
    return {
      id: `${node.getSourceFile().fileName}:${node.getStart()}:${scope}`, name: this.label(node),
      kind: ts.SyntaxKind[node.kind], scope, source: this.link(node, this.label(node), true), summary: '', role: '',
      sourceCode: node.getText().length > 3600 ? `${node.getText().slice(0, 3600)}\n… (preview shortened; open source for the rest)` : node.getText(), steps: [], examples: [], inputs: [], outputs: [], effects: [], notes: [...this.projectNotes,
        'Static analysis shows written relationships. Runtime dispatch, callback scheduling, reflection and side effects of unresolved calls cannot be determined.',
        'Types use indexed source only; standard-library and unindexed dependency declarations are unavailable.'],
      evidence: [this.link(node, 'Definition', true)], upstream: [], downstream: [], children: [],
      stats: { files: [...this.files.keys()].filter(file => SOURCE.test(file)).length, elapsedMs: 0, cached: false },
    };
  }

  private explainNode(node: ts.Node, scope: Scope): Explanation {
    const result = this.base(node, scope);
    const source = node.getSourceFile();
    const symbol = this.symbol(nameOf(node) ?? node);
    const fn = functionOf(node);
    const returns: ts.ReturnStatement[] = [];
    const statements: ts.Node[] = [];
    walk(node, child => { if (this.inNode(child, node)) statements.push(child); });
    const documentation = symbol ? ts.displayPartsToString(symbol.getDocumentationComment(this.checker)) : '';
    if (documentation) {
      result.summary = `Documented purpose: ${compact(documentation, 350)}`;
      result.notes.push('Documentation describes author intent; it is not proof of runtime behavior.');
    }
    if (fn) {
      const signature = this.checker.getSignatureFromDeclaration(fn);
      const inferredOutput = signature ? this.checker.typeToString(this.checker.getReturnTypeOfSignature(signature)) : 'unknown';
      const output = fn.type ? compact(fn.type.getText(), 250) : inferredOutput === '{}' ? 'unavailable (standard-library types are not loaded)' : compact(inferredOutput, 250);
      result.signature = compact(`${fn.typeParameters?.length ? `<${fn.typeParameters.map(type => type.getText()).join(', ')}>` : ''}(${fn.parameters.map(parameter => parameter.getText()).join(', ')}): ${output}`, 350);
      result.inputs = fn.parameters.map(parameter => `${compact(parameter.name.getText(), 90)}: ${this.type(parameter)}${parameter.questionToken ? ' (optional)' : ''}${parameter.initializer ? `; default ${compact(parameter.initializer.getText(), 70)}` : ''}`);
      for (const statement of statements) if (ts.isReturnStatement(statement)) returns.push(statement);
      const expressions = returns.flatMap(statement => statement.expression ? [statement.expression] : []);
      if (fn.body && !ts.isBlock(fn.body)) expressions.push(fn.body);
      result.outputs = [`Return type: ${output}.`, ...expressions.slice(0, 4).map(expression => `Returns ${this.describe(expression)}.`)];
      if (expressions.length > 4) result.notes.push(`Showing the first 4 of ${expressions.length} return expressions.`);
      result.summary ||= expressions.length === 1 ? `${result.name} accepts ${fn.parameters.length} input${fn.parameters.length === 1 ? '' : 's'} and returns ${this.describe(expressions[0])}.` :
        `${result.name} is a function with ${fn.parameters.length} input${fn.parameters.length === 1 ? '' : 's'} and return type ${output}.`;
      if ('asteriskToken' in fn && fn.asteriskToken) result.notes.push('This is a generator: calling it creates an iterator; its body runs when that iterator advances.');
    } else if (ts.isClassLike(node)) {
      result.summary ||= `${result.name} groups instance state and behavior in a class with ${node.members.length} declared members.`;
      const constructor = node.members.find(ts.isConstructorDeclaration);
      result.inputs = constructor?.parameters.map(parameter => `${parameter.name.getText()}: ${this.type(parameter)}`) ?? [];
      result.outputs = [`Constructing this class creates a ${result.name} instance.`];
      result.children = node.members.map(member => this.link(member, this.label(member), true));
    } else if (ts.isSourceFile(node)) {
      result.summary ||= `${result.name} defines ${node.statements.length} top-level statements and connects the imports and exported symbols below.`;
      result.children = this.children(node);
      const module = this.checker.getSymbolAtLocation(node);
      result.outputs = module ? this.checker.getExportsOfModule(module).slice(0, LIMIT).map(item => `Export: ${item.name}`) : [];
      result.inputs = this.imports.filter(item => item.file === node.fileName).map(item => `Imports ${item.specifier}${item.typeOnly ? ' (types only)' : ''}`);
    } else if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node) || ts.isPropertyAssignment(node)) {
      const initializer = node.initializer;
      result.summary ||= `${result.name} ${initializer ? `starts with ${this.describe(initializer)}` : 'holds a value supplied by its surrounding code'}.`;
      result.outputs = [`Value type: ${this.type(node)}.`];
    } else {
      result.summary ||= ts.isExpression(node) ? `Evaluates ${this.describe(node)}.` : `${result.name} is a ${ts.SyntaxKind[node.kind]} declaration.`;
      result.outputs = [`Static type: ${this.type(node)}.`];
    }
    const walkthrough = teachingSteps(fn?.body ?? node, child => this.link(child));
    result.steps = ts.isClassLike(node) ? [] : walkthrough.steps;
    if (walkthrough.truncated) result.notes.push('Showing the first 12 source steps; open source for the rest.');
    if (fn) result.examples = callExamples(fn.parameters, (symbol ? this.callers.get(symbol) ?? [] : []).map(site => site.call), child => this.link(child));
    if (fn && (symbol ? this.callers.get(symbol)?.length ?? 0 : 0) > 3) result.notes.push('Showing the first 3 call examples. More callers are available in Upstream.');
    this.relationships(node, symbol, result);
    for (const statement of statements) {
      if (ts.isCallExpression(statement)) {
        const hint = arrayMethodHint(statement, this.checker);
        if (hint) {
          if (hint.mutates) result.effects.push(`Likely change: ${hint.detail}`);
          const step = result.steps.find(step => statement.getStart() >= step.source.start && statement.end <= step.source.end);
          if (step && !step.detail.includes(hint.detail)) step.detail = `${step.detail} ${hint.detail}`.slice(0, 1200);
        }
      }
      if (ts.isThrowStatement(statement)) result.effects.push(`May throw ${compact(statement.expression.getText(), 100)}.`);
      if (ts.isAwaitExpression(statement)) result.effects.push(`Waits asynchronously for ${compact(statement.expression.getText(), 100)}.`);
      const write = ts.isBinaryExpression(statement) && statement.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && statement.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? statement.left :
        (ts.isPrefixUnaryExpression(statement) || ts.isPostfixUnaryExpression(statement)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(statement.operator) ? statement.operand : undefined;
      if (write && (ts.isPropertyAccessExpression(write) || ts.isElementAccessExpression(write))) result.effects.push(`Writes ${compact(write.getText(), 90)}; visibility outside this scope depends on who shares the object.`);
      else if (write && ts.isIdentifier(write)) {
        const declaration = this.declaration(this.symbol(write));
        if (declaration && !this.inNode(declaration, node)) result.effects.push(`Updates the outer variable ${write.text}.`);
      }
      if (ts.isDeleteExpression(statement)) result.effects.push(`Deletes ${compact(statement.expression.getText(), 90)}.`);
    }
    result.effects = [...new Set(result.effects)];
    if (!result.effects.length) result.effects.push('No explicit outer-variable writes, property writes, throws or awaits found in this scope. Calls may still have side effects.');
    const upstream = result.upstream.filter(relation => relation.kind === 'caller');
    const downstream = result.downstream.filter(relation => relation.kind === 'callee');
    const moduleSymbol = this.checker.getSymbolAtLocation(source);
    const exported = !!symbol && !!moduleSymbol && this.checker.getExportsOfModule(moduleSymbol).some(item => (item.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(item) : item) === symbol);
    result.role = `Defined in ${this.relative(source.fileName)}${exported ? ' and exported for other modules' : ''}.`;
    if (upstream.length) result.role += ` Called in ${[...new Set(upstream.map(item => item.target?.label).filter(Boolean))].slice(0, 3).join(', ')}.`;
    if (downstream.length) result.role += ` Contains calls to ${[...new Set(downstream.map(item => item.target?.label ?? item.evidence.label))].slice(0, 3).join(', ')}.`;
    const tests = symbol ? (this.references.get(symbol) ?? []).filter(ref => /(?:^|[/\\])(?:test|tests|__tests__)(?:[/\\])|[.](?:test|spec)[.]/i.test(ref.getSourceFile().fileName)) : [];
    if (tests.length) {
      result.role += ` Referenced by ${new Set(tests.map(ref => ref.getSourceFile().fileName)).size} indexed test file(s); this does not establish test coverage.`;
      result.evidence.push(...tests.slice(0, 3).map(ref => this.link(ref, `Test reference: ${this.relative(ref.getSourceFile().fileName)}`)));
    }
    this.bound(result);
    result.evidence.push(...[...result.upstream, ...result.downstream].map(item => item.evidence));
    return result;
  }

  private relationships(node: ts.Node, symbol: ts.Symbol | undefined, result: Explanation): void {
    const add = (direction: 'upstream' | 'downstream', kind: Relationship['kind'], detail: string, evidence: ts.Node, target?: ts.Node, certainty: Relationship['certainty'] = 'verified'): void => {
      result[direction].push({ kind, detail, certainty, evidence: this.link(evidence), target: target ? this.link(target, this.label(target), true) : undefined });
    };
    for (const site of symbol ? this.callers.get(symbol) ?? [] : []) {
      add('upstream', 'caller', `${this.label(site.caller)} calls ${result.name} here. This is a static call site, not a guarantee that it executes.`, site.call, site.caller);
      for (let parent = site.call.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
        if (callable(parent)) {
          if (ts.isArrowFunction(parent) && !ts.isBlock(parent.body)) add('downstream', 'consumer', `The result contributes to the value returned by ${this.label(site.caller)}.`, site.call, site.caller);
          break;
        }
        if (ts.isVariableDeclaration(parent) && parent.initializer) {
          add('downstream', 'consumer', `The result contributes to the initializer of ${this.label(parent)}.`, site.call, parent);
          break;
        }
        if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
          const index = parent.arguments?.findIndex(argument => site.call.pos >= argument.pos && site.call.end <= argument.end) ?? -1;
          if (index >= 0) {
            const consumer = this.declaration(this.symbol(ts.isPropertyAccessExpression(parent.expression) ? parent.expression.name : parent.expression));
            add('downstream', 'consumer', `The result is used in argument ${index + 1} passed to ${compact(parent.expression.getText(), 70)}.`, site.call, consumer);
          }
          break;
        }
        if (ts.isReturnStatement(parent)) {
          add('downstream', 'consumer', `The result contributes to the value returned by ${this.label(site.caller)}.`, site.call, site.caller);
          break;
        }
        if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && site.call.pos >= parent.right.pos) {
          const target = this.declaration(this.symbol(ts.isPropertyAccessExpression(parent.left) ? parent.left.name : parent.left));
          add('downstream', 'consumer', `The result contributes to the value assigned to ${compact(parent.left.getText(), 70)}.`, site.call, target);
          break;
        }
      }
      for (const [index, argument] of (site.call.arguments ?? []).entries()) {
        const declaration = this.declaration(this.symbol(ts.isPropertyAccessExpression(argument) ? argument.name : argument));
        if (declaration) add('upstream', 'data source', `This call passes ${compact(argument.getText(), 70)} as argument ${index + 1}.`, argument, declaration);
      }
    }
    for (const site of this.callsByFile.get(node.getSourceFile().fileName) ?? []) {
      if (!this.inNode(site.call, node)) continue;
      const target = this.declaration(site.symbol);
      const targetName = compact(site.call.expression.getText(), 90);
      if (site.call.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!site.call.arguments?.[0] || !ts.isStringLiteralLike(site.call.arguments[0])) result.notes.push('A dynamic import uses a computed path; its runtime destination cannot be determined.');
        continue;
      }
      const knownImplementation = !!target && (!!functionOf(target)?.body || ts.isClassLike(target) && !target.getSourceFile().isDeclarationFile);
      add('downstream', 'callee', knownImplementation ? `Statically calls ${targetName}; the target declaration is linked.` : `Calls ${targetName}; the runtime implementation is outside indexed code or dynamically resolved${target ? ' (linked value declaration)' : ''}.`, site.call, target, knownImplementation ? 'verified' : 'inferred');
      if (!knownImplementation) result.notes.push(`The runtime implementation of ${targetName} cannot be determined from this call.`);
    }
    if (symbol) {
      for (const reference of this.references.get(symbol) ?? []) {
        if (symbol.declarations?.some(declaration => nameOf(declaration) === reference) || reference.getSourceFile() === node.getSourceFile() && reference.pos >= node.pos && reference.end <= node.end) continue;
        const call = enclosing(reference, child => ts.isCallExpression(child) || ts.isNewExpression(child)) as ts.CallExpression | ts.NewExpression | undefined;
        if (call && (call.expression === reference || ts.isPropertyAccessExpression(call.expression) && call.expression.name === reference)) continue;
        const argumentIndex = call?.arguments?.findIndex(argument => reference.pos >= argument.pos && reference.end <= argument.end) ?? -1;
        const variable = enclosing(reference, ts.isVariableDeclaration) as ts.VariableDeclaration | undefined;
        const caller = namedFunction(enclosing(reference, callable) ?? reference.getSourceFile());
        if (call && argumentIndex >= 0) {
          const consumer = this.declaration(this.symbol(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression)) ?? caller;
          add('downstream', 'consumer', `${result.name} is used in argument ${argumentIndex + 1} passed to ${compact(call.expression.getText(), 70)}. Callback execution is not established by passing a value.`, reference, consumer);
        } else if (variable?.initializer && reference.pos >= variable.initializer.pos && reference.end <= variable.initializer.end &&
          !(functionOf(caller) && caller.pos >= variable.initializer.pos && caller.end <= variable.initializer.end) && !functionOf(variable)) {
          add('downstream', 'consumer', `${this.label(variable)} uses ${result.name} in its initializer.`, reference, variable);
        } else {
          const importing = enclosing(reference, child => ts.isImportDeclaration(child) || ts.isImportEqualsDeclaration(child));
          add('upstream', importing ? 'import' : 'reference', importing ? `Imported into ${this.relative(reference.getSourceFile().fileName)}.` : `Referenced in ${this.label(caller)}; a reference alone does not prove a call or data flow.`, reference, caller);
        }
      }
    }
    const initializer = (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node) || ts.isPropertyAssignment(node)) ? node.initializer : undefined;
    if (initializer && !functionOf(node)) {
      const visit = (child: ts.Node): void => {
        if (callable(child)) return;
        if (ts.isIdentifier(child)) {
          const target = this.declaration(this.symbol(child));
          if (target && target !== node && nameOf(target) !== child) add('upstream', 'data source', `The initializer reads or calls ${child.text}; linked declaration supplies this value.`, child, target);
        }
        child.forEachChild(visit);
      };
      visit(initializer);
    }
    const declarations = this.imports.filter(item => ts.isSourceFile(node) ? item.file === node.fileName || item.resolved === node.fileName : item.file === node.getSourceFile().fileName && item.node.pos >= node.pos && item.node.end <= node.end);
    for (const item of declarations) {
      if (item.file === node.getSourceFile().fileName) {
        const target = item.resolved ? this.program?.getSourceFile(item.resolved) : undefined;
        add('downstream', 'import', `Imports ${item.specifier}${item.typeOnly ? ' for types only' : ''}${target ? '.' : '; no indexed target is available.'}`, item.node, target, target ? 'verified' : 'inferred');
      } else add('upstream', 'import', `${this.relative(item.file)} imports this module.`, item.node, item.node.getSourceFile());
    }
  }

  private children(source: ts.SourceFile): SourceLink[] {
    return source.statements.flatMap(statement => ts.isVariableStatement(statement) ? statement.declarationList.declarations.map(node => this.link(node, this.label(node), true)) :
      nameOf(statement) ? [this.link(statement, this.label(statement), true)] : []);
  }

  private explainGroup(source: ts.SourceFile, scope: 'project' | 'module'): Explanation {
    const packageDirectory = [...this.files.keys()].filter(file => path.basename(file) === 'package.json').map(file => path.dirname(file)).filter(dir => source.fileName.startsWith(`${dir}${path.sep}`)).sort((a, b) => b.length - a.length)[0];
    const directory = scope === 'project' ? this.root : packageDirectory ?? path.dirname(source.fileName);
    const files = this.program!.getSourceFiles().filter(file => file.fileName.startsWith(`${directory}${path.sep}`));
    const result = this.base(source, scope);
    result.sourceCode = '';
    result.id = `${directory}:${scope}`;
    result.name = scope === 'project' ? path.basename(this.root) : this.relative(directory) || path.basename(this.root);
    result.kind = scope === 'project' ? 'Project' : 'Module';
    result.summary = `${result.name} contains ${files.length} indexed JavaScript/TypeScript files. Select a file, then a symbol to explore concrete behavior.`;
    result.role = scope === 'project' ? 'This overview shows the indexed project boundary. Import connections below describe how its files are connected.' :
      `This module groups files under ${this.relative(directory) || '.'}${packageDirectory ? ' using the nearest indexed package.json' : ' using the selected file’s directory'}.`;
    result.children = files.slice(0, LIMIT).map(file => this.link(file, this.relative(file.fileName)));
    const names = new Set(files.map(file => file.fileName));
    for (const item of this.imports) {
      if (!names.has(item.file) && (!item.resolved || !names.has(item.resolved))) continue;
      const target = item.resolved ? this.program?.getSourceFile(item.resolved) : undefined;
      const relation: Relationship = { kind: 'import', certainty: target ? 'verified' : 'inferred', detail: `${this.relative(item.file)} imports ${item.specifier}${item.typeOnly ? ' (types only)' : ''}.`, evidence: this.link(item.node), target: target ? this.link(target, this.relative(target.fileName)) : undefined };
      if (names.has(item.file)) result.downstream.push(relation);
      else result.upstream.push({ ...relation, target: this.link(item.node.getSourceFile(), this.relative(item.file)) });
    }
    result.evidence = files.slice(0, 8).map(file => this.link(file, this.relative(file.fileName)));
    for (const [file, value] of this.files) {
      if (path.dirname(file) !== directory || !/^(?:readme(?:[.]\w+)?|package[.]json|[jt]sconfig[.]json)$/i.test(path.basename(file))) continue;
      result.evidence.push({ file, start: 0, end: Math.min(value.text.length, 100), label: this.relative(file) });
      if (path.basename(file) === 'package.json') {
        try {
          const metadata = JSON.parse(value.text) as { description?: unknown };
          if (typeof metadata.description === 'string') result.role += ` Package description (documented): ${compact(metadata.description, 280)}`;
        } catch { /* Metadata evidence is still available when JSON is invalid. */ }
      } else if (/^readme(?:[.]|$)/i.test(path.basename(file))) {
        const paragraph = value.text.split(/\r?\n\s*\r?\n/).find(part => part.trim() && !/^\s*(?:#|```|!\[|<)/.test(part));
        if (paragraph) result.role += ` README context (documented): ${compact(paragraph, 280)}`;
      }
    }
    if (files.length > LIMIT) result.notes.push(`Overview shows the first ${LIMIT} of ${files.length} files. Open another source file to explore it.`);
    result.notes.push('No application entry point or feature architecture is guessed. Follow verified imports and documented symbol intent to establish the execution path.');
    this.bound(result);
    return result;
  }

  private bound(result: Explanation): void {
    for (const direction of ['upstream', 'downstream'] as const) {
      const seen = new Set<string>();
      result[direction] = result[direction].filter(item => {
        const key = `${item.kind}:${item.target?.file}:${item.target?.start}:${item.evidence.file}:${item.evidence.start}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (result[direction].length > LIMIT) result.notes.push(`${direction} shows the first ${LIMIT} of ${result[direction].length} relationships. Open a caller or file to narrow exploration.`);
      result[direction] = result[direction].slice(0, LIMIT);
    }
    for (const section of ['inputs', 'outputs', 'effects', 'children'] as const) {
      if (result[section].length > LIMIT) result.notes.push(`${section} shows the first ${LIMIT} of ${result[section].length} items.`);
      if (section === 'children') result.children = result.children.slice(0, LIMIT);
      else result[section] = result[section].slice(0, LIMIT).map(item => compact(item, 400));
    }
    result.notes = [...new Set(result.notes)];
    if (result.notes.length > LIMIT) result.notes = [...result.notes.slice(0, LIMIT), `${result.notes.length - LIMIT} further analysis notes omitted.`];
  }
}

import * as vscode from 'vscode';
import * as path from 'node:path';
import { AnalysisClient } from './client';
import { AnalysisQuery, Explanation, Scope, SourceLink } from './model';
import { collectProject, isAllowedFile, readBounded, expandEditorExcludes, isAllowedDirectory, requiresReindex, indexLimits } from './workspace';
import { renderPanel } from './panel';
import { ExplorationHistory } from './history';

const languages = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/i;
const scopes: Scope[] = ['expression', 'function', 'class', 'file', 'module', 'project'];
interface Session {
  root: string;
  client: AnalysisClient;
  files: Map<string, number>;
  changes: Promise<void>;
  exclude: string[];
  maxFileKB: number;
  maxFiles: number;
}

export function activate(context: vscode.ExtensionContext) {
  const sessions = new Map<string, Promise<Session>>();
  const history = new ExplorationHistory();
  const output = vscode.window.createOutputChannel('Code Teach', {log:true});
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(book) Code Teach';
  status.tooltip = 'Explore this project. All analysis stays on this computer.';
  status.command = 'codeTeach.project';
  status.show();
  let panel: vscode.WebviewPanel | undefined;
  let current: Explanation | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let indexTimer: NodeJS.Timeout | undefined;
  let navigation = 0;
  let disposed = false;
  let generation = 0;
  let revision = 0;

  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'Cancelled' && !message.includes('cancelled')) {
      output.appendLine(message);
      void vscode.window.showWarningMessage(`Code Teach: ${message}`);
    }
  };

  function folderFor(file?: string) {
    const uri = file ? vscode.Uri.file(file) : vscode.window.activeTextEditor?.document.uri;
    return (uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined) ?? vscode.workspace.workspaceFolders?.[0];
  }

  async function sessionFor(file?: string, token?: vscode.CancellationToken): Promise<Session> {
    const folder = folderFor(file);
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Open a local JavaScript/TypeScript project folder first.');
    const root = folder.uri.fsPath;
    let pending = sessions.get(root);
    if (!pending) {
      const startGeneration = generation;
      pending = (async () => {
        const config = vscode.workspace.getConfiguration('codeTeach', folder.uri);
        const exclude = [...config.get<string[]>('exclude', [])];
        for (const key of ['files', 'search']) {
          const settings = vscode.workspace.getConfiguration(key, folder.uri).get<Record<string, boolean | object>>('exclude', {});
          for (const [pattern, value] of Object.entries(settings)) if (value) exclude.push(...expandEditorExcludes([pattern]));
        }
        const {maxFiles, maxFileKB} = indexLimits({maxFiles:config.get<number>('maxFiles'), maxFileKB:config.get<number>('maxFileKB')});
        status.text = '$(sync~spin) Code Teach: indexing';
        try {
          const project = await collectProject(root, { maxFiles, maxFileKB, exclude,
            isCancelled: () => disposed || startGeneration !== generation || !!token?.isCancellationRequested,
            onProgress: count => { status.text = `$(sync~spin) Code Teach: ${count} files`; } });
          if (disposed || startGeneration !== generation || token?.isCancellationRequested) throw new Error('Cancelled');
          const omitted = new Set<string>();
          let bytes = project.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
          for (const file of project.files) {
            const open = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === file.file);
            if (open?.isDirty) {
              const size = Buffer.byteLength(open.getText());
              const nextBytes = bytes - Buffer.byteLength(file.text) + size;
              if (size <= maxFileKB * 1024 && nextBytes <= 16 * 1024 * 1024) {
                bytes = nextBytes; file.text = open.getText();
              } else {
                bytes -= Buffer.byteLength(file.text); omitted.add(file.file);
                project.notes?.push('An unsaved file exceeded the index limits and was omitted.');
              }
            }
          }
          project.files = project.files.filter(file => !omitted.has(file.file));
          const client = new AnalysisClient();
          try {
            await client.initialize(project);
            if (disposed || startGeneration !== generation || token?.isCancellationRequested) throw new Error('Cancelled');
          } catch (error) { client.dispose(); throw error; }
          const session = { root, client, exclude, maxFiles, maxFileKB,
            files: new Map(project.files.map(file => [file.file, Buffer.byteLength(file.text)])), changes: Promise.resolve() };
          output.appendLine(`Indexed ${project.files.length} files in ${root}. ${project.notes?.join(' ') ?? ''}`);
          return session;
        } finally { status.text = '$(book) Code Teach'; }
      })();
      sessions.set(root, pending);
      pending.catch(() => { if (sessions.get(root) === pending) sessions.delete(root); });
    }
    return pending;
  }

  function clearPanel() {
    ++revision;
    current = undefined;
    if (panel) panel.webview.html = '<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;"></head><body><h1>Code Teach</h1><p>This selection is no longer available in the current index. Select another symbol and choose Code Teach: Explain Selection.</p></body></html>';
  }

  function render(notice?: string) {
    if (panel && current) panel.webview.html = renderPanel(current, history.entries, notice, ++revision);
  }

  async function openSource(link: SourceLink) {
    const session = await sessionFor(link.file);
    if (!session.files.has(link.file) || !await isAllowedFile(session.root, link.file, session.exclude)) {
      throw new Error('This source is excluded or no longer exists. Refresh the index.');
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(link.file));
    const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: true });
    const range = new vscode.Range(document.positionAt(link.start), document.positionAt(link.end));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  function ensurePanel() {
    if (panel) return;
    panel = vscode.window.createWebviewPanel('codeTeach.explorer', 'Code Teach', vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] });
    panel.onDidDispose(() => { panel = undefined; ++navigation; });
    panel.webview.onDidReceiveMessage(handlePanelMessage, undefined, context.subscriptions);
  }

  async function handlePanelMessage(message: unknown) {
    if (!current || !message || typeof message !== 'object') return;
    const m = message as Record<string, unknown>;
    if (m.revision !== revision) return;
    try {
      if (m.action === 'back') {
        await goBack();
      } else if (m.action === 'breadcrumb' && typeof m.index === 'number') {
        const visit = Number.isInteger(m.index) && m.index >= 0 ? history.entries[m.index] : undefined;
        if (visit) await show(visit.query, false, true, false, m.index);
      } else if (m.action === 'scope' && scopes.includes(m.scope as Scope)) {
        await show({ file: current.source.file, offset: current.source.start, scope: m.scope as Scope });
      } else if (m.action === 'navigate' && (m.direction === 'upstream' || m.direction === 'downstream') && Number.isInteger(m.index)) {
        const target = current[m.direction][m.index as number]?.target;
        if (target) await show({file:target.file,offset:target.start,scope:target.scope}, true, true);
      } else if (m.action === 'child' && Number.isInteger(m.index)) {
        const target = current.children[m.index as number];
        if (target) await show({file:target.file,offset:target.start,scope:target.scope}, true, true);
      } else if (m.action === 'source' && Number.isInteger(m.index)) {
        const source = m.index === -1 ? current.source : current.evidence[m.index as number];
        if (source) await openSource(source);
      } else if ((m.action === 'step' || m.action === 'example') && Number.isInteger(m.index)) {
        const source = (m.action === 'step' ? current.steps : current.examples)[m.index as number]?.source;
        if (source) await openSource(source);
      } else if (m.action === 'refresh') await refresh();
    } catch (error) { report(error); }
  }

  async function goBack() {
    const index = history.entries.length - 2;
    const visit = history.entries[index];
    if (visit) await show(visit.query, false, true, false, index);
  }

  async function show(query: AnalysisQuery, record = true, reveal = false, quiet = false, historyIndex?: number) {
    const sequence = ++navigation;
    const run = async (token?: vscode.CancellationToken) => {
      const controller = new AbortController();
      const subscription = token?.onCancellationRequested(() => controller.abort());
      try {
        const session = await sessionFor(query.file, token);
        await session.changes;
        if (token?.isCancellationRequested) return;
        if (!session.files.has(query.file)) {
          if (quiet) { clearPanel(); return; }
          throw new Error('This file is excluded, unsupported, or outside the index limit.');
        }
        const explanation = await session.client.explain(query, controller.signal);
        if (sequence !== navigation || token?.isCancellationRequested) return;
        if (!explanation) {
          if (quiet) clearPanel();
          else void vscode.window.showInformationMessage('Code Teach: No code is available at that scale here. Select a symbol or choose Explore Project.');
          return;
        }
        current = explanation;
        if (historyIndex !== undefined) history.go(historyIndex);
        const cycle = record && history.visit({file:explanation.source.file,offset:explanation.source.start,scope:query.scope}, explanation.name);
        ensurePanel();
        render(cycle ? 'Returned to an earlier step in this path. Circular relationships are expanded only when you choose them.' : undefined);
        if (!quiet) panel?.reveal(vscode.ViewColumn.Beside, true);
        if (reveal) await openSource(explanation.source);
      } finally { subscription?.dispose(); }
    };
    if (quiet) await run();
    else await vscode.window.withProgress({ location:vscode.ProgressLocation.Notification, title:'Code Teach: Reading project connections', cancellable:true }, (_, token) => run(token));
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    const scheduledAt = navigation;
    refreshTimer = setTimeout(() => {
      if (scheduledAt !== navigation) return;
      if (panel && history.current) void show(history.current.query, false, false, true).catch(report);
    }, 350);
  }

  function updateFile(uri: vscode.Uri, text?: string) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const pending = folder && sessions.get(folder.uri.fsPath);
    if (!pending || uri.scheme !== 'file') return;
    void pending.then(session => {
      session.changes = session.changes.then(async () => {
        const file = uri.fsPath;
        if (!await isAllowedFile(session.root, file, session.exclude)) {
          if (session.files.delete(file)) await session.client.update(file, null);
          return;
        }
        const open = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === file);
        const content = text ?? (open?.isDirty ? open.getText() : await readBounded(file, session.maxFileKB * 1024));
        if (content === undefined) {
          if (session.files.delete(file)) await session.client.update(file, null);
          return;
        }
        const size = Buffer.byteLength(content);
        const total = [...session.files.values()].reduce((sum, n) => sum + n, 0) - (session.files.get(file) ?? 0) + size;
        const count = [...session.files.keys()].filter(key => sourcePattern.test(key)).length;
        if (size > session.maxFileKB * 1024 || total > 16 * 1024 * 1024 || (!session.files.has(file) && (sourcePattern.test(file) ? count >= session.maxFiles : session.files.size - count >= 100))) {
          if (session.files.delete(file)) await session.client.update(file, null);
          output.appendLine(`Skipped changed file outside indexing limits: ${file}`);
          return;
        }
        session.files.set(file, size);
        await session.client.update(file, content);
      }).catch(error => { output.appendLine(`Update failed: ${String(error)}`); });
      scheduleRefresh();
    }).catch(report);
  }

  async function refresh() {
    if (indexTimer) { clearTimeout(indexTimer); indexTimer = undefined; }
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
    ++generation;
    ++navigation;
    for (const session of sessions.values()) void session.then(value => value.client.dispose()).catch(() => {});
    sessions.clear();
    if (history.current) {
      clearPanel();
      await show(history.current.query, false);
    }
    else await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Code Teach: Indexing project',cancellable:true}, async (_, token) => { await sessionFor(undefined, token); });
  }

  context.subscriptions.push(output, status,
    vscode.commands.registerCommand('codeTeach.explain', async (argument?: unknown) => {
      try {
        const editor = vscode.window.activeTextEditor;
        let query: AnalysisQuery | undefined;
        if (argument && typeof argument === 'object') {
          const candidate = argument as Partial<AnalysisQuery>;
          if (typeof candidate.file === 'string' && typeof candidate.offset === 'number' && Number.isInteger(candidate.offset) && candidate.offset >= 0 && (!candidate.scope || scopes.includes(candidate.scope))) query = candidate as AnalysisQuery;
        }
        if (!query && editor && editor.document.uri.scheme === 'file') query = {file:editor.document.uri.fsPath,offset:editor.document.offsetAt(editor.selection.active),scope:editor.selection.isEmpty ? undefined : 'expression'};
        if (!query) throw new Error('Open a JavaScript/TypeScript file and select some code.');
        await show(query);
      } catch (error) { report(error); }
    }),
    vscode.commands.registerCommand('codeTeach.project', async () => {
      try {
        await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Code Teach: Indexing project',cancellable:true}, async (_, token) => {
          const session = await sessionFor(undefined, token);
          if (token.isCancellationRequested) return;
          const file = [...session.files.keys()].find(file => sourcePattern.test(file));
          if (!file) throw new Error('No eligible JavaScript/TypeScript files were found.');
          await show({file,offset:0,scope:'project'});
        });
      } catch (error) { report(error); }
    }),
    vscode.commands.registerCommand('codeTeach.refresh', () => refresh().catch(report)),
    vscode.languages.registerHoverProvider(languages.map(language => ({language,scheme:'file'})), {
      async provideHover(document, position, token) {
        if (!document.getWordRangeAtPosition(position)) return;
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          await new Promise<void>(resolve => setTimeout(resolve, 120));
          if (token.isCancellationRequested) return;
          const session = await sessionFor(document.uri.fsPath, token);
          await session.changes;
          if (token.isCancellationRequested || !session.files.has(document.uri.fsPath)) return;
          const query = {file:document.uri.fsPath,offset:document.offsetAt(position)};
          const explanation = await session.client.explain(query, controller.signal);
          if (!explanation || token.isCancellationRequested) return;
          const markdown = new vscode.MarkdownString();
          markdown.appendMarkdown('**Code Teach** · Local static analysis\n\n');
          markdown.appendText(explanation.summary.slice(0, 220));
          markdown.appendMarkdown('\n\n');
          markdown.appendText(explanation.role.slice(0, 220));
          if (explanation.steps.length) markdown.appendCodeblock(explanation.steps.slice(0, 2).map(step => step.code).join('\n').slice(0, 180), document.languageId);
          if (explanation.inputs.length) { markdown.appendMarkdown('\n\n'); markdown.appendText(`Inputs: ${explanation.inputs.slice(0, 2).join('; ').slice(0, 180)}`); }
          if (explanation.outputs.length) { markdown.appendMarkdown('\n\n'); markdown.appendText(`Output: ${explanation.outputs[0].slice(0, 120)}`); }
          const effect = explanation.effects.find(effect => !effect.startsWith('No explicit'));
          if (effect) { markdown.appendMarkdown('\n\n'); markdown.appendText(`Effect: ${effect.slice(0, 140)}`); }
          const command = `command:codeTeach.explain?${encodeURIComponent(JSON.stringify([query]))}`;
          markdown.appendMarkdown(`\n\n[Explain more →](${command})`);
          markdown.isTrusted = { enabledCommands: ['codeTeach.explain'] };
          return new vscode.Hover(markdown, document.getWordRangeAtPosition(position));
        } catch (error) {
          if (!token.isCancellationRequested) output.appendLine(`Hover: ${String(error)}`);
          return;
        } finally { subscription.dispose(); }
      }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      history.adjust(event.document.uri.fsPath, event.contentChanges);
      updateFile(event.document.uri, event.document.getText());
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('codeTeach') || event.affectsConfiguration('files.exclude') || event.affectsConfiguration('search.exclude')) void refresh().catch(report);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh().catch(report); }),
    {dispose: () => {
      disposed = true; ++generation; ++navigation;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (indexTimer) clearTimeout(indexTimer);
      panel?.dispose();
      for (const pending of sessions.values()) void pending.then(session => session.client.dispose()).catch(() => {});
      sessions.clear();
    }}
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onDiskChange = (uri: vscode.Uri) => {
    if (requiresReindex(uri.fsPath)) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      const pending = folder && sessions.get(folder.uri.fsPath);
      if (pending) void pending.then(async session => {
        const ignoreFile = ['.gitignore', '.ignore'].includes(path.basename(uri.fsPath));
        const directory = path.dirname(uri.fsPath);
        const known = session.files.has(uri.fsPath) || (ignoreFile && await isAllowedDirectory(session.root, directory, session.exclude));
        if (!known && !await isAllowedFile(session.root, uri.fsPath, session.exclude)) return;
        if (indexTimer) clearTimeout(indexTimer);
        indexTimer = setTimeout(() => { void refresh().catch(report); }, 350);
      }).catch(report);
    } else updateFile(uri);
  };
  context.subscriptions.push(watcher, watcher.onDidCreate(onDiskChange), watcher.onDidChange(onDiskChange), watcher.onDidDelete(onDiskChange));
  return { refresh, back: goBack, handlePanelMessage, getRevision: () => revision, getCurrentExplanation: () => current, getHistory: () => history.entries };
}

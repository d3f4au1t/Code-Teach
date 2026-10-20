import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore, { Ignore } from 'ignore';
import ts from 'typescript';
import { IndexedFile, ProjectInput } from './model';

export interface IndexOptions {
  maxFiles?: number;
  maxFileKB?: number;
  exclude?: string[];
  isCancelled?: () => boolean;
  onProgress?: (files: number) => void;
}

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const DEFAULT_DIRECTORIES = new Set(['.git', '.svn', '.hg', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'generated', '__generated__', '.next', '.nuxt', '.cache', '.turbo', '.venv', 'secrets', '.secrets', 'credentials', '.credentials', 'keys']);
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_CONTEXT_FILES = 100;
const MAX_ENTRIES = 50_000;
interface Rules { directory: string; matcher: Ignore; }

export function requiresReindex(file: string): boolean {
  return /^(?:package|[jt]sconfig(?:[.-][^.]+)*)\.json$/i.test(path.basename(file)) || ['.gitignore', '.ignore'].includes(path.basename(file));
}

export function indexLimits(options: IndexOptions): {maxFiles: number; maxFileKB: number} {
  const bound = (value: number | undefined, fallback: number, maximum: number): number =>
    Math.min(maximum, Math.max(1, Math.floor(value !== undefined && Number.isFinite(value) ? value : fallback)));
  return {maxFiles:bound(options.maxFiles,1000,5000),maxFileKB:bound(options.maxFileKB,256,1024)};
}

/** Expand VS Code brace alternatives before passing editor exclusions to gitignore matching. */
export function expandEditorExcludes(patterns: string[]): string[] {
  const pending = [...patterns].reverse();
  const result: string[] = [];
  const checkBound = (additional = 0): void => {
    if (pending.length + result.length + additional > 128) throw new Error('Editor exclusions expand to more than 128 patterns. Simplify files.exclude or search.exclude.');
  };
  checkBound();
  while (pending.length) {
    const pattern = pending.pop()!;
    const stack: { start: number; commas: number[] }[] = [];
    let group: { start: number; end: number; commas: number[] } | undefined;
    let characterClass = false;
    for (let i = 0; i < pattern.length; i++) {
      const character = pattern[i];
      if (character === '\\') { i++; continue; }
      if (character === '[') characterClass = true;
      if (character === ']') characterClass = false;
      if (characterClass) continue;
      if (character === '{') stack.push({ start: i, commas: [] });
      else if (character === ',' && stack.length) stack[stack.length - 1].commas.push(i);
      else if (character === '}' && stack.length) {
        const closed = stack.pop()!;
        if (closed.commas.length && (!group || closed.start < group.start)) group = { ...closed, end: i };
        if (!stack.length && group) break;
      }
    }
    if (!group || stack.length) { result.push(pattern); continue; }
    const ends = [...group.commas, group.end];
    checkBound(ends.length);
    let start = group.start + 1;
    const alternatives = ends.map(end => {
      const alternative = pattern.slice(0, group.start) + pattern.slice(start, end) + pattern.slice(group!.end + 1);
      start = end + 1;
      return alternative;
    });
    pending.push(...alternatives.reverse());
  }
  return [...new Set(result)];
}

function slash(file: string): string { return file.split(path.sep).join('/'); }
function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function defaultExcluded(name: string, directory: boolean): boolean {
  const lower = name.toLowerCase();
  return (directory && DEFAULT_DIRECTORIES.has(lower))
    || /^(?:\.?env(?:\.|$)|\.?secrets?(?:[._-]|$)|\.?credentials?(?:[._-]|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/.test(lower)
    || /(?:private|secret)[_-]?key/.test(lower)
    || /\.(?:pem|key|p12|pfx|keystore|jks|map)$/.test(lower)
    || /\.min\.[cm]?[jt]s$/.test(lower)
    || /(?:[.-](?:generated|gen|g))\.[cm]?[jt]sx?$/.test(lower)
    || /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|\.npmrc|\.pypirc|\.netrc)$/.test(lower);
}
function contextFile(relative: string): boolean {
  const base = path.basename(relative);
  return /^(?:package|[jt]sconfig(?:[.-][^.]+)*)\.json$/i.test(base)
    || /^(?:readme|architecture|contributing)(?:[.-].*)?\.(?:md|txt)$/i.test(base)
    || /(?:^|\/)(?:docs?|documentation)\/.*\.md$/i.test(slash(relative))
    || /^(?:jest\.config|\.eslintrc|\.babelrc)\.json$/i.test(base);
}
function eligible(relative: string): boolean { return SOURCE.test(relative) || contextFile(relative); }
function excluded(root: string, file: string, directory: boolean, rules: Rules[], extra: Ignore): boolean {
  if (defaultExcluded(path.basename(file), directory)) return true;
  let ignored = false;
  for (const rule of rules) {
    const relative = slash(path.relative(rule.directory, file)) + (directory ? '/' : '');
    const result = rule.matcher.test(relative);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored || extra.ignores(slash(path.relative(root, file)) + (directory ? '/' : ''));
}

/** Read regular text only, without following a final symlink or allocating beyond the bound. */
export async function readBounded(file: string, limit: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(limit) || limit < 0) return undefined;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return undefined;
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > limit || buffer.subarray(0, bytesRead).includes(0)) return undefined;
    return buffer.toString('utf8', 0, bytesRead);
  } catch { return undefined; }
  finally { await handle?.close(); }
}

async function directoryRules(directory: string, parents: Rules[]): Promise<Rules[]> {
  const rules = [...parents];
  for (const name of ['.gitignore', '.ignore']) {
    const file = path.join(directory, name);
    try {
      if ((await fs.lstat(file)).isSymbolicLink()) continue;
      const text = await readBounded(file, 64 * 1024);
      if (text === undefined) throw new Error(`${name} exceeds the 64 KiB ignore-rule limit or is not text`);
      rules.push({ directory, matcher: ignore().add(text) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return rules;
}

/** Apply exactly the index's path policy before accepting an editor or watcher update. */
export function isAllowedFile(root: string, file: string, exclude: string[] = []): Promise<boolean> {
  return isAllowedPath(root, file, false, exclude);
}

/** Ignore-file changes matter in allowed directories even when none of their children are indexed. */
export function isAllowedDirectory(root: string, directory: string, exclude: string[] = []): Promise<boolean> {
  return isAllowedPath(root, directory, true, exclude);
}

async function isAllowedPath(root: string, file: string, directoryTarget: boolean, exclude: string[]): Promise<boolean> {
  root = path.resolve(root);
  file = path.resolve(file);
  if (file === root) return directoryTarget;
  if (!contained(root, file) || (!directoryTarget && !eligible(path.relative(root, file)))) return false;
  const extra = ignore().add(exclude);
  let directory = root;
  let rules: Rules[] = [];
  const parts = path.relative(root, file).split(path.sep);
  try {
    for (let i = 0; i < parts.length; i++) {
      rules = await directoryRules(directory, rules);
      const candidate = path.join(directory, parts[i]);
      const isDirectory = directoryTarget || i < parts.length - 1;
      if (excluded(root, candidate, isDirectory, rules, extra)) return false;
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile())) return false;
      directory = candidate;
    }
    return true;
  } catch { return false; }
}

function compilerOptions(root: string, files: IndexedFile[], notes: string[]): Record<string, unknown> | undefined {
  const indexed = new Map(files.map(file => [path.resolve(file.file), file.text]));
  const file = ['tsconfig.json', 'jsconfig.json'].map(name => path.join(root, name)).find(name => indexed.has(name));
  if (!file) return undefined;
  const json = ts.parseConfigFileTextToJson(file, indexed.get(file)!);
  if (json.error) {
    notes.push(`Configuration: ${ts.flattenDiagnosticMessageText(json.error.messageText, ' ')}`);
    return undefined;
  }
  // shortcut: one root compiler configuration, use per-package programs when mixed projects need distinct options.
  const parsed = ts.parseJsonConfigFileContent(json.config, {
    useCaseSensitiveFileNames: true,
    fileExists: name => indexed.has(path.resolve(name)),
    readFile: name => indexed.get(path.resolve(name)),
    readDirectory: () => files.filter(item => SOURCE.test(item.file)).map(item => item.file),
  }, root, {}, file);
  for (const diagnostic of parsed.errors) {
    if (diagnostic.code !== 18003) notes.push(`Configuration: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
  if (json.config.extends) notes.push('Configuration inheritance reads indexed files only; excluded or external base configurations are unavailable.');
  const options: Record<string, unknown> = { ...parsed.options };
  delete options.configFile;
  return options;
}

export async function collectProject(root: string, options: IndexOptions = {}): Promise<ProjectInput> {
  root = path.resolve(root);
  const {maxFiles, maxFileKB} = indexLimits(options);
  const maxBytes = maxFileKB * 1024;
  const extra = ignore().add(options.exclude ?? []);
  const files: IndexedFile[] = [];
  const notes = ['Local analysis excludes repository ignore rules, secrets, generated/vendor output, symlinks, and unsupported file types.'];
  let sources = 0, contexts = 0, bytes = 0, entries = 0, skipped = 0, stopped = false;
  const checkCancelled = (): void => {
    if (options.isCancelled?.()) throw Object.assign(new Error('Project indexing cancelled.'), { name: 'AbortError' });
  };
  async function walk(directory: string, parents: Rules[]): Promise<void> {
    checkCancelled();
    let rules: Rules[], children;
    try {
      rules = await directoryRules(directory, parents);
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      notes.push(`Skipped unreadable directory ${slash(path.relative(root, directory)) || '.'}: ${(error as Error).message}`);
      return;
    }
    // Root configuration and documentation remain available even when the source-file bound is reached.
    const rank = (entry: typeof children[number]): number => entry.isDirectory() ? 2 : SOURCE.test(entry.name) ? 1 : 0;
    children.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en'));
    for (const child of children) {
      checkCancelled();
      if (stopped) return;
      if (++entries > MAX_ENTRIES) {
        notes.push(`Index stopped at ${MAX_ENTRIES.toLocaleString('en-US')} directory entries; remaining paths are unavailable.`);
        stopped = true;
        return;
      }
      if (entries % 50 === 0) {
        options.onProgress?.(sources);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const file = path.join(directory, child.name);
      if (child.isSymbolicLink() || excluded(root, file, child.isDirectory(), rules, extra)) continue;
      if (child.isDirectory()) { await walk(file, rules); continue; }
      if (!child.isFile() || !eligible(path.relative(root, file))) continue;
      const source = SOURCE.test(file);
      if (source && sources >= maxFiles) {
        notes.push(`Index stopped at ${maxFiles} source files; remaining sources and relationships are unavailable.`);
        stopped = true;
        return;
      }
      if (!source && contexts >= MAX_CONTEXT_FILES) { skipped++; continue; }
      try {
        const text = await readBounded(file, maxBytes);
        if (text === undefined) { skipped++; continue; }
        const size = Buffer.byteLength(text);
        if (bytes + size > MAX_TOTAL_BYTES) {
          notes.push('Index stopped at the 16 MiB aggregate text bound; remaining files and relationships are unavailable.');
          stopped = true;
          return;
        }
        files.push({ file, text });
        bytes += size;
        if (source) sources++; else contexts++;
      } catch { skipped++; }
    }
  }
  await walk(root, []);
  checkCancelled();
  options.onProgress?.(sources);
  if (skipped) notes.push(`Skipped ${skipped} oversized, binary, unreadable, or excess context files (per-file bound ${maxBytes / 1024} KiB; context bound ${MAX_CONTEXT_FILES}).`);
  notes.push('Only the root tsconfig.json or jsconfig.json controls types and aliases; nested package configurations are not merged.');
  return { root, files, compilerOptions: compilerOptions(root, files, notes), notes };
}

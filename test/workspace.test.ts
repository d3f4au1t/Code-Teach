import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import ts from 'typescript';
import { collectProject, expandEditorExcludes, isAllowedDirectory, isAllowedFile, readBounded } from '../src/workspace';

async function fixture(t: TestContext, files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-teach-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  return root;
}

function names(root: string, files: { file: string }[]): string[] {
  return files.map(file => path.relative(root, file.file).split(path.sep).join('/')).sort();
}

test('VS Code brace exclusions expand nested alternatives, preserve literals, and bound growth', () => {
  assert.deepEqual(expandEditorExcludes(['**/*.{js,ts}', '**/{src/{client,server},test}/**']),
    ['**/*.js', '**/*.ts', '**/src/client/**', '**/src/server/**', '**/test/**']);
  assert.deepEqual(expandEditorExcludes(['{a,b}{c,d}', String.raw`\{a,b\}`, '[{},].ts', '{unclosed,a']),
    ['ac', 'ad', 'bc', 'bd', String.raw`\{a,b\}`, '[{},].ts', '{unclosed,a']);
  assert.equal(expandEditorExcludes(['{a,b}'.repeat(7)]).length, 128);
  assert.throws(() => expandEditorExcludes(['{a,b}'.repeat(8)]), /more than 128 patterns/);
  assert.throws(() => expandEditorExcludes([`{${Array.from({ length: 129 }, (_, i) => i).join(',')}}`]), /more than 128 patterns/);
  assert.throws(() => expandEditorExcludes(Array.from({ length: 129 }, (_, i) => `${i}.ts`)), /more than 128 patterns/);
});

test('expanded editor exclusions apply to both initial indexing and later edits', async t => {
  const root = await fixture(t, {
    'src/main.ts': 'export const main = 1;',
    'src/main.test.ts': 'export const test = 1;',
    'src/main.spec.js': 'export const spec = 1;',
    'src/client/mock.ts': 'export const mock = 1;',
    'src/server/mock.ts': 'export const mock = 1;',
  });
  const exclude = expandEditorExcludes(['**/*.{test,spec}.{js,ts}', '**/{client,server}/mock.ts']);
  assert.deepEqual(names(root, (await collectProject(root, { exclude })).files), ['src/main.ts']);
  assert.equal(await isAllowedFile(root, path.join(root, 'src/main.test.ts'), exclude), false);
  assert.equal(await isAllowedFile(root, path.join(root, 'src/main.ts'), exclude), true);
});

test('index and edit policy honor nested repository ignores and explicit excludes', async t => {
  const root = await fixture(t, {
    '.gitignore': 'ignored/\n!ignored/keep.ts\nblocked.ts\n*.temp.ts\n',
    '.ignore': 'muted.ts\n',
    'root.ts': 'export const root = 1;',
    'blocked.ts': 'export const blocked = 1;',
    'muted.ts': 'export const muted = 1;',
    'ignored/keep.ts': 'export const hidden = 1;',
    'nested/.gitignore': '!blocked.ts\nlocal.ts\n',
    'nested/blocked.ts': 'export const restored = 1;',
    'nested/local.ts': 'export const local = 1;',
    'nested/skip.temp.ts': 'export const temporary = 1;',
    'nested/explicit.ts': 'export const explicit = 1;',
  });
  const project = await collectProject(root, { exclude: ['**/explicit.ts'] });
  assert.deepEqual(names(root, project.files), ['nested/blocked.ts', 'root.ts']);
  for (const name of ['root.ts', 'nested/blocked.ts']) assert.equal(await isAllowedFile(root, path.join(root, name), ['**/explicit.ts']), true);
  for (const name of ['blocked.ts', 'muted.ts', 'ignored/keep.ts', 'nested/local.ts', 'nested/skip.temp.ts', 'nested/explicit.ts']) {
    assert.equal(await isAllowedFile(root, path.join(root, name), ['**/explicit.ts']), false, name);
  }
});

test('directory policy accepts empty and ignored-all-children directories but excludes blocked ancestors and symlinks', async t => {
  const root = await fixture(t, {
    '.gitignore': 'ignored/\n',
    'ignored/child/a.ts': '',
    'node_modules/pkg/a.ts': '',
    'allowed/.gitignore': '*\n',
    'nested/.gitignore': 'hidden/\n',
    'nested/hidden/a.ts': '',
    'file.ts': '',
  });
  await fs.mkdir(path.join(root, 'empty'));
  const outside = await fixture(t, {});
  await fs.symlink(outside, path.join(root, 'linked'));
  for (const directory of [root, path.join(root, 'empty'), path.join(root, 'allowed'), path.join(root, 'nested')]) {
    assert.equal(await isAllowedDirectory(root, directory), true, directory);
  }
  for (const directory of [outside, path.join(root, 'linked'), path.join(root, 'node_modules/pkg'), path.join(root, 'ignored/child'), path.join(root, 'nested/hidden'), path.join(root, 'missing'), path.join(root, 'file.ts')]) {
    assert.equal(await isAllowedDirectory(root, directory), false, directory);
  }
  assert.equal(await isAllowedDirectory(root, path.join(root, 'empty'), ['empty/']), false);
  assert.equal(await isAllowedFile(root, root), false);
});

test('secrets, generated files, vendor trees, binary code and symlink escapes stay out', async t => {
  const root = await fixture(t, {
    '.gitignore': '!secrets.ts\n!node_modules/\n',
    'main.ts': 'export const value = 1;',
    'secrets.ts': 'export const token = "private";',
    '.env.local.ts': 'export const password = "private";',
    'private-key.ts': 'export const key = "private";',
    'node_modules/lib/index.ts': 'export const dependency = 1;',
    'vendor/a.ts': '', 'generated/a.ts': '', 'dist/a.js': '', 'thing.min.js': '',
    'api.generated.ts': '', 'routes.gen.ts': '', 'schema.g.js': '',
    'binary.ts': '\0hidden',
  });
  const outside = await fixture(t, { 'outside.ts': 'export const outside = 1;' });
  await fs.symlink(outside, path.join(root, 'linked'));
  await fs.symlink(path.join(outside, 'outside.ts'), path.join(root, 'alias.ts'));
  assert.deepEqual(names(root, (await collectProject(root)).files), ['main.ts']);
  assert.equal(await isAllowedDirectory(root, root), true);
  for (const file of [path.join(root, 'alias.ts'), path.join(root, 'linked/outside.ts'), path.join(outside, 'outside.ts'), path.join(root, 'secrets.ts')]) {
    assert.equal(await isAllowedFile(root, file), false);
  }
  assert.equal(await readBounded(path.join(root, 'alias.ts'), 1024), undefined);
  assert.equal(await readBounded(path.join(root, 'binary.ts'), 1024), undefined);
  assert.equal(await readBounded(path.join(root, 'absent.ts'), 1024), undefined);
  assert.equal(await readBounded(path.join(root, 'main.ts'), 1), undefined);
  assert.equal(await readBounded(path.join(root, 'main.ts'), 1024), 'export const value = 1;');
});

test('a user-selected symlink root works while symlinks inside it remain excluded', async t => {
  const parent = await fixture(t, {});
  const real = await fixture(t, { 'main.ts': 'export const main = 1;' });
  const root = path.join(parent, 'selected-workspace');
  await fs.symlink(real, root);
  await fs.symlink(path.join(real, 'main.ts'), path.join(real, 'alias.ts'));
  assert.deepEqual(names(root, (await collectProject(root)).files), ['main.ts']);
  assert.equal(await isAllowedFile(root, path.join(root, 'main.ts')), true);
  assert.equal(await isAllowedFile(root, path.join(root, 'alias.ts')), false);
});

test('index refresh reads edits, adds new files, removes deleted files, and rechecks changed ignores', async t => {
  const root = await fixture(t, { 'main.ts': 'export const answer = 1;', '.gitignore': '' });
  assert.match((await collectProject(root)).files[0].text, /answer = 1/);
  await fs.writeFile(path.join(root, 'main.ts'), 'export const answer = 2;');
  await fs.writeFile(path.join(root, 'added.ts'), 'export const added = true;');
  const updated = await collectProject(root);
  assert.deepEqual(names(root, updated.files), ['added.ts', 'main.ts']);
  assert.match(updated.files.find(file => file.file.endsWith('/main.ts'))!.text, /answer = 2/);
  await fs.writeFile(path.join(root, '.gitignore'), 'added.ts\n');
  assert.equal(await isAllowedFile(root, path.join(root, 'added.ts')), false);
  assert.deepEqual(names(root, (await collectProject(root)).files), ['main.ts']);
  await fs.unlink(path.join(root, 'main.ts'));
  assert.equal(await isAllowedFile(root, path.join(root, 'main.ts')), false);
  assert.equal((await collectProject(root)).files.length, 0);
});

test('file, byte, context, and cancellation bounds are explicit', async t => {
  const root = await fixture(t, {
    'README.md': '# A project',
    'a.ts': 'export const a = 1;',
    'b.ts': 'export const b = 2;',
    'large.ts': 'x'.repeat(2048),
  });
  const limited = await collectProject(root, { maxFiles: 1 });
  assert.equal(limited.files.filter(file => /\.ts$/.test(file.file)).length, 1);
  assert.ok(names(root, limited.files).includes('README.md'));
  assert.match(limited.notes!.join('\n'), /stopped at 1 source files/);
  const smallFiles = await collectProject(root, { maxFileKB: 1 });
  assert.equal(smallFiles.files.some(file => file.file.endsWith('/large.ts')), false);
  assert.match(smallFiles.notes!.join('\n'), /per-file bound 1 KiB/);
  await assert.rejects(collectProject(root, { isCancelled: () => true }), { name: 'AbortError' });
});

test('aggregate text and documentation bounds cannot be exceeded, and traversal can be cancelled', async t => {
  const sourceFiles = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`file${String(i).padStart(2, '0')}.ts`, 'x'.repeat(1024 * 1024)]));
  const root = await fixture(t, sourceFiles);
  const project = await collectProject(root, { maxFileKB: 1024 });
  assert.equal(project.files.length, 16);
  assert.equal(project.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.text), 0), 16 * 1024 * 1024);
  assert.match(project.notes!.join('\n'), /16 MiB aggregate/);
  const docs = await fixture(t, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`docs/guide${i}.md`, '# Documentation'])));
  const documentation = await collectProject(docs);
  assert.equal(documentation.files.length, 100);
  assert.match(documentation.notes!.join('\n'), /context bound 100/);
  let cancel = false;
  await assert.rejects(collectProject(docs, { isCancelled: () => cancel, onProgress: () => { cancel = true; } }), { name: 'AbortError' });
});

test('configuration parsing resolves aliases and local inheritance using indexed files only', async t => {
  const root = await fixture(t, {
    'tsconfig.json': '{"extends":"./tsconfig.base.json","compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]},"strict":true}}',
    'tsconfig.base.json': '{"compilerOptions":{"target":"ES2022","module":"ESNext"}}',
    'src/main.ts': 'export const main = 1;',
    'docs/guide.md': '# Main is the entry point',
    'package.json': '{"name":"example"}',
    'unrelated.json': '{"password":"not-context"}',
  });
  const project = await collectProject(root);
  assert.equal(project.compilerOptions?.target, ts.ScriptTarget.ES2022);
  assert.equal(project.compilerOptions?.baseUrl, root);
  assert.deepEqual(project.compilerOptions?.paths, { '@app/*': ['src/*'] });
  assert.equal(project.compilerOptions?.strict, true);
  assert.ok(names(root, project.files).includes('docs/guide.md'));
  assert.ok(!names(root, project.files).includes('unrelated.json'));
  const outside = await fixture(t, { 'tsconfig.json': '{"compilerOptions":{"strict":false}}' });
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: path.join(outside, 'tsconfig.json') }));
  const external = await collectProject(root);
  assert.notEqual(external.compilerOptions?.strict, false);
  assert.match(external.notes!.join('\n'), /Cannot read file|not found/);
});

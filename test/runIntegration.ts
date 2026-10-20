import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { runTests } from '@vscode/test-electron';

async function main() {
const demo = await fs.mkdtemp(path.join(os.tmpdir(),'code-teach-demo-'));
try {
await fs.cp(path.resolve(__dirname,'../../demo'),demo,{recursive:true});
await runTests({
  extensionDevelopmentPath: path.resolve(__dirname, '../..'),
  extensionTestsPath: path.resolve(__dirname, 'integration.js'),
  launchArgs: [demo, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
});
} finally { await fs.rm(demo,{recursive:true,force:true}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

runTests({
  extensionDevelopmentPath: path.resolve(__dirname, '../..'),
  extensionTestsPath: path.resolve(__dirname, 'integration.js'),
  launchArgs: [path.resolve(__dirname, '../../demo'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
}).catch(error => { console.error(error); process.exitCode = 1; });

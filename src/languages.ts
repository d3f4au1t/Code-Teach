export const languageIds = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'java', 'python', 'html', 'css'];
export const sourcePattern = /\.(?:[cm]?[jt]sx?|java|py|html?|css)$/i;
export function languageFor(file: string): string {
  if (/\.java$/i.test(file)) return 'Java';
  if (/\.py$/i.test(file)) return 'Python';
  if (/\.html?$/i.test(file)) return 'HTML';
  if (/\.css$/i.test(file)) return 'CSS';
  return /\.[cm]?tsx?$/i.test(file) ? 'TypeScript' : 'JavaScript';
}

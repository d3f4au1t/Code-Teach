import { randomBytes } from 'node:crypto';
import { AnalysisQuery, Explanation, Relationship, Scope } from './model';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}

const scopes: Scope[] = ['expression', 'function', 'class', 'file', 'module', 'project'];

/** History includes the current explanation as its last entry. */
export function renderPanel(explanation: Explanation, history: Array<{ name: string; query: AnalysisQuery }>, notice?: string): string {
  const nonce = randomBytes(18).toString('base64');
  const list = (items: string[], empty: string) => items.length
    ? `<ul class="facts">${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>`
    : `<p class="muted">${empty}</p>`;
  const relationships = (items: Relationship[], direction: 'upstream' | 'downstream') => items.length
    ? `<ol class="relationships">${items.map((relation, index) => {
      const target = relation.target;
      const evidenceIndex = explanation.evidence.findIndex(source => source.file === relation.evidence.file && source.start === relation.evidence.start);
      return `<li class="relationship">
        <div class="badges"><span class="kind">${escape(relation.kind)}</span><span class="certainty ${relation.certainty === 'verified' ? 'verified' : 'inferred'}">${escape(relation.certainty)}</span></div>
        <button class="path" data-action="navigate" data-direction="${direction}" data-index="${index}" ${target ? `title="Explore ${escape(target.label)} in ${escape(target.file)}"` : 'disabled'}>${escape(target?.label || relation.evidence.label)}<span aria-hidden="true"> →</span></button>
        <p>${escape(relation.detail)}</p>
        ${!target ? '<p class="unresolved">No navigable target: dynamic behavior or code outside the indexed project.</p>' : ''}
        <div class="evidence-line">Evidence: ${evidenceIndex >= 0 ? `<button class="text-button" data-action="source" data-index="${evidenceIndex}" title="${escape(relation.evidence.file)}">${escape(basename(relation.evidence.file))}</button>` : `<span title="${escape(relation.evidence.file)}">${escape(basename(relation.evidence.file))}</span>`}</div>
      </li>`;
    }).join('')}</ol>`
    : `<p class="empty">No ${direction} relationships resolved in the current index. Runtime connections and excluded files may still exist.</p>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Code Teach — ${escape(explanation.name)}</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--vscode-editor-foreground, #d4d4d4); background: var(--vscode-editor-background, #1e1e1e); font: var(--vscode-font-size, 13px)/1.6 var(--vscode-font-family, sans-serif); }
main { max-width: 880px; margin: 0 auto; padding: 24px clamp(16px, 4vw, 40px) 40px; }
button { color: inherit; font: inherit; cursor: pointer; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, #555)); background: transparent; border-radius: 4px; padding: 5px 10px; }
button:hover { background: var(--vscode-toolbar-hoverBackground, #ffffff18); }
button:focus-visible, [tabindex="0"]:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 3px; }
button:disabled { opacity: .6; cursor: default; }
button:disabled:hover { background: transparent; }
[hidden] { display: none !important; }
a, .text-button { color: var(--vscode-textLink-foreground, #4daafc); }
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.brand { font-size: 11px; font-weight: 700; letter-spacing: .14em; }
.toolbar-actions { display: flex; gap: 8px; }
.breadcrumbs { display: flex; flex-wrap: wrap; gap: 3px 7px; list-style: none; padding: 0; margin: 16px 0 28px; }
.breadcrumbs li { display: flex; align-items: center; gap: 7px; min-width: 0; }
.breadcrumbs li:not(:last-child)::after { content: '/'; opacity: .5; }
.breadcrumbs button { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px; border: 0; }
.breadcrumbs [aria-current] { color: inherit; }
h1 { font-size: 27px; line-height: 1.25; letter-spacing: -.03em; margin: 8px 0; overflow-wrap: anywhere; }
h2 { font-size: 16px; line-height: 1.4; margin: 0 0 10px; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 8px; color: var(--vscode-descriptionForeground, #aaa); }
p { margin: 8px 0; }
.summary { font-size: 15px; margin: 14px 0; }
.muted, .evidence-line, footer, .unresolved { color: var(--vscode-descriptionForeground, #aaa); }
.kicker { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #aaa); }
.text-button { border: 0; padding: 0; text-align: left; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
.source { font-size: 12px; }
.scopes { display: flex; flex-wrap: wrap; gap: 6px; margin: 20px 0; }
.scopes button { font-size: 11px; text-transform: capitalize; padding: 3px 8px; }
.scopes [aria-pressed="true"] { background: var(--vscode-button-background, #0078d4); color: var(--vscode-button-foreground, #fff); border-color: transparent; }
section { margin-top: 26px; }
.role { border-left: 3px solid var(--vscode-textLink-foreground, #4daafc); padding: 3px 0 3px 16px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 5px; background: var(--vscode-textCodeBlock-background, #ffffff06); }
code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.fact-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: 20px; }
.facts { margin: 0; padding-left: 18px; }
.facts li + li { margin-top: 6px; }
.tablist { display: flex; gap: 8px; margin: 12px 0 0; border-bottom: 1px solid var(--vscode-panel-border, #444); }
.tablist button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 10px; }
.tablist [aria-selected="true"] { border-bottom-color: var(--vscode-textLink-foreground, #4daafc); color: var(--vscode-textLink-foreground, #4daafc); }
.count { display: inline-block; min-width: 20px; margin-left: 5px; border-radius: 12px; font-size: 11px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
.direction-help { color: var(--vscode-descriptionForeground, #aaa); margin: 12px 0; }
.relationships, .children, .sources { padding: 0; list-style: none; margin: 0; }
.relationship { padding: 16px 0; border-bottom: 1px solid var(--vscode-panel-border, #444); }
.badges { display: flex; flex-wrap: wrap; gap: 8px; font-size: 10px; letter-spacing: .03em; }
.kind { text-transform: uppercase; font-weight: 700; }
.certainty { border: 1px solid var(--vscode-panel-border, #555); border-radius: 3px; padding: 0 5px; }
.verified { color: var(--vscode-testing-iconPassed, #89d185); }
.inferred { color: var(--vscode-editorWarning-foreground, #cca700); }
.path { font-weight: 600; font-size: 14px; text-align: left; border: 0; padding: 4px 0; overflow-wrap: anywhere; }
.relationship p { margin: 3px 0 7px; }
.evidence-line, .unresolved, .empty { font-size: 12px; }
.children li, .sources li { padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border, #444); }
.children button { text-align: left; width: 100%; border: 0; padding: 3px 0; }
.children small { display: block; color: var(--vscode-descriptionForeground, #aaa); }
.notice { padding: 10px 12px; border: 1px solid var(--vscode-editorWarning-foreground, #cca700); border-radius: 4px; margin-top: 16px; }
details { margin-top: 24px; }
summary { cursor: pointer; font-weight: 600; }
details .facts { margin-top: 10px; }
footer { font-size: 11px; border-top: 1px solid var(--vscode-panel-border, #444); margin-top: 30px; padding-top: 12px; }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }
</style></head><body><main>
<header>
  <div class="toolbar"><span class="brand">CODE TEACH</span><div class="toolbar-actions"><button data-action="back" ${history.length < 2 ? 'disabled' : ''}>← Back</button><button data-action="refresh" title="Rebuild the local index and refresh this explanation">Refresh</button></div></div>
  <nav aria-label="Exploration breadcrumbs"><ol class="breadcrumbs">${history.map((entry, index) => `<li><button class="text-button" data-action="breadcrumb" data-index="${index}" ${index === history.length - 1 ? 'aria-current="page"' : ''}>${escape(entry.name)}</button></li>`).join('')}</ol></nav>
  ${notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ''}
  <span class="kicker">${escape(explanation.scope)} / ${escape(explanation.kind)}</span>
  <h1>${escape(explanation.name)}</h1>
  <button class="text-button source" data-action="source" data-index="-1" title="${escape(explanation.source.file)}">Open source · ${escape(basename(explanation.source.file))}</button>
  <p class="summary">${escape(explanation.summary)}</p>
</header>
<nav class="scopes" aria-label="Explanation scale">${scopes.map(scope => `<button data-action="scope" data-scope="${scope}" aria-pressed="${scope === explanation.scope}">${scope}</button>`).join('')}</nav>
<section class="role" aria-labelledby="role-heading"><h2 id="role-heading">Its role in this project</h2><p>${escape(explanation.role)}</p></section>
${explanation.signature ? `<section aria-label="Signature"><pre><code>${escape(explanation.signature)}</code></pre></section>` : ''}
<section class="fact-grid" aria-label="Behavior">
  <div><h3>Inputs</h3>${list(explanation.inputs, 'No inputs identified at this scale.')}</div>
  <div><h3>Outputs</h3>${list(explanation.outputs, 'No outputs identified at this scale.')}</div>
  <div><h3>Side effects</h3>${list(explanation.effects, 'No side effects identified statically. This does not prove there are none.')}</div>
</section>
<section aria-labelledby="connections-heading"><h2 id="connections-heading">Follow the connections</h2><p class="muted">Choose a path. Verified means resolved in source; inferred means a static clue, not a runtime guarantee.</p>
  <div class="tablist" role="tablist" aria-label="Connection direction"><button id="upstream-tab" role="tab" aria-selected="true" aria-controls="upstream-panel" data-tab="upstream" tabindex="0">Upstream <span class="count">${explanation.upstream.length}</span></button><button id="downstream-tab" role="tab" aria-selected="false" aria-controls="downstream-panel" data-tab="downstream" tabindex="-1">Downstream <span class="count">${explanation.downstream.length}</span></button></div>
  <div id="upstream-panel" role="tabpanel" aria-labelledby="upstream-tab" tabindex="0"><p class="direction-help">What calls this, triggers it, or supplies its inputs?</p>${relationships(explanation.upstream, 'upstream')}</div>
  <div id="downstream-panel" role="tabpanel" aria-labelledby="downstream-tab" tabindex="0" hidden><p class="direction-help">What does this call, affect, or pass its results to?</p>${relationships(explanation.downstream, 'downstream')}</div>
</section>
${explanation.children.length ? `<section aria-labelledby="children-heading"><h2 id="children-heading">Explore inside</h2><ul class="children">${explanation.children.map((child, index) => `<li><button data-action="child" data-index="${index}" title="${escape(child.file)}">${escape(child.label)} <span aria-hidden="true">→</span><small>${escape(basename(child.file))}</small></button></li>`).join('')}</ul></section>` : ''}
${explanation.evidence.length ? `<section aria-labelledby="evidence-heading"><h2 id="evidence-heading">Source evidence</h2><ul class="sources">${explanation.evidence.map((source, index) => `<li><button class="text-button" data-action="source" data-index="${index}" title="${escape(source.file)}">${escape(source.label)} · ${escape(basename(source.file))}</button></li>`).join('')}</ul></section>` : ''}
${explanation.notes.length ? `<details open><summary>What this analysis can and cannot establish</summary>${list(explanation.notes, '')}</details>` : ''}
<footer>Local analysis · No code sent to external AI<br>${explanation.stats.files} indexed files · ${Math.round(explanation.stats.elapsedMs)} ms${explanation.stats.cached ? ' · cached result' : ''}</footer>
</main><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
function selectTab(direction, focus) {
  document.querySelectorAll('[data-tab]').forEach(tab => {
    const selected = tab.dataset.tab === direction;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  });
}
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.tab) { selectTab(button.dataset.tab, false); return; }
  const action = button.dataset.action;
  if (!action) return;
  const message = { action };
  if (button.dataset.index !== undefined) message.index = Number(button.dataset.index);
  if (button.dataset.direction) message.direction = button.dataset.direction;
  if (button.dataset.scope) message.scope = button.dataset.scope;
  vscode.postMessage(message);
});
document.addEventListener('keydown', event => {
  if (!event.target.closest('[role="tab"]')) return;
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const direction = event.key === 'Home' ? 'upstream' : event.key === 'End' ? 'downstream' : event.target.dataset.tab === 'upstream' ? 'downstream' : 'upstream';
    selectTab(direction, true);
  }
});
</script></body></html>`;
}

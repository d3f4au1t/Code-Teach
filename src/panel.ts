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
export function renderPanel(explanation: Explanation, history: Array<{ name: string; query: AnalysisQuery }>, notice?: string, revision = 0): string {
  const nonce = randomBytes(18).toString('base64');
  const list = (items: string[], empty: string) => items.length
    ? `<ul class="facts">${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>`
    : `<p class="muted">${empty}</p>`;
  const mapColumn = (direction: 'upstream' | 'downstream') => {
    const candidates = explanation[direction].map((edge, index) => ({edge, index}));
    const calls = candidates.filter(({edge}) => edge.kind === (direction === 'upstream' ? 'caller' : 'callee'));
    const edges = calls.length ? calls : candidates;
    return `<div class="map-column ${direction}"><h3>${direction === 'upstream' ? 'Upstream' : 'Downstream'}</h3><p class="map-help">${direction === 'upstream' ? 'Calls or supplies this code' : 'Called or affected by this code'}</p><ul class="tree-branches">${edges.slice(0, 4).map(({edge, index}) => `<li><button class="map-node" data-action="navigate" data-direction="${direction}" data-index="${index}" ${edge.target ? '' : 'disabled'}><span class="node-meta">${escape(edge.kind)} <span class="certainty ${edge.certainty === 'verified' ? 'verified' : 'inferred'}">${escape(edge.certainty)}</span></span><strong>${escape(edge.target?.label ?? edge.evidence.label)}</strong><small>${escape(basename(edge.target?.file ?? edge.evidence.file))}</small></button></li>`).join('') || '<li class="map-empty">No source paths found here.</li>'}</ul>${edges.length > 4 ? `<small>+ ${edges.length - 4} more in the path list</small>` : ''}</div>`;
  };
  const chapter = (number: string, title: string, id: string, description: string) => `<div class="chapter-heading"><span class="chapter-number" aria-hidden="true">${number}</span><div><h2 id="${id}">${title}</h2><p class="muted">${description}</p></div></div>`;
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
body {
  color-scheme: light dark;
  --page: var(--vscode-editor-background, #111520);
  --ink: var(--vscode-editor-foreground, #e5eaf5);
  --muted: var(--vscode-descriptionForeground, #acb7cc);
  --ochre: #e0bb76; --blue: #87bbd5; --green: #91c7a4; --amber: #e0bb76; --rose: #dc9990;
  --surface: color-mix(in srgb, var(--page) 94%, var(--ink));
  --border: color-mix(in srgb, var(--ink) 20%, var(--page));
}
body.vscode-light { --ochre: #8a581b; --blue: #256689; --green: #326d4b; --amber: #8a581b; --rose: #a04439; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: var(--page); font: var(--vscode-font-size, 13px)/1.6 var(--vscode-font-family, system-ui, sans-serif); }
main { max-width: 1080px; margin: 0 auto; padding: 20px clamp(16px, 3vw, 36px) 36px; }
button { color: inherit; font: inherit; cursor: pointer; border: 1px solid var(--border); background: var(--surface); border-radius: 2px; padding: 5px 10px; }
button:hover { background: color-mix(in srgb, var(--ink) 10%, var(--page)); border-color: var(--accent, var(--ochre)); }
button:focus-visible, summary:focus-visible, [tabindex="0"]:focus-visible { outline: 2px solid var(--vscode-focusBorder, var(--blue)); outline-offset: 3px; }
button:disabled { opacity: .55; cursor: default; }
[hidden] { display: none !important; }
.toolbar, .toolbar-actions, .brand, .chapter-heading, .title-meta { display: flex; align-items: center; gap: 10px; }
.toolbar { justify-content: space-between; flex-wrap: wrap; }
.brand { font: 600 11px var(--vscode-editor-font-family, ui-monospace, monospace); letter-spacing: .04em; }
.brand-mark { color: var(--ochre); font: 600 18px monospace; }
.toolbar-actions { gap: 6px; }
.toolbar-actions button { font-size: 12px; }
.breadcrumbs { display: flex; flex-wrap: wrap; gap: 4px 8px; list-style: none; padding: 0; margin: 16px 0; font-size: 12px; }
.breadcrumbs li { display: flex; align-items: center; gap: 8px; min-width: 0; }
.breadcrumbs li:not(:last-child)::after { content: '›'; color: var(--muted); }
.breadcrumbs button { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.breadcrumbs [aria-current] { color: var(--ochre); }
h1 { font: 600 clamp(24px, 3.5vw, 34px)/1.3 var(--vscode-editor-font-family, ui-monospace, monospace); letter-spacing: -.03em; margin: 12px 0 8px; overflow-wrap: anywhere; }
h2 { font-size: 18px; line-height: 1.4; margin: 0; font-weight: 650; }
h3 { font-size: 12px; margin: 0; }
p { margin: 8px 0; overflow-wrap: anywhere; }
.muted, .evidence-line, footer, .unresolved, .map-help { color: var(--muted); }
.text-button { color: var(--blue); border: 0; background: transparent; padding: 0; text-align: left; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
.text-button:hover { background: transparent; color: var(--ink); }
.lesson-title { border-top: 3px solid var(--ochre); padding: 18px 0 4px; }
.title-meta { justify-content: space-between; flex-wrap: wrap; }
.kicker { font: 11px var(--vscode-editor-font-family, ui-monospace, monospace); color: var(--ochre); }
.local-note { color: var(--muted); font-size: 10px; }
.summary { font-size: 15px; line-height: 1.7; max-width: 70ch; margin: 12px 0; }
.source { font-size: 12px; }
.scopes { display: flex; flex-wrap: wrap; gap: 0; margin: 12px 0 22px; border-bottom: 1px solid var(--border); }
.scopes button { font-size: 11px; text-transform: capitalize; padding: 6px 9px; background: transparent; border: 0; border-bottom: 2px solid transparent; border-radius: 0; }
.scopes [aria-pressed="true"] { color: var(--ochre); border-bottom-color: var(--ochre); }
.role { display: grid; grid-template-columns: 3px minmax(0, 1fr); gap: 14px; margin: 18px 0 26px; }
.role::before { content: ''; background: var(--ochre); }
.role h2 { font-size: 14px; color: var(--ochre); }
.role p { margin-bottom: 0; }
.lesson-section { --accent: var(--blue); border-top: 1px solid var(--border); margin: 28px 0; padding: 20px 0 0; }
.lesson-section.behavior { --accent: var(--amber); }
.lesson-section.walkthrough { --accent: var(--ochre); }
.lesson-section.examples { --accent: var(--green); }
.lesson-section.paths { --accent: var(--rose); }
.lesson-section.structure { --accent: var(--amber); }
.chapter-heading { gap: 12px; align-items: baseline; margin-bottom: 18px; }
.chapter-heading > div { min-width: 0; }
.chapter-heading p { font-size: 12px; margin: 5px 0 0; }
.chapter-number { flex: 0 0 24px; color: var(--accent); font: 600 12px var(--vscode-editor-font-family, ui-monospace, monospace); }
.connection-map { display: grid; grid-template-columns: minmax(0, 1fr) 24px minmax(0, 1fr) 24px minmax(0, 1fr); gap: 0; align-items: center; margin: 24px 0 8px; }
.map-column { min-width: 0; --branch: var(--blue); }
.map-column.downstream { --branch: var(--green); }
.map-column h3 { color: var(--branch); text-transform: uppercase; letter-spacing: .1em; font-size: 10px; }
.map-help { font-size: 11px; margin: 4px 0 14px; }
.tree-branches { padding: 0; margin: 0; list-style: none; }
.tree-branches li { position: relative; padding: 5px 0; }
.upstream .tree-branches { border-right: 2px solid color-mix(in srgb, var(--blue) 50%, var(--page)); padding-right: 14px; }
.downstream .tree-branches { border-left: 2px solid color-mix(in srgb, var(--green) 50%, var(--page)); padding-left: 14px; }
.tree-branches li::before { content: ''; position: absolute; top: 50%; width: 14px; height: 2px; background: color-mix(in srgb, var(--branch) 50%, var(--page)); }
.upstream .tree-branches li::before { right: -14px; }
.downstream .tree-branches li::before { left: -14px; }
.map-node { width: 100%; text-align: left; padding: 10px; border: 1px solid color-mix(in srgb, var(--branch, var(--ochre)) 40%, var(--page)); background: color-mix(in srgb, var(--branch, var(--ochre)) 7%, var(--page)); border-radius: 0; overflow-wrap: anywhere; }
.map-node strong, .map-node small { display: block; }
.map-node strong { font: 600 12px/1.5 var(--vscode-editor-font-family, ui-monospace, monospace); margin: 5px 0; }
.map-node small { font-size: 10px; color: var(--muted); }
.node-meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; color: var(--branch, var(--ochre)); font-size: 10px; }
.map-current { --branch: var(--ochre); padding: 16px 12px; border: 2px solid var(--ochre); }
.map-current .node-meta { text-transform: uppercase; letter-spacing: .08em; }
.map-current strong { font-size: 16px; }
.map-arrow { text-align: center; color: var(--ochre); font-size: 20px; }
.map-empty { color: var(--muted); font-size: 11px; }
.tree-key { display: flex; flex-wrap: wrap; gap: 14px; font-size: 10px; color: var(--muted); margin-top: 20px; }
.tree-key span::before { content: ''; width: 16px; height: 2px; vertical-align: middle; display: inline-block; margin-right: 5px; background: var(--blue); }
.tree-key span:nth-child(2)::before { background: var(--ochre); }
.tree-key span:nth-child(3)::before { background: var(--green); }
table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; overflow-wrap: anywhere; }
caption { text-align: left; font-size: 12px; color: var(--muted); padding: 8px 0; }
th, td { text-align: left; vertical-align: top; padding: 12px; border-bottom: 1px solid var(--border); }
tr:last-child > * { border-bottom: 0; }
th { font-size: 12px; }
.io-table { border-top: 2px solid var(--amber); border-bottom: 1px solid var(--border); background: var(--page); }
.io-table th { width: 26%; background: color-mix(in srgb, var(--blue) 8%, var(--page)); color: var(--blue); }
.io-table tr:nth-child(2) th { background: color-mix(in srgb, var(--green) 8%, var(--page)); color: var(--green); }
.io-table tr:nth-child(3) th { background: color-mix(in srgb, var(--rose) 8%, var(--page)); color: var(--rose); }
.io-table th small { display: block; color: var(--muted); font-weight: 400; font-size: 10px; }
.io-table p { margin: 0; }
.facts { margin: 0; padding-left: 17px; }
.facts li + li { margin-top: 6px; }
.step-controls { display: flex; gap: 7px; flex-wrap: wrap; margin: 16px 0; }
.step-controls button { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; text-align: left; padding: 7px 9px; max-width: 100%; }
.step-controls button span { color: var(--ochre); font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-weight: 700; }
.step-controls [aria-pressed="true"] { border-color: var(--ochre); border-bottom-width: 3px; background: color-mix(in srgb, var(--ochre) 8%, var(--page)); }
.step-card { --step-color: var(--blue); border: 1px solid var(--border); border-radius: 0; overflow: hidden; background: var(--page); }
.step-card[data-kind="branch"], .step-card[data-kind="loop"] { --step-color: var(--amber); }
.step-card[data-kind="return"] { --step-color: var(--green); }
.step-card[data-kind="effect"] { --step-color: var(--rose); }
.step-card[data-kind="declaration"] { --step-color: var(--ochre); }
.step-card-header { padding: 15px 18px; background: color-mix(in srgb, var(--step-color) 9%, var(--page)); border-bottom: 1px solid var(--border); }
.step-card h3 { font-size: 16px; margin-top: 5px; }
.step-label { color: var(--step-color); font-size: 10px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
.step-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .85fr); }
.step-code, .step-explanation { min-width: 0; padding: 18px; }
.step-code { border-right: 1px solid var(--border); }
.step-explanation { background: color-mix(in srgb, var(--step-color) 3%, var(--page)); }
.cell-label { display: block; font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .1em; margin-bottom: 8px; font-weight: 650; }
.step-explanation p { font-size: 14px; }
.step-footer { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--border); font-size: 11px; }
.step-footer div { display: flex; gap: 6px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0; padding: 14px; border: 1px solid var(--border); border-radius: 0; background: var(--page); }
code { font: 12px/1.8 var(--vscode-editor-font-family, ui-monospace, monospace); color: var(--blue); }
.step-code pre { padding: 0; margin: 0; border: 0; background: transparent; }
.example { border-left: 2px solid var(--green); margin-top: 22px; padding: 0 0 0 16px; }
.example-label { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.example-label strong { color: var(--green); font-size: 11px; }
.example th { background: color-mix(in srgb, var(--green) 10%, var(--page)); color: var(--green); }
.example tbody tr:nth-child(even) { background: var(--surface); }
.example td:first-child code { color: var(--ochre); }
.example .muted { font-size: 11px; margin-bottom: 0; }
.tablist { display: flex; gap: 0; margin-top: 18px; border-bottom: 1px solid var(--border); }
.tablist button { --accent: var(--blue); border-radius: 0; border: 0; border-bottom: 2px solid transparent; background: transparent; text-align: left; }
.tablist button[data-tab="downstream"] { --accent: var(--green); }
.tablist [aria-selected="true"] { border-bottom-color: var(--accent); color: var(--accent); }
.count { display: inline-block; margin-left: 6px; font: 11px var(--vscode-editor-font-family, ui-monospace, monospace); color: var(--muted); }
.direction-help { color: var(--muted); font-size: 12px; margin: 16px 0; }
.relationships, .children, .sources { padding: 0; list-style: none; margin: 0; }
.relationship { border-bottom: 1px solid var(--border); border-left: 2px solid var(--blue); padding: 12px 14px; margin-top: 14px; }
#downstream-panel .relationship { border-left-color: var(--green); }
.badges { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 10px; }
.kind { text-transform: uppercase; font-weight: 750; letter-spacing: .07em; color: var(--blue); }
#downstream-panel .kind { color: var(--green); }
.certainty { font-size: 10px; font-style: italic; }
.verified { color: var(--green); }
.inferred { color: var(--amber); }
.path { font-weight: 650; font-size: 15px; text-align: left; border: 0; background: transparent; padding: 7px 0; overflow-wrap: anywhere; }
.relationship p { margin: 3px 0 8px; font-size: 12px; }
.evidence-line, .unresolved, .empty { font-size: 11px; }
.children { margin: 12px 0 0 9px; padding-left: 18px; border-left: 2px solid color-mix(in srgb, var(--amber) 45%, var(--page)); }
.children li { position: relative; padding: 5px 0; }
.children li::before { content: ''; position: absolute; width: 18px; height: 2px; top: 50%; left: -18px; background: color-mix(in srgb, var(--amber) 45%, var(--page)); }
.children button { text-align: left; width: 100%; padding: 10px 13px; background: var(--page); overflow-wrap: anywhere; }
.children small { display: block; color: var(--muted); font-size: 11px; }
.sources li { padding: 9px 0; border-bottom: 1px solid var(--border); }
.notice { padding: 12px; border: 1px solid var(--amber); border-radius: 0; background: color-mix(in srgb, var(--amber) 8%, var(--page)); }
details { margin-top: 14px; padding: 13px 0; border-bottom: 1px solid var(--border); }
summary { cursor: pointer; font-weight: 600; font-size: 12px; }
details[open] > summary { margin-bottom: 12px; color: var(--ochre); }
footer { font-size: 10px; border-top: 1px solid var(--border); margin-top: 26px; padding-top: 14px; }
@media (max-width: 680px) {
  .connection-map { grid-template-columns: minmax(0, 1fr); }
  .map-current { width: calc(100% - 20px); margin-left: 20px; }
  .map-arrow { height: 32px; width: 30px; margin-left: 22px; transform: rotate(90deg); }
  .upstream .tree-branches { border-right: 0; border-left: 2px solid color-mix(in srgb, var(--blue) 50%, var(--page)); padding-right: 0; padding-left: 14px; }
  .upstream .tree-branches li::before { right: auto; left: -14px; }
  .step-body { grid-template-columns: minmax(0, 1fr); }
  .step-code { border-right: 0; border-bottom: 1px solid var(--border); }
}
@media (max-width: 400px) {
  main { padding: 14px 10px; }
  .lesson-section { padding-top: 16px; }
  .io-table th { width: 32%; }
  th, td { padding: 10px 8px; }
  .step-controls button { flex: 1 1 100%; }
  .tablist button { padding: 6px 8px; }
}
@media (forced-colors: active) {
  .lesson-title, .lesson-section, .map-node, .step-card, .example { background: Canvas; color: CanvasText; border-color: CanvasText; }
  .chapter-number, .brand-mark, .certainty { color: CanvasText; border: 1px solid CanvasText; }
  .tree-branches, .children { border-color: CanvasText; }
  .tree-branches li::before, .children li::before { background: CanvasText; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }
</style></head><body data-revision="${revision}" data-symbol="${escape(explanation.id)}"><main>
<header>
  <div class="toolbar"><span class="brand"><span class="brand-mark" aria-hidden="true">{ }</span>CODE TEACH</span><div class="toolbar-actions"><button data-action="back" ${history.length < 2 ? 'disabled' : ''}>← Back</button><button data-action="refresh" title="Rebuild the local index and refresh this explanation">Refresh</button></div></div>
  <nav aria-label="Exploration breadcrumbs"><ol class="breadcrumbs">${history.map((entry, index) => `<li><button class="text-button" data-action="breadcrumb" data-index="${index}" ${index === history.length - 1 ? 'aria-current="page"' : ''}>${escape(entry.name)}</button></li>`).join('')}</ol></nav>
  ${notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ''}
  <div class="lesson-title"><div class="title-meta"><span class="kicker">Code lesson / ${escape(explanation.scope)}</span><span class="local-note">Local · source-backed</span></div>
  <h1>${escape(explanation.name)}</h1>
  <button class="text-button source" data-action="source" data-index="-1" title="${escape(explanation.source.file)}">Open source · ${escape(basename(explanation.source.file))}</button>
  <p class="summary">${escape(explanation.summary)}</p></div>
</header>
<nav class="scopes" aria-label="Explanation scale">${scopes.map(scope => `<button data-action="scope" data-scope="${scope}" aria-pressed="${scope === explanation.scope}">${scope}</button>`).join('')}</nav>
<section class="role" aria-labelledby="role-heading"><div><h2 id="role-heading">Its role in this project</h2><p>${escape(explanation.role)}</p></div></section>
<section class="lesson-section" aria-labelledby="map-heading">${chapter('01', 'Where this connects', 'map-heading', 'Choose a branch to explore. Arrows show source connections, not execution order.')}<div class="connection-map" role="group" aria-label="Connection tree">${mapColumn('upstream')}<span class="map-arrow" aria-hidden="true">→</span><div class="map-node map-current"><span class="node-meta">You are here</span><strong>${escape(explanation.name)}</strong><small>${escape(explanation.scope)} · ${escape(basename(explanation.source.file))}</small></div><span class="map-arrow" aria-hidden="true">→</span>${mapColumn('downstream')}</div><div class="tree-key" aria-hidden="true"><span>Upstream paths</span><span>This code</span><span>Downstream paths</span></div></section>
<section class="lesson-section behavior" aria-labelledby="behavior-heading">${chapter('02', 'What goes in. What comes out.', 'behavior-heading', 'A quick reference to the behavior identified in source.')}<table class="io-table"><caption>Inputs, outputs & side effects</caption><tbody><tr><th scope="row">Inputs<small>What it receives</small></th><td>${list(explanation.inputs, 'No inputs identified at this scale.')}</td></tr><tr><th scope="row">Outputs<small>What it gives back</small></th><td>${list(explanation.outputs, 'No outputs identified at this scale.')}</td></tr><tr><th scope="row">Side effects<small>What else changes</small></th><td>${list(explanation.effects, 'No side effects identified statically. This does not prove there are none.')}</td></tr></tbody></table>${explanation.signature ? `<details><summary>Declaration & types</summary><pre><code>${escape(explanation.signature)}</code></pre></details>` : ''}</section>
${explanation.steps.length ? `<section class="lesson-section walkthrough" aria-labelledby="steps-heading">${chapter('03', 'Read it step by step', 'steps-heading', 'One source idea at a time. Select a step to pair the code with its explanation.')}<div class="step-controls" aria-label="Source steps">${explanation.steps.map((step, index) => `<button data-step="${index}" aria-pressed="${index === 0}" title="${escape(step.title)}"><span>${index + 1}</span>${escape(step.title)}</button>`).join('')}</div>${explanation.steps.map((step, index) => `<article class="step-card" data-kind="${escape(step.kind)}" data-step-card="${index}" ${index ? 'hidden' : ''}><div class="step-card-header"><span class="step-label">Step ${index + 1} / ${explanation.steps.length} · ${escape(step.kind)}</span><h3>${escape(step.title)}</h3></div><div class="step-body"><div class="step-code"><span class="cell-label">The code · line ${step.source.line ?? '?'}</span><pre><code>${escape(step.code)}</code></pre></div><div class="step-explanation"><span class="cell-label">What this means</span><p>${escape(step.detail)}</p></div></div><div class="step-footer"><button class="text-button" data-action="step" data-index="${index}">Show line ${step.source.line ?? '?'} in source</button><div><button data-step="${index - 1}" ${index === 0 ? 'disabled' : ''} aria-label="Previous source step">←</button><button data-step="${index + 1}" ${index === explanation.steps.length - 1 ? 'disabled' : ''} aria-label="Next source step">→</button></div></div></article>`).join('')}</section>` : ''}
${explanation.examples.length ? `<section class="lesson-section examples" aria-labelledby="examples-heading">${chapter('04', 'See a real call', 'examples-heading', 'Concrete source examples. Match each supplied argument to the parameter that receives it.')}${explanation.examples.map((example, index) => `<div class="example"><div class="example-label"><strong>EXAMPLE ${String(index + 1).padStart(2, '0')}</strong><button class="text-button" data-action="example" data-index="${index}">${escape(basename(example.source.file))} · line ${example.source.line ?? '?'}</button></div><pre><code>${escape(example.code)}</code></pre>${example.bindings.length ? `<table><caption>How the written arguments enter this function</caption><thead><tr><th scope="col">Parameter inside this function</th><th scope="col">Argument supplied by the caller</th></tr></thead><tbody>${example.bindings.map(binding => `<tr><td><code>${escape(binding.parameter)}</code></td><td><code>${escape(binding.argument)}</code></td></tr>`).join('')}</tbody></table>` : ''}<p class="muted">${escape(example.note)}</p></div>`).join('')}</section>` : ''}
${explanation.sourceCode ? `<details><summary>Read the source together</summary><pre><code>${escape(explanation.sourceCode)}</code></pre></details>` : ''}
<section class="lesson-section paths" aria-labelledby="connections-heading">${chapter('↗', 'Follow the connections', 'connections-heading', 'All available paths. Verified means resolved in source; inferred is a clue, not a runtime guarantee.')}
  <div class="tablist" role="tablist" aria-label="Connection direction"><button id="upstream-tab" role="tab" aria-selected="true" aria-controls="upstream-panel" data-tab="upstream" tabindex="0">Upstream <span class="count">${explanation.upstream.length}</span></button><button id="downstream-tab" role="tab" aria-selected="false" aria-controls="downstream-panel" data-tab="downstream" tabindex="-1">Downstream <span class="count">${explanation.downstream.length}</span></button></div>
  <div id="upstream-panel" role="tabpanel" aria-labelledby="upstream-tab" tabindex="0"><p class="direction-help">What calls this, triggers it, or supplies its inputs?</p>${relationships(explanation.upstream, 'upstream')}</div>
  <div id="downstream-panel" role="tabpanel" aria-labelledby="downstream-tab" tabindex="0" hidden><p class="direction-help">What does this call, affect, or pass its results to?</p>${relationships(explanation.downstream, 'downstream')}</div>
</section>
${explanation.children.length ? `<section class="lesson-section structure" aria-labelledby="children-heading">${chapter('↓', 'Explore inside', 'children-heading', 'Open a child to move from the bigger picture into concrete code.')}<ul class="children">${explanation.children.map((child, index) => `<li><button data-action="child" data-index="${index}" title="${escape(child.file)}">${escape(child.label)} <span aria-hidden="true">→</span><small>${escape(basename(child.file))}</small></button></li>`).join('')}</ul></section>` : ''}
${explanation.evidence.length ? `<details><summary>Source evidence</summary><ul class="sources">${explanation.evidence.map((source, index) => `<li><button class="text-button" data-action="source" data-index="${index}" title="${escape(source.file)}">${escape(source.label)} · ${escape(basename(source.file))}</button></li>`).join('')}</ul></details>` : ''}
${explanation.notes.length ? `<details><summary>Limits & analysis notes (${explanation.notes.length})</summary>${list(explanation.notes, '')}</details>` : ''}
<footer>Local analysis · No code sent to external AI<br>${explanation.stats.files} indexed files · ${Math.round(explanation.stats.elapsedMs)} ms${explanation.stats.cached ? ' · cached result' : ''}</footer>
</main><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const state = { symbol: document.body.dataset.symbol, direction: saved.direction === 'downstream' ? 'downstream' : 'upstream', step: saved.symbol === document.body.dataset.symbol && Number.isInteger(saved.step) ? saved.step : 0 };
function selectTab(direction, focus) {
  document.querySelectorAll('[data-tab]').forEach(tab => {
    const selected = tab.dataset.tab === direction;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  });
  state.direction = direction;
  vscode.setState(state);
}
function selectStep(index) {
  const cards = document.querySelectorAll('[data-step-card]');
  const selected = Math.max(0, Math.min(index, cards.length - 1));
  cards.forEach(card => { card.hidden = Number(card.dataset.stepCard) !== selected; });
  document.querySelectorAll('.step-controls [data-step]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.step) === selected)));
  state.step = selected;
  vscode.setState(state);
}
selectTab(state.direction, false);
selectStep(state.step);
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.tab) { selectTab(button.dataset.tab, false); return; }
  if (button.dataset.step !== undefined) { selectStep(Number(button.dataset.step)); return; }
  const action = button.dataset.action;
  if (!action) return;
  const message = { action, revision: Number(document.body.dataset.revision) };
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

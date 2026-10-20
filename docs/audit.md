# Code Teach 0.2.0 feature audit

Audited on 2026-10-20 against the original feature request and the 0.1.0 implementation. The review covered every source module, the extension manifest, packaging, demo, tests, documentation, privacy boundary, and measured workloads. This is a scoped engineering audit, not a security certification.

## Outcome

The complete exploration flow passes in the real VS Code extension host: **hover checkout → open explanation → inspect source steps and caller arguments → visit checkoutRoute → Back → visit calculateTotal in another package → Back**. Unsaved caller edits and saved inherited compiler-configuration edits refresh the open panel automatically. The richer panel also passed an interactive browser preview review, including a 380 px layout with no horizontal overflow.

The main teaching improvement is concrete evidence alongside prose: a clickable connection map, short source steps, source-line selection, and real call examples mapping arguments into parameters. The extension still does not execute project code or send it to an AI service.

## Findings fixed

| Severity | Reproduction / previous problem | Fix and verification |
| --- | --- | --- |
| High | `const price = 12; const order = {price}` lost the value-to-consumer connection because the shorthand property symbol was treated as the supplied variable. | Resolve the shorthand value symbol. Regression checks both upstream data source and downstream consumer. |
| High | An array storing `() => { count++; write(); }` attributed that deferred callback's calls and writes to construction of the array. | Respect enclosing callable boundaries for expression/initializer analysis. Regression verifies no false callee or outer write. |
| Medium | `const pick = () => plus(1)` omitted `pick` as a consumer of `plus`'s returned value. | Recognize concise-arrow return consumers. Dedicated regression passes. |
| Medium | Saving `tsconfig.base.json` left aliases/options stale because only the exact root configuration filenames triggered recollection. | Recognize indexed compiler-configuration variants. Real extension-host test changes an inherited alias to another implementation and waits for automatic navigation refresh. |
| Medium | Delayed messages from an old panel could use an index against a different, newly rendered relationship list. | Attach a render revision to messages; reject mismatches before looking up targets. Real-host test sends an old Back message after navigation and verifies it is ignored. |
| Medium | Manual refresh and an already scheduled disk refresh could unnecessarily clear/rebuild the panel twice. | Cancel pending refresh timers when a refresh starts. Exercised during configuration-refresh integration testing. |
| Medium | Initial indexing normalized user limits, but later editor updates used raw settings. Invalid/fractional settings could apply different bounds. | Share one normalization function between indexing and edits; test non-finite, negative, and excessive values. |
| Usability | Explanation was dominated by prose and signatures; there was no small source lesson or concrete input example. | Add bounded steps, argument tables, a map, and source previews. Test source spans, omitted/default/rest/spread arguments and type-only `this`, deferred definitions, branches, loops, updates, and HTML escaping. |
| Usability | Direction and step selection were lost on HTML refresh. | Persist direction and the current step for the same symbol location through webview state. Verified in script tests and the browser preview. |

The first three analysis regressions were reproduced as failing tests before their fixes. Teaching tests likewise failed before the new fields were populated. Changes are in `src/analyzer.ts`, `src/teaching.ts`, `src/workspace.ts`, `src/extension.ts`, and `src/panel.ts`.

## Feature-by-feature result

| Requested capability | Result and practical boundary |
| --- | --- |
| Concise hover with purpose, inputs, output, effects, and project role | Supported for indexed JS/TS symbols. Hover includes short source snippets and links to Explain more. Purpose comes from labeled source documentation or syntax; no invented business intent. Only relevant detected effects appear in hover. |
| Persistent deeper explanation | Supported. Source steps and real call-site inputs lead; signatures, full source, facts, evidence, and notes are expandable. No project execution. |
| Upstream / Downstream with multiple choices | Supported. Precise caller, callee, data source, consumer, import, and reference labels; unresolved paths remain visible. Map previews up to four call/import paths; lists show the other relationship kinds. |
| Cross-file/package navigation, breadcrumbs, Back | Supported within one indexed workspace root. Verified through the real webview message handler and actual editor selections. External vendor implementations and cross-root relationships remain outside scope. |
| Recursion and circular imports | Supported without recursive expansion. Each user choice opens one result; repeated history locations collapse. Tests cover cycles and bounded fan-out. |
| Definitions, references, types, tests, docs, configuration | Supported within index bounds. Root configuration and eligible local inheritance supply aliases. Tests/documents are source evidence, not proof of execution, coverage, or correct author intent. |
| Verified vs inferred | Source-resolved edges are labeled verified; unresolved runtime targets are inferred. Array-pattern teaching explicitly assumes the standard method. Dynamic callbacks, event dispatch, reflection, and actual branch outcomes are not established. |
| Expression, function, class, file, module, project | Supported with meaningful-source selection and drill-down. A module is the nearest indexed package or directory. The project overview maps imports and documented context; it does not synthesize a whole feature architecture. Walkthroughs are shallow statement lessons, not a debugger. |
| Incremental indexing, retrieval, caching, edits | Bounded first collection, unchanged AST reuse, worker analysis, 128-query LRU. Edits invalidate results and rebuild semantic links across indexed files on demand. Dependency-specific semantic invalidation is not implemented. |
| Progress, cancellation, editor responsiveness | Explicit operations show cancellable progress. Queued work is removed on cancellation; active synchronous TypeScript computation finishes in its worker and its canceled result is discarded. Main-thread timer evidence is documented; native frame rate is unmeasured. |
| Read-only source, exclusions, AI transparency | Extension reads/selects source only. Ignore rules, secrets/generated/vendor path defaults, symlinks, byte/file bounds, and edit-policy parity are tested. No external AI mode, network code, or remote panel resources. Secret detection is path-based, not content-based. |
| Accessible, compact UI | Semantic controls, keyboard tabs, focus styles, theme colors, CSP, escaped source text, narrow layout, and state restoration checked. Native screen-reader and keyboard walkthroughs remain unverified. |
| Runnable package and setup | Version 0.2.0 includes the worker and local runtime dependencies. README contains installation/F5 setup; docs/demo.md contains the full walkthrough. |

## Validation evidence

- `npm test`: **46 passed**, including analysis, edit invalidation, worker transport, history, policy bounds, richer teaching, and panel injection/CSP/state behavior.
- `npm run test:integration`: passed on VS Code **1.142.0 / macOS arm64**. It runs on a temporary copy of the demo so tests cannot leave the user's demo source altered. Navigation tests use the same message handler as the real panel; browser interaction checks cover message generation and controls separately.
- Demo TypeScript compilation: passed with `tsc --noEmit -p demo`.
- `npm audit`: **0 known vulnerabilities**, including development dependencies, at audit time.
- Interactive browser preview: caller/dependency/Back navigation, numbered steps, direction persistence, source content, and narrow layout checked. [Screenshot](panel-demo.png) shows the actual renderer in the preview, not native VS Code.
- Native visual demo was blocked by the Mac lock screen. The user was asked to unlock it; automated extension-host checks continued successfully. No claim of native visual sign-off.
- Performance: repeated dense synthetic run (1,000 files / 9.75 MB) measured **2.52 s cold analysis, 1.29 s after an edit, and 3.11 s cold worker round trip**. An earlier long pause is preserved and disclosed. See [performance methodology and raw data](performance.md); these are not arbitrary-repository latency guarantees.

## Remaining limits and priorities

1. Large-project edits still rebuild semantic links globally. At the measured dense workload, the next query takes about a second after an edit; active cancellation does not interrupt that calculation. Dependency-scoped invalidation is the next performance investment if needed.
2. Standard libraries and external package implementations are excluded. Some types stay unknown; array explanations use explicitly labeled source patterns rather than loading or executing dependencies.
3. Call-site examples stop at written arguments. They do not propagate values across an entire program, evaluate test inputs, execute callbacks, or predict which branch runs. Nested blocks can be explored by selecting their concrete code; the walkthrough does not flatten them into a misleading runtime trace.
4. Only the root compiler configuration governs resolution. Nested monorepo configurations, every export/bundler condition, and all architectures are not supported. Filename-based secret exclusions cannot detect credentials embedded in ordinary eligible source files.
5. Windows, Linux, the declared minimum VS Code 1.95, native screen readers, the 5,000-file setting, and a full 16 MiB semantic workload have not been tested.
6. Panel direction persists across visits; step retention is for the same symbol location. Structural edits that move a symbol can reset its selected step. Source previews and relation lists are intentionally bounded, with notes for omissions.

No GitHub remote is configured, so there is no upstream state to pull or destination to push. The audit and fixes are retained in the local repository.

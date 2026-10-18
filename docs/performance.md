# Performance and supported limits

Measured on 2026-10-17, Apple M3, macOS arm64, Node 22.22.2. Run `npm run benchmark` to reproduce. Raw observations are in [benchmark-results.json](benchmark-results.json). These are synthetic fixtures, not production-repository latency promises.

| Fixture | Source bytes | Cold analysis | Cached p95 | Analysis after edit | Cold worker round trip |
|---|---:|---:|---:|---:|---:|
| 100 tiny files | 10,315 | 87.78 ms | 0.007 ms | 13.32 ms | 276.29 ms |
| 1,000 tiny files | 107,512 | 217.11 ms | 0.003 ms | 67.56 ms | 686.56 ms |
| 1,000 dense files / 35,000 extra functions | 9,753,662 | 4,604.13 ms | 0.002 ms | 1,440.85 ms | 3,840.83 ms |

Cold analysis includes constructing the analyzer, parsing, building semantic links, and the first explanation. Cached measurements use 50 repeated queries of one symbol. Edit timing includes replacing one file and rebuilding semantic links on the next query. Each scenario checks that its caller exists before an edit and disappears afterwards. Worker round trip includes thread startup, sending the in-memory project, and first analysis. It is a separate measurement and can be faster than the direct run due to machine load and warm operating-system caches.

A 5 ms timer on the main thread fired 618 times during the dense worker run, demonstrating that analysis did not monopolize that thread. This is not a measurement of VS Code frame rate. Real editor latency also includes a 120 ms hover debounce, message transport, and rendering. Panel refresh waits 350 ms after edits. Disk traversal, VS Code startup, and rendering are not included in the table.

The dense benchmark sampled 1,249.6 MiB of process RSS after the worker query. **This includes both the direct analyzer retained by the benchmark and a worker analyzer, plus earlier scenario allocations. It is neither an isolated extension-memory measurement nor a peak measurement.** Dense projects still have material memory cost. Source byte count and number of files alone do not predict TypeScript's semantic memory cost.

## Bounds and tradeoffs

- Default 1,000 source files per workspace folder; configurable from 1 to 5,000. The 5,000-file setting has not been benchmarked.
- Default 256 KiB per file; configurable to at most 1 MiB. At most 16 MiB of indexed text, including at most 100 documentation/configuration files, and 50,000 visited directory entries. The full 16 MiB analyzer workload has not been benchmarked; the collector's 16 MiB boundary has a test.
- Every hover queries the existing worker index. It does not scan the filesystem again or send files over a network. Canceled hovers waiting in the queue are removed.
- File edits update only the changed file's text and reuse other parsed syntax trees. The next query rebuilds semantic references across indexed files so upstream callers cannot remain stale. **Dependency-specific semantic invalidation is not implemented.** The dense edit result above is the practical cost of that tradeoff.
- Uncached relationship expansion examines the chosen source and stored reference/call maps. It never recursively expands the graph. At most 60 paths per direction and 60 children/behavior entries are displayed, with truncation notes. The overview displays at most 60 files; open another file in the editor to explore beyond that list.
- Each worker keeps 128 query results in an LRU cache. Any file update invalidates those results. History retains at most 50 steps and collapses revisited paths.
- Explicit exploration/indexing uses cancellable progress. Canceling an active TypeScript query discards the response; the synchronous computation finishes inside its worker before the next queued request runs. Cancellation does not preempt TypeScript. File traversal checks cancellation between entries.
- Multiple workspace folders have independent indexes/workers. Cross-folder relationships are not resolved; place related workspace packages under one opened root.

For repositories beyond these limits, narrow the opened folder or use `codeTeach.exclude`, `files.exclude`, and `search.exclude`. Index warnings are visible in the panel and the Code Teach output channel. This release deliberately reports incomplete information instead of suggesting that excluded, dynamic, or unindexed relationships do not exist.

## Validation

`npm test` covers static relationships, alias/package resolution, callback uncertainty, cycles, edit/delete invalidation, worker transport, history, panel injection/CSP, repository ignore rules, secrets, symlinks, size limits, and cancellation. The VS Code extension-host integration test covers the teaching hover, panel explanation, source-linked upstream and downstream navigation, Back, and unsaved edit invalidation using the included checkout project.

The latest test run used VS Code 1.142.0 on macOS arm64. Windows/Linux and the declared minimum VS Code 1.95 have not been run. Native UI automation was unavailable in this environment (the computer-use service timed out), so no screenshot or manual visual/accessibility sign-off is claimed. HTML structure, escaping, tab keyboard handling, and message generation are tested; the integration run exercises the actual extension host and creates the webview.

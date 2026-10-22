# Code Teach 0.3.0: language support and verification

Added Java, Python, HTML and CSS to the globally installable extension on 2026-10-22. JavaScript/TypeScript keeps its existing analyzer. Every language uses the same hover, panel, source navigation, history, worker, exclusions and edit pipeline. No language server, JDK, Python interpreter, AI account or project build is required.

## Concrete walkthroughs

Open the included `demo` folder with the extension installed. These files are examples, not programs that the extension executes.

### Java

1. Open `languages/java/Checkout.java`, hover `checkout`, and choose **Explain more**.
2. The documented purpose identifies its checkout role. The panel shows `prices` as input, a `double` return type, the actual `Pricing.total(prices)` source step, and a call example from `Route`.
3. Choose **Upstream → caller → handle** to visit `Route.java`.
4. Choose **Back**, then **Downstream → callee → total** to visit `Pricing.java`. Its source lesson shows the accumulator, loop and return.
5. Choose **Back** to return to `checkout`. The breadcrumbs preserve your path. All Java call targets are labeled inferred candidates.

Java receiver paths such as `robot.motor.set(...)` can connect through declared local fields, including nested class types. Their source definitions must be in the index. This does not prove the runtime receiver type or overload.

### Python

Repeat the flow in `languages/python/checkout.py`: **checkout → upstream handle → Back → downstream total → Back**. Docstrings supply documented purpose. Examples display the source argument for `customer_id` next to its parameter, including keyword reordering and defaults. Calls using unpacking display an uncertainty message instead of invented values.

### HTML and CSS

Open `languages/web/style.css` and hover `.primary`. The source steps show the rule's actual properties. Choose **Downstream → consumer → button** to visit the matching element in `index.html`; choose **Back** to return. The match is inferred because the cascade and runtime DOM decide the actual appearance.

At **File** scale in `index.html`, follow the `style.css` or `app.js` import. The JavaScript file opens with the existing JS analyzer. Only linked stylesheets (including local CSS imports) contribute selector matches. An unrelated stylesheet containing the same selector does not become a connection.

## Analysis and known boundaries

The new backend uses Lezer grammar trees, with explicit local resolution rules; it is not a Java/Python compiler or a browser. See [Lezer's parser guide](https://lezer.codemirror.net/docs/guide/). Documentation is quoted as author intent, not independently proven behavior. Syntax steps, call examples and the connection map show the concrete evidence behind the explanation.

- **Java:** classes, interfaces, enums, records, methods, constructors, fields, parameters, imports and local variables. Same-package classes, explicit/wildcard class imports and declared receiver fields supply candidate method targets. Same-arity overload ambiguity remains unresolved. Inherited members, generic type substitution, reflection, dependency injection, lambdas, method references, annotation-generated code and external SDK implementations are not resolved. Java modules/build source sets/classpaths are not evaluated. Modern grammar features can be incomplete and surface a syntax warning.
- **Python:** classes/functions, simple assignments, parameters, local/imported function candidates and direct `self`/`cls` methods. Relative imports and aliases resolve when there is one indexed target. Absolute imports use a unique local suffix candidate and remain inferred because environment/search-path configuration is unknown. Arbitrary instance types, wildcard imports, decorators, metaclasses, monkey-patching, comprehensions, destructuring and full closure/value-flow analysis are not supported. Files with the same matching module suffix produce no guessed target.
- **HTML/CSS:** literal local script/stylesheet links and CSS imports; simple tag, `.class`, and `#id` selectors connected to literal elements in linked documents. No remote fetches, Sass/Less, templates, embedded script/style analysis, DOM API cross-links, complex selector matching, CSS variable flow, media-condition evaluation, cascade or computed layout. Resource paths assume the opened root for `/` URLs and the source directory otherwise; server routing and `<base>` URL overrides are not modeled.
- **Scopes:** file/module/project views show source files, declarations, imports and evidence. A new-language module is a directory. Java/Python expression scope uses the containing declaration rather than arbitrary expression evaluation; HTML/CSS uses the containing element/rule/property. Function/class scales are unavailable when there is no such declaration.
- **Effects and outputs:** direct returns, declared return types and selected explicit state writes are shown. Nested returns, unqualified field writes, mutations inside callees and external I/O may be missing. Empty detected effects never establishes purity. There is no runtime execution or robot behavior guarantee.
- **Scale:** unchanged files reuse syntax trees. After an edit the next request rebuilds project relationships, including incoming callers. At most 60 paths/children, eight direct source steps, three call examples, 12 argument bindings and 128 cached results per backend are kept/displayed. Recursion and circular imports do not recursively expand. JavaScript/TypeScript retains its own 12-step preview and 128-result cache.

The parser and source resolver run in the existing worker. Cancellation removes queued requests and discards canceled active results; it does not interrupt synchronous parsing/resolution. All original repository exclusions and byte/file limits apply to initial collection and subsequent edits. New defaults also exclude Python environments/caches, Gradle caches, Maven `target`, compiled bytecode/classes, generated language files and minified CSS. No source is transmitted externally.

## Verification

- **59 unit/integration-level tests passed** across both analyzers, worker transport, exclusions, navigation history, source teaching and panel security.
- Real **VS Code 1.143.0 / macOS arm64** extension-host tests passed teaching hovers for Java/Python/HTML/CSS; Java and Python caller → Back → dependency → Back navigation; and automatic refresh after unsaved Java caller edits and HTML class changes, including restoration. Existing JavaScript/TypeScript navigation and edit/configuration refresh continue to pass.
- Added regressions for cross-package Java receiver chains, nested types, ambiguous overloads, constructors, a class spanning its whole file, Python relative aliases, shadowed functions, keyword order, equality-expression arguments and unpacking. CSS tests cover import cycles, linked-only matching, edits and script links. Mixed-project cache reads do not duplicate relationships.
- Packaging includes all grammar runtimes and their licenses. The packaged worker is checked independently of the development `node_modules`, then installed globally in the local VS Code user profile.
- A read-only check of the packaged worker against the local FTC workspace passed a cross-file Java caller → Back → downstream method → Back flow across 232 eligible source/context files. The source remained unchanged; no robot build or hardware execution was performed.
- `npm audit` reported zero known dependency vulnerabilities at release time.
- The existing connection map, source snippets and input tables are reused. The earlier native JS/TS screenshots in `audit.md` depict 0.2.1. The installed 0.3.0 Java hover was also inspected in the FTC workspace on desktop VS Code 1.143.0, showing documented purpose, project location, caller/call counts, source steps, return type and Explain more. The complete new-language panel flow is verified through the actual extension-host API and shared panel message handler; a complete native click-through and screen-reader audit are not claimed.
- Performance is recorded in [performance.md](performance.md) and [benchmark-languages.json](benchmark-languages.json). Synthetic 1,000-file checks validate edit invalidation as well as timing. The 5,000-file setting, full 16 MiB workload, Windows, Linux and minimum VS Code 1.95 remain untested.

## Global installation and FTC use

Install `code-teach-0.3.0.vsix` through VS Code's **Install from VSIX** action or the README command. This is a user-profile extension, not a project dependency. It activates for supported files in any opened local folder. Existing windows may need **Developer: Reload Window** after an upgrade. Remote/SSH installations and separate VS Code profiles require their own installation.

For an FTC Java workspace, open the repository root so local robot classes and helper packages share one index. Hover a documented method, choose **Explain more**, then follow candidate callers/dependencies. Gradle, hardware, and the robot program are not run. External FTC SDK implementations remain outside the eligible local source index. No robot source or project settings need to be changed.

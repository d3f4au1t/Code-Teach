export type Scope = 'expression' | 'function' | 'class' | 'file' | 'module' | 'project';
export type RelationKind = 'caller' | 'callee' | 'data source' | 'consumer' | 'import' | 'reference';
export interface SourceLink {
  scope?: Scope;
  line?: number;
  file: string;
  start: number;
  end: number;
  label: string;
}
export interface Relationship {
  kind: RelationKind;
  certainty: 'verified' | 'inferred';
  detail: string;
  target?: SourceLink;
  evidence: SourceLink;
}
export interface TeachingStep {
  title: string;
  detail: string;
  code: string;
  kind: 'compute' | 'branch' | 'loop' | 'return' | 'effect' | 'declaration';
  source: SourceLink;
}
export interface CallExample {
  code: string;
  source: SourceLink;
  bindings: { parameter: string; argument: string }[];
  note: string;
}
export interface Explanation {
  sourceCode: string;
  steps: TeachingStep[];
  examples: CallExample[];
  id: string;
  name: string;
  kind: string;
  scope: Scope;
  source: SourceLink;
  summary: string;
  role: string;
  signature?: string;
  inputs: string[];
  outputs: string[];
  effects: string[];
  notes: string[];
  evidence: SourceLink[];
  upstream: Relationship[];
  downstream: Relationship[];
  children: SourceLink[];
  stats: { files: number; elapsedMs: number; cached: boolean };
}
export interface IndexedFile { file: string; text: string; }
export interface ProjectInput {
  root: string;
  files: IndexedFile[];
  compilerOptions?: Record<string, unknown>;
  notes?: string[];
}
export interface AnalysisQuery { file: string; offset: number; scope?: Scope; }
export type WorkerRequest =
  | { id: number; method: 'init'; project: ProjectInput }
  | { id: number; method: 'update'; file: string; text: string | null }
  | { id: number; method: 'explain'; query: AnalysisQuery };
export interface WorkerResponse { id: number; result?: Explanation | null; error?: string; }

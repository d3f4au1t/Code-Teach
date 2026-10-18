import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { AnalysisQuery, Explanation, ProjectInput, WorkerRequest, WorkerResponse } from './model';

type Request = WorkerRequest extends infer T ? T extends WorkerRequest ? Omit<T, 'id'> : never : never;
interface Pending {
  request: WorkerRequest;
  resolve: (value: Explanation | null) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  cancelled: boolean;
}
export class AnalysisClient {
  private readonly worker = new Worker(path.join(__dirname, 'worker.js'));
  private queue: Pending[] = [];
  private active?: Pending;
  private sequence = 0;
  private closed = false;

  constructor() {
    this.worker.on('message', (response: WorkerResponse) => {
      const current = this.active;
      if (!current || response.id !== current.request.id) return;
      this.active = undefined;
      current.cleanup();
      if (!current.cancelled) {
        if (response.error) current.reject(new Error(response.error));
        else current.resolve(response.result ?? null);
      }
      this.dispatch();
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => {
      if (!this.closed) this.fail(new Error(`Analysis worker exited (${code}). Refresh the index to retry.`));
    });
  }

  initialize(project: ProjectInput) { return this.request({ method: 'init', project }); }
  update(file: string, text: string | null) { return this.request({ method: 'update', file, text }); }
  explain(query: AnalysisQuery, signal?: AbortSignal) { return this.request({ method: 'explain', query }, signal); }

  private request(request: Request, signal?: AbortSignal): Promise<Explanation | null> {
    if (this.closed) return Promise.reject(new Error('Analysis worker is closed. Refresh the index to retry.'));
    if (signal?.aborted) return Promise.reject(new Error('Cancelled'));
    return new Promise((resolve, reject) => {
      const pending: Pending = { request: { ...request, id: ++this.sequence } as WorkerRequest,
        resolve, reject, cleanup: () => {}, cancelled: false };
      const abort = () => {
        pending.cancelled = true;
        pending.cleanup();
        this.queue = this.queue.filter(item => item !== pending);
        reject(new Error('Cancelled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      pending.cleanup = () => signal?.removeEventListener('abort', abort);
      this.queue.push(pending);
      this.dispatch();
    });
  }

  private dispatch() {
    if (this.active || this.closed) return;
    this.active = this.queue.shift();
    if (this.active) this.worker.postMessage(this.active.request);
  }

  private fail(error: Error) {
    this.closed = true;
    for (const item of [this.active, ...this.queue]) {
      item?.cleanup();
      item?.reject(error);
    }
    this.active = undefined;
    this.queue = [];
  }

  dispose() {
    this.fail(new Error('Analysis stopped.'));
    void this.worker.terminate();
  }
}

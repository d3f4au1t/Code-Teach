import { parentPort } from 'node:worker_threads';
import { ProjectAnalyzer as Analyzer } from './project';
import { WorkerRequest, WorkerResponse } from './model';

let analyzer: Analyzer | undefined;
parentPort?.on('message', (request: WorkerRequest) => {
  const response: WorkerResponse = { id: request.id };
  try {
    if (request.method === 'init') analyzer = new Analyzer(request.project);
    else if (!analyzer) throw new Error('The project index is not ready.');
    else if (request.method === 'update') analyzer.update(request.file, request.text);
    else response.result = analyzer.explain(request.query);
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }
  parentPort?.postMessage(response);
});

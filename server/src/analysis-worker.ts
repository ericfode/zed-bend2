import { parentPort } from 'node:worker_threads';
import { analyze } from './analyzer.js';
import type { AnalyzeRequest } from './model.js';

parentPort!.on('message', async ({ id, request }: { id: number; request: AnalyzeRequest }) => {
  try {
    parentPort!.postMessage({ id, result: await analyze({ ...request, allowPackageDownloads: false }) });
  } catch (error) {
    parentPort!.postMessage({ id, error: String(error) });
  }
});

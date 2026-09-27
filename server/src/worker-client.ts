import { Worker } from 'node:worker_threads';
import type { Analysis, AnalyzeRequest } from './model.js';

// One bounded job at a time. Terminating the worker also interrupts a stuck compiler.
export class AnalyzerWorker {
  private worker?: Worker;
  private nextId = 0;
  private pending?: { reject: (error: Error) => void; timer: NodeJS.Timeout };

  async analyze(request: AnalyzeRequest): Promise<Analysis> {
    this.stop();
    const worker = this.worker = new Worker(new URL('./analysis-worker.mjs', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 },
    });
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: Analysis) => {
        if (this.worker !== worker) return;
        clearTimeout(this.pending!.timer);
        this.pending = undefined;
        this.worker = undefined;
        void worker.terminate();
        if (error) reject(error);
        else resolve(result!);
      };
      this.pending = {
        reject,
        timer: setTimeout(() => finish(new Error('Compiler analysis timed out')), 30_000),
      };
      worker.once('error', error => finish(error));
      worker.once('exit', code => finish(new Error(`Compiler worker exited (${code})`)));
      worker.on('message', message => {
        if (message.id === id) finish(message.error ? new Error(message.error) : undefined, message.result);
      });
      worker.postMessage({ id, request });
    });
  }

  stop() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Analysis superseded'));
      this.pending = undefined;
    }
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
  }
}

export interface WorkerShutdownDependencies {
  stopAcceptingWork(): void;
  closeGenerationWorker(): Promise<void>;
  waitForInlineWork(): Promise<void>;
  onStarted(signal: NodeJS.Signals): void;
  onCompleted(signal: NodeJS.Signals): void;
  onFailed(error: unknown, signal: NodeJS.Signals): void;
}

export interface WorkerShutdownController {
  isShuttingDown(): boolean;
  shutdown(signal: NodeJS.Signals): Promise<void>;
}

export function createWorkerShutdownController(dependencies: WorkerShutdownDependencies): WorkerShutdownController {
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  return {
    isShuttingDown() {
      return shuttingDown;
    },
    shutdown(signal) {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      shuttingDown = true;
      dependencies.stopAcceptingWork();
      dependencies.onStarted(signal);

      shutdownPromise = (async () => {
        await dependencies.closeGenerationWorker();
        await dependencies.waitForInlineWork();
        dependencies.onCompleted(signal);
      })().catch((error) => {
        dependencies.onFailed(error, signal);
      });

      return shutdownPromise;
    }
  };
}

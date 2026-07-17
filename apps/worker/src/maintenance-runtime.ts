export interface WorkerMaintenanceGate {
  shouldRun(nowMs?: number): boolean;
}

export function createWorkerMaintenanceGate(intervalMs: number): WorkerMaintenanceGate {
  const normalizedIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : 0;
  let lastRunAtMs: number | null = null;

  return {
    shouldRun(nowMs = Date.now()): boolean {
      if (
        lastRunAtMs === null ||
        normalizedIntervalMs === 0 ||
        nowMs < lastRunAtMs ||
        nowMs - lastRunAtMs >= normalizedIntervalMs
      ) {
        lastRunAtMs = nowMs;
        return true;
      }
      return false;
    }
  };
}

import { performance } from "node:perf_hooks";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4100";
const requests = readPositiveInt("LOAD_REQUESTS", 120);
const concurrency = readPositiveInt("LOAD_CONCURRENCY", 12);
const target = `${apiBaseUrl}/health`;

let completed = 0;
let failed = 0;
let scheduled = 0;
const durations = [];
const startedAt = performance.now();

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (true) {
      const requestIndex = scheduled;
      if (requestIndex >= requests) {
        return;
      }
      scheduled += 1;
      const started = performance.now();
      try {
        const response = await fetch(target);
        const duration = performance.now() - started;
        durations.push(duration);
        if (response.ok) {
          completed += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
  })
);

durations.sort((left, right) => left - right);
const elapsedMs = performance.now() - startedAt;
const p95 = percentile(durations, 0.95);
const average = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
const summary = {
  target,
  requests,
  concurrency,
  completed,
  failed,
  elapsedMs: Math.round(elapsedMs),
  requestsPerSecond: Number((completed / (elapsedMs / 1000)).toFixed(2)),
  averageMs: Math.round(average),
  p95Ms: Math.round(p95)
};

console.log(JSON.stringify(summary, null, 2));

if (failed > 0) {
  process.exitCode = 1;
}

function percentile(values, ratio) {
  if (!values.length) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  return values[index];
}

function readPositiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

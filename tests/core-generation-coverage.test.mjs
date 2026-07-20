import assert from "node:assert/strict";
import test from "node:test";
import {
  hasTerminalGenerationFailure,
  isTerminalTaskStatus,
  resolveGenerationViewState,
  resolveProcessingPlaceholderCount
} from "../apps/web/app/generate/generationState.ts";

const task = (status, failureMessage = null) => ({ status, failureMessage, quantity: 3 });

test("generation state machine covers every visible state and terminal status", () => {
  assert.equal(
    resolveGenerationViewState({ loading: false, restoringTaskView: false, task: null, images: [] }),
    "idle"
  );
  assert.equal(
    resolveGenerationViewState({ loading: true, restoringTaskView: false, task: null, images: [] }),
    "submitting"
  );
  assert.equal(
    resolveGenerationViewState({ loading: false, restoringTaskView: true, task: null, images: [] }),
    "restoring"
  );
  assert.equal(
    resolveGenerationViewState({ loading: false, restoringTaskView: false, task: task("PENDING"), images: [] }),
    "processing"
  );
  assert.equal(
    resolveGenerationViewState({ loading: false, restoringTaskView: false, task: task("SUCCEEDED"), images: [{}] }),
    "succeeded"
  );
  assert.equal(
    resolveGenerationViewState({ loading: false, restoringTaskView: false, task: task("FAILED"), images: [] }),
    "failed"
  );
  assert.equal(hasTerminalGenerationFailure(null, []), false);
  assert.equal(hasTerminalGenerationFailure(task("RUNNING", "provider failed"), []), true);
  assert.equal(hasTerminalGenerationFailure(task("FAILED"), [{}]), false);
  assert.equal(resolveProcessingPlaceholderCount(task("RUNNING"), 1), 3);
  assert.equal(resolveProcessingPlaceholderCount(null, 0), 1);
  for (const status of ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELED"]) {
    assert.equal(isTerminalTaskStatus(status), true);
  }
  assert.equal(isTerminalTaskStatus("RUNNING"), false);
});

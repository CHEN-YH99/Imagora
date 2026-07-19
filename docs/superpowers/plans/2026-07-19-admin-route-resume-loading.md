# Admin Route Resume Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reload admin data when returning to `/admin` and preserve successful modules when one admin request fails.

**Architecture:** Add route-activation awareness with `usePathname`, then replace the all-or-nothing request aggregation with settled results. Existing request sequence refs continue to reject stale image and order responses.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node test runner

---

### Task 1: Lock the regression contract

**Files:**
- Modify: `tests/web-routes.test.mjs`

- [x] Add assertions that the admin page imports and uses `usePathname` to reload when `/admin` becomes active.
- [x] Add assertions that the admin loader uses `Promise.allSettled` and handles rejected module results.
- [x] Run `node --test tests/web-routes.test.mjs` and confirm the new assertions fail.

### Task 2: Implement route resume and partial loading

**Files:**
- Modify: `apps/web/app/admin/page.tsx`

- [x] Import `usePathname` and track the active pathname.
- [x] Trigger `load()` whenever the authorized page becomes active at `/admin`.
- [x] Replace `Promise.all` with `Promise.allSettled` and update each successful module independently.
- [x] Preserve request sequence checks for page, image and order results.
- [x] Aggregate failed module labels into one recoverable notice.
- [x] Run `node --test tests/web-routes.test.mjs` and confirm it passes.

### Task 3: Verify the complete change

**Files:**
- Verify: `apps/web/app/admin/page.tsx`
- Verify: `tests/web-routes.test.mjs`

- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Run `git diff --check`.
- [x] Review `git diff` and report changed files without committing.

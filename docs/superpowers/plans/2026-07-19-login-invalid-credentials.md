# Login Invalid Credentials Implementation Plan

**Goal:** Correct login error semantics and preserve captcha-free credential retry while the server login-attempt token is valid.

**Architecture:** Add shared `INVALID_CREDENTIALS`; make the login page distinguish credential failures from captcha failures.

**Tech Stack:** TypeScript, Fastify, Next.js, Node test runner

## Task 1: API contract

- [ ] Add a failing auth assertion for `INVALID_CREDENTIALS`.
- [ ] Add the shared error code and return it from login credential failure.
- [ ] Run the auth test green.

## Task 2: Web retry flow

- [ ] Add failing web assertions for the new mapping and retry state.
- [ ] Add `loginRetryAvailable` and condition captcha reset by error code.
- [ ] Run the web test green.

## Task 3: Verification

- [ ] Run typecheck, full tests, build, API health and login page checks.

No git commit is included without explicit user authorization.

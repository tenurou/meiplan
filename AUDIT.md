# Repository audit — 2026-10-12

Scope: source snapshot `8ceb77f`, application/server lifecycle, authentication,
Excel parser, reconciliation and UI helpers, local integration tests, startup
scripts, source packaging, and deployment documentation. All runtime checks use
local fixtures; this is not verification of the deployed revision or live CRM.

## Fixed

- **Startup blocker:** literal `\n` tokens at EOF made five modules invalid
  JavaScript, including three imported by the server. Removed the tokens and
  added a syntax check covering application, UI, utilities, and test modules.
- **Wrong UI selection after polling:** rebuilding the Core tab selector every
  four seconds reset the user's selection to the first tab. Preserve the
  selected value while it remains available. A complete-UI Chromium regression
  test reproduced the failure before the fix and also checks tab disappearance.
- **Reading during navigation:** the UI allowed reading Core before the requested
  plan finished opening. Opening now disables duplicate opens and plan reads,
  including during background refresh. The browser regression test holds the
  navigation response until these states have been checked.
- **Idle browsers never expired while the UI stayed open:** authentication
  refreshed `lastActivity` on every background state/screenshot request. Only
  the existing list of browser actions now records activity. Added a regression
  test for polling versus explicit actions.
- **Broken standalone smoke check:** the state request sent a CSRF token without
  its session cookie and returned HTTP 403. The check now carries both.
- **Incomplete source distribution:** included the architecture, contributor,
  deployment, baseline, audit, and TODO documents referenced by the project,
  together with the new syntax checker.
- **No automated repository checks:** added a read-only GitHub Actions workflow
  for Windows and Ubuntu 24.04, Node.js 20/24, Python, Chromium, tests, smoke
  startup, and packaging. It contains no deployment steps.
- **Cross-platform test synchronization:** wait for the source mutation delivered
  through iframe `postMessage` and for the uploaded Excel preview. These checks
  still assert the expected values and retain the stale-source save protections.

## Verification

Local environment: Windows, Node.js 24, bundled Python 3, pinned Playwright.
Clean `npm ci` completed; npm reported zero known dependency vulnerabilities at
installation time. Run `npm test`, `npm run test:smoke`, and
`npm run package:source` for the reproducible checks. Linux results must be
confirmed from CI; this machine did not run a Linux installation.

Local result: 18 JavaScript files passed syntax checking; all 17 tests passed;
the smoke check returned HTTP 200 for both UI and session-authenticated API;
the source archive contained 50 entries and passed its current exclusion checks;
`git diff --check` passed.

The existing suite covers Excel and DataLens fixture transfers, source identity,
merged cells, reconciliation, user isolation, administrator access, feedback,
draft filling, refusal to save without approval, and readback after fixture saves.
New coverage checks complete-UI initialization/refresh, Core tab selection, and
idle activity accounting. Transfer/matching/metric rules were not changed.

## Follow-up work

- Serialize browser-changing operations per session and test concurrent apply,
  save, disconnect, and navigation requests. Current handlers contain awaits
  without a shared per-session operation lock; fixture success does not prove
  safety under overlapping requests. This needs dedicated transfer regression
  scenarios before changing the save workflow.
- Add bounded retention for abandoned session directories and feedback. Session
  records remain in memory, feedback reads load the complete JSONL file, and a
  browser-context limit alone does not bound disk use or session count.
- Harden source packaging against accidental sensitive files in recursively
  copied `public/`, `test/`, and `deploy/` directories. The current blacklist is
  narrower than `.gitignore`; use an explicit source manifest or equivalent
  validation before distributing archives from a non-clean checkout.
- Reconcile README's manual report/period-selection description with the
  automatic recommendation/inference paths in `public/report-selector.js` and
  `public/app.js`. Confirm intended product behavior before changing these rules.
- Verify the actual VPS resource budget and current Core/DataLens pages in a
  separately scoped environment. Local fixtures do not establish production
  compatibility, capacity, or deployment health.

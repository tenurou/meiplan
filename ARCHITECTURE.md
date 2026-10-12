# Architecture

## Runtime

MeiPlan is a Node.js ES module application. `server.mjs` serves the web UI, owns the application API, and uses Playwright to launch Chromium. Python 3 runs `parse_xlsx.py` for workbook extraction. `package.json` pins Playwright; `package-lock.json` is the npm dependency lockfile.

## Main flow

1. A user supplies the exact Core mediaplan URL and/or DataLens report URL and may upload an Excel workbook.
2. The server reads the workbook or the selected table in the isolated Playwright browser context. Browser contexts, uploads, and runtime state are associated with the user's application session.
3. `reconcile.mjs` and `public/` logic normalize and compare source rows with Core rows. The UI presents a preview and mismatches before the user applies a draft.
4. Applying edits Core form fields but does not save. Saving is a separate explicit, user-confirmed operation. The application then reads Core back and verifies row-level values and totals.

## Components

- `server.mjs`: HTTP routes, browser/context lifecycle, source-read and draft/save orchestration.
- `auth.mjs`: session and administrator authentication helpers.
- `browser-cleanup.mjs`: cleanup of browser processes and isolated profiles.
- `parse_xlsx.py`: extraction of worksheet cell values and workbook metadata.
- `reconcile.mjs`: server-side reconciliation and validation rules.
- `public/app.js`, `public/*.js`, `public/index.html`, `public/app.css`: browser UI, review workflow, mapping rules, and audit display.
- `scripts/users.mjs`: local administrator/user management.
- `scripts/package-release.mjs`: source-only release archive creation and content checks.
- `test/`: browser, parser, reconciliation, authorization, and workflow tests using local fixtures.
- `deploy/`: example Ubuntu 24.04 systemd and nginx deployment.
- `licensing.mjs`, `LICENSE-ARCHITECTURE.md`: extension points and design notes; no license service or enforcement is active.

## Persistent state and trust boundaries

`AGM_DATA_DIR` stores per-user browser profiles and uploaded files, user configuration, feedback, and installation/license metadata. Treat the whole directory as sensitive runtime data; it is ignored by Git. The deployed service should bind Node.js to loopback behind HTTPS nginx. Credentials, session cookies, client workbooks, browser profiles, and feedback must not enter the repository or logs.

The application does not choose a mediaplan or report on a user's behalf. The user supplies URLs and report filters. Automated checks should use fixtures; tests must not press Save in a real Core CRM.

## Current limitations

- Core and DataLens behavior can change; live authenticated end-to-end coverage is not part of the local test suite.
- Linux/VPS resource use requires measurement on the target machine.
- Licensing is a design skeleton, not an implemented product feature.
- Runtime state and feedback are local files, not a shared database or centralized audit service.

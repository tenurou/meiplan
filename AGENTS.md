# Contributor guidance

## Safety boundaries

- Keep the application focused on importing Excel plans and DataLens facts into the explicitly supplied Core mediaplan, with preview and reconciliation.
- Do not change plan-transfer rules, matching behavior, or production settings as part of cleanup or documentation work. Any such change needs an explicit task and regression coverage.
- Audits and tests must use local fixtures by default. Never submit a save operation to a real Core mediaplan during development or tests.
- Production access is read-only unless the user explicitly authorizes a specific deployment. A deployment requires a separate explicit approval after the proposed changes and verification results are presented. Never enable automatic deployment.
- Do not commit `.env`, `data/`, browser profiles, cookies, user databases, feedback uploads, customer files, logs, backups, private keys, or generated release artifacts. See `.gitignore`.
- Do not bypass CAPTCHA, MFA, or other authentication protections.

## Working workflow

1. Start from a separate branch based on `main`, named `feature/<short-topic>` or `fix/<short-topic>`.
2. Make the smallest scoped change. Preserve source rows and unknown values; never guess ambiguous mappings.
3. Run `npm ci` for a clean dependency install, then `npm test`. Run `npm run package:source` when changing packaging or release contents.
4. Review `git diff --check`, the complete diff, and the staged file list. Confirm there are no credentials, user data, or unrelated files.
5. Open a pull request to `main`; require review before merging. Keep `main` tested and releasable.
6. Deployment is a separate operation and must wait for the user's explicit approval of the exact reviewed revision.

## Project map

- `server.mjs`, `auth.mjs`, `browser-cleanup.mjs`: web server, per-session browser lifecycle, and authentication.
- `reconcile.mjs`, `parse_xlsx.py`, `public/`: Excel/DataLens parsing, matching, previews, and Core form transfer.
- `test/`: local HTML fixtures and automated tests. Tests should not authenticate to or mutate live Core/DataLens.
- `deploy/`: Ubuntu/systemd/nginx deployment reference.
- `licensing.mjs`, `LICENSE-ARCHITECTURE.md`: licensing architecture only; enforcement is not implemented.

See `ARCHITECTURE.md` and `DEPLOYMENT.md` before changing these boundaries.

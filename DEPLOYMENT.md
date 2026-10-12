# Deployment and release policy

The production deployment currently targets Ubuntu 24.04, nginx, systemd, Node.js, Python 3, and Playwright Chromium. The detailed install and verification steps are in [`deploy/ubuntu-24.04.md`](deploy/ubuntu-24.04.md); service and nginx examples are in the same directory.

## Release boundaries

- A GitHub push, merge, or tag does not deploy production.
- Do not configure GitHub Actions, webhooks, or other automatic production deployment without a separately approved task.
- Deploy only a reviewed commit after the user explicitly approves that exact revision and deployment window.
- Never run deployment commands, restart/reload production services, change server configuration, or write to production data during routine development or repository setup.
- Preserve runtime state under `/var/lib/agm-plan-assistant`; it is not source code and must never be copied to GitHub.

## Maintainer checklist

1. Create a feature/fix branch from tested `main`.
2. Install from the lockfile with `npm ci` and run `npm test`.
3. Review the diff and staged paths; check for secrets and local data.
4. Merge only after review and a passing test run.
5. For a requested release, identify the exact commit, build/package from a clean checkout, show the change and test results, then obtain explicit deployment approval.
6. Follow the Ubuntu guide; run its health and reconciliation checks without saving test data in real Core.

Never place SSH private keys, `.env`, user files, Chromium profiles, cookies, feedback records, or backups in source control.

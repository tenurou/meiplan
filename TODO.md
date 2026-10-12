# Known work and limitations

This list describes known gaps; it is not authorization to modify production or expand product scope.

- [ ] Create the private GitHub repository and push the reviewed initial commit (requires an authenticated GitHub session).
- [ ] Invite maintainers using their GitHub accounts; grant Astra only the minimum required repository role.
- [ ] Run the documented clean install and test workflow on Ubuntu 24.04 in a disposable environment.
- [ ] Measure Chromium RSS/CPU on the actual VPS during a separately approved maintenance task.
- [ ] Decide whether local-file feedback storage is sufficient for the intended number of users and retention policy.
- [ ] Implement licensing only after product requirements, entitlement authority, offline policy, and failure behavior are agreed.
- [ ] Keep real Core/DataLens integration tests manual or use safe fixtures; do not add destructive live CRM tests.

## Explicitly out of scope

- Automatic production deploys from GitHub.
- Autonomous selection of Core mediaplans, reports, or periods.
- License enforcement without an approved design.
- Changing the plan-transfer matching, metric, or save-approval rules as part of repository migration.

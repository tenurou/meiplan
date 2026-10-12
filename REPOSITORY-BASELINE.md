# Repository baseline

Snapshot prepared on 2026-10-12 from the local working copy after read-only comparison with `/opt/agm-plan-assistant` on the production VPS.

- The 35 shared application, UI, deployment, and documentation files had matching SHA-256 hashes on the local copy and VPS.
- The local automated test and HTML/XLSX fixture files were newer/different than those on the VPS. The local versions are included; production files were not copied over them.
- VPS-only `*.bak` files, `data/`, browser profiles, uploaded workbooks, user data, generated archives, and installed dependencies are not part of the repository.
- The production service reported `active`; `https://meiplan.ru/` returned HTTP 200. No production service, configuration, or data was changed for this repository setup.
- Local verification: `node --test` passed 15/15; the source archive builder produced a 42-entry archive and its exclusions passed; `git diff --cached --check` passed after removing pre-existing extra blank lines at EOF.

This note describes the one-time snapshot. Recheck the target revision and runtime state before any future release.

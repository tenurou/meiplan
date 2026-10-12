# Licensing architecture scaffold

Licensing is isolated in `licensing.mjs`; importing it has no network side effects. This is only an integration seam, not an implemented activation or licensing system.

## Current scaffold

- Creates and persists a random installation ID in the app's `data` directory (`installation-id`, file permissions restricted where supported).
- Reads a local cached status from `data/license-status.json`; missing or malformed state is treated as `unlicensed`.
- Exposes feature checks for `plan_import`, `fact_import`, and `reconciliation` through `isFeatureEnabled()` and `requireFeature()`.
- Exposes `refresh(licenseKey)` as the future remote-validation seam. A validator can be injected by the server later; no endpoint, key storage, payment, signature validation, or license issuer exists now.
- The local `/api/state` response exposes the installation ID and cached license status for diagnostics. It deliberately does not gate any workflow yet.

The cached JSON is not tamper-proof and must not be treated as proof of entitlement. Do not collect/store a license key until a real validation service and key-handling policy exist. Keep secrets out of logs and browser responses.

## Intended integration surface

The service is already created at startup in `server.mjs` with `createLicenseService({ dataDir })`. Possible later wiring:

1. Call `license.requireFeature('plan_import')` before accepting/applying Excel plan changes, `fact_import` before DataLens fact writes, and `reconciliation` before reconciliation operations.
2. Add an activation/refresh endpoint only once the remote service contract and credential storage are decided; pass a validator to `refresh()` rather than embedding network logic in this module.
3. Before enforcing licenses, define offline grace periods, device transfer/recovery, key protection, server signing/verification, and what happens when validation is temporarily unavailable.

Until integration and an issuer exist, this module does not change app behavior or block existing features.

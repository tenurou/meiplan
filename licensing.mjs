import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Local licensing seam for future activation/remote validation.
 * This module intentionally contains no activation, payment, cryptographic
 * signature verification, or licensing-server implementation.
 */

export const LICENSED_FEATURES = Object.freeze([
  'plan_import',
  'fact_import',
  'reconciliation',
]);

const INSTALLATION_ID_FILE = 'installation-id';
const LICENSE_STATUS_FILE = 'license-status.json';

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readOrCreateInstallationId(dataDir) {
  ensurePrivateDir(dataDir);
  const file = path.join(dataDir, INSTALLATION_ID_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
  } catch { /* first run */ }

  const id = crypto.randomUUID();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${id}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temp, file); }
  catch (err) {
    try { fs.unlinkSync(temp); } catch { /* ignore cleanup */ }
    if (err.code !== 'EEXIST') throw err;
  }
  try {
    const persisted = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/i.test(persisted)) return persisted;
  } catch { /* handled below */ }
  throw new Error('Could not persist installation identity');
}

function readStatus(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, LICENSE_STATUS_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid status');
    const features = Array.isArray(parsed.features)
      ? parsed.features.filter(f => LICENSED_FEATURES.includes(f))
      : [];
    return {
      state: ['active', 'expired', 'revoked', 'validation_unavailable'].includes(parsed.state)
        ? parsed.state
        : 'unlicensed',
      features,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
      lastValidatedAt: typeof parsed.lastValidatedAt === 'string' ? parsed.lastValidatedAt : null,
      source: 'local-cache',
    };
  } catch {
    return { state: 'unlicensed', features: [], expiresAt: null, lastValidatedAt: null, source: 'default' };
  }
}

/**
 * Create a read-only license service. `remoteValidator` is an injection seam
 * for a future server client; it should return { state, features, expiresAt }.
 * It is deliberately absent by default.
 */
export function createLicenseService({ dataDir, remoteValidator = null, clock = () => new Date() }) {
  if (!dataDir) throw new TypeError('dataDir is required');
  ensurePrivateDir(dataDir);
  const installationId = readOrCreateInstallationId(dataDir);
  let status = readStatus(dataDir);

  const persistStatus = next => {
    const normalized = {
      state: next.state,
      features: [...new Set(next.features)].filter(f => LICENSED_FEATURES.includes(f)),
      expiresAt: next.expiresAt || null,
      lastValidatedAt: next.lastValidatedAt || null,
    };
    const file = path.join(dataDir, LICENSE_STATUS_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    status = { ...normalized, source: 'local-cache' };
  };

  const snapshot = () => ({
    installationId,
    ...status,
    features: [...status.features],
  });

  const isFeatureEnabled = feature => {
    if (!LICENSED_FEATURES.includes(feature)) throw new Error(`Unknown licensed feature: ${feature}`);
    if (status.state !== 'active') return false;
    if (status.expiresAt) {
      const expiresAt = Date.parse(status.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= clock().getTime()) return false;
    }
    return status.features.includes(feature);
  };

  const requireFeature = feature => {
    if (!isFeatureEnabled(feature)) {
      const error = new Error(`Лицензия не включает функцию «${feature}»`);
      error.code = 'LICENSE_REQUIRED';
      error.feature = feature;
      throw error;
    }
  };

  const refresh = async licenseKey => {
    if (typeof remoteValidator !== 'function') {
      const error = new Error('Удалённая проверка лицензии пока не настроена');
      error.code = 'LICENSE_VALIDATION_NOT_CONFIGURED';
      throw error;
    }
    const result = await remoteValidator({ installationId, licenseKey });
    if (!result || !['active', 'expired', 'revoked'].includes(result.state)) {
      throw new Error('Сервер лицензирования вернул некорректный статус');
    }
    persistStatus({
      state: result.state,
      features: Array.isArray(result.features) ? result.features : [],
      expiresAt: result.expiresAt || null,
      lastValidatedAt: clock().toISOString(),
    });
    return snapshot();
  };

  return Object.freeze({
    getInstallationId: () => installationId,
    getStatus: snapshot,
    isFeatureEnabled,
    requireFeature,
    refresh,
  });
}

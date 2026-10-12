import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export function readUsers(usersFile) {
  if (!usersFile || !fs.existsSync(usersFile)) return [];
  const data = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  if (!data || !Array.isArray(data.users)) throw new Error(`Invalid users file: ${usersFile}`);
  const seen = new Set();
  return data.users.map(user => {
    const username = String(user.username || '').trim();
    const key = username.toLocaleLowerCase('en-US');
    const salt = Buffer.from(String(user.salt || ''), 'base64');
    const hash = Buffer.from(String(user.hash || ''), 'base64');
    if (!/^[\p{L}\p{N}._-]{1,64}$/u.test(username) || seen.has(key) || salt.length < 16 || hash.length !== 32 || user.enabled === false) {
      if (user.enabled === false) return null;
      throw new Error(`Invalid or duplicate user entry: ${username || '(empty)'}`);
    }
    seen.add(key);
    const role = user.role === 'admin' ? 'admin' : 'user';
    return { username, key, salt, hash, role };
  }).filter(Boolean);
}

export async function verifyBasicAuthorization(header, users, cache, now = Date.now()) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  const cacheKey = crypto.createHash('sha256').update(header).digest('hex');
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.user;
  if (cached) cache.delete(cacheKey);
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return null; }
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;
  const username = decoded.slice(0, separator).trim();
  const password = decoded.slice(separator + 1);
  const user = users.find(item => item.key === username.toLocaleLowerCase('en-US'));
  if (!user || !password || password.length > 1024) return null;
  const actual = await scrypt(password, user.salt, user.hash.length, SCRYPT);
  if (!crypto.timingSafeEqual(actual, user.hash)) return null;
  const authenticated = { username: user.username, key: user.key, role: user.role === 'admin' ? 'admin' : 'user' };
  cache.set(cacheKey, { user: authenticated, expiresAt: now + 30 * 60 * 1000 });
  return authenticated;
}

export function makeUserId(username) {
  return crypto.createHash('sha256').update(username.toLocaleLowerCase('en-US')).digest('hex');
}

export async function createUserRecord(username, password, { role = 'user' } = {}) {
  const clean = String(username || '').trim();
  if (!/^[\p{L}\p{N}._-]{1,64}$/u.test(clean)) throw new Error('Username must use letters, digits, dot, underscore or hyphen (1-64 chars).');
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Password must contain 12-1024 characters.');
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  if (!['admin', 'user'].includes(role)) throw new Error('Role must be admin or user.');
  return { username: clean, salt: salt.toString('base64'), hash: hash.toString('base64'), enabled: true, role };
}

export function writeUsers(usersFile, records) {
  fs.mkdirSync(path.dirname(usersFile), { recursive: true, mode: 0o700 });
  const tempFile = `${usersFile}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify({ users: records }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(tempFile, usersFile);
  try { fs.chmodSync(usersFile, 0o600); } catch { /* Windows ACLs are managed by the account. */ }
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserRecord, readUsers, writeUsers } from '../auth.mjs';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const usersFile = path.resolve(process.env.AGM_USERS_FILE || path.join(here, 'data', 'users.json'));
const [command, rawUsername, option] = process.argv.slice(2);

async function hidden(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Run this command in an interactive terminal.');
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data', onData); process.stdout.write('\n'); };
    const onData = buffer => {
      for (const byte of buffer) {
        if (byte === 3) { cleanup(); reject(new Error('Cancelled.')); return; }
        if (byte === 13 || byte === 10) { cleanup(); resolve(bytes.toString('utf8')); return; }
        if (byte === 127 || byte === 8) {
          if (!bytes.length) continue;
          let start = bytes.length - 1;
          while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
          bytes = bytes.subarray(0, start);
        } else if (byte >= 32) bytes = Buffer.concat([bytes, Buffer.from([byte])]);
      }
    };
    process.stdin.on('data', onData);
  });
}

try {
  const records = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, 'utf8')).users : [];
  if (!Array.isArray(records)) throw new Error('Invalid users file.');
  if (command === 'list') {
    for (const user of records.filter(item => item.enabled !== false)) console.log(user.username);
  } else if (command === 'add') {
    const username = String(rawUsername || '').trim();
    if (records.some(user => String(user.username).toLocaleLowerCase('en-US') === username.toLocaleLowerCase('en-US'))) throw new Error('That username already exists.');
    const first = await hidden('New password (12+ characters): ');
    const second = await hidden('Repeat password: ');
    if (first !== second) throw new Error('Passwords did not match.');
    if (option && option !== '--admin') throw new Error('The only add option is --admin.');
    records.push(await createUserRecord(username, first, { role: option === '--admin' ? 'admin' : 'user' }));
    writeUsers(usersFile, records);
    console.log(`Added ${username} to ${usersFile}. Restart the app to apply account changes.`);
  } else if (command === 'remove') {
    const username = String(rawUsername || '').trim();
    const next = records.filter(user => String(user.username).toLocaleLowerCase('en-US') !== username.toLocaleLowerCase('en-US'));
    if (next.length === records.length) throw new Error('User not found.');
    writeUsers(usersFile, next);
    console.log(`Removed ${username}. Restart the app to revoke cached Basic Auth sessions.`);
  } else if (command === 'role') {
    const role = option;
    if (!['admin', 'user'].includes(role)) throw new Error('Role must be admin or user.');
    const user = records.find(item => String(item.username).toLocaleLowerCase('en-US') === String(rawUsername || '').trim().toLocaleLowerCase('en-US'));
    if (!user) throw new Error('User not found.');
    user.role = role;
    writeUsers(usersFile, records);
    console.log(`Updated role for ${user.username}. Restart the app to apply account changes.`);
  } else {
    console.log('Usage: node scripts/users.mjs add <username> [--admin] | role <username> <admin|user> | remove <username> | list');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}

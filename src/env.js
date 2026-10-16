// Ключи читаются из .env прямо в коде и никуда не печатаются:
// ни в чат, ни в логи, ни в тексты ошибок.

import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

export const env = (name) => (process.env[name] ?? '').trim();

// Есть ли ключ — без самого значения. Только это и можно показывать.
export const has = (name) => env(name) !== '';

export function die(msg) {
  console.error(msg);
  process.exit(1);
}

// Ключ в тексте ошибки сервиса бывает: его вырезаем, прежде чем показать.
export function scrub(text) {
  let s = String(text ?? '');
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && /KEY|TOKEN|SECRET|PASS|WEBHOOK/.test(k)) s = s.split(v).join('[скрыто]');
  }
  return s;
}

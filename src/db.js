// База прогона. Благодаря ей агент работает в несколько заходов: каждая команда
// берёт только необработанное, повторный запуск продолжает с места остановки.
// Встроенный node:sqlite — ничего не надо ставить.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';

export const DB_FILE = path.join(ROOT, 'state', 'base.db');

let db;
export function openDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS deals (
      id              INTEGER PRIMARY KEY,
      ext_id          TEXT UNIQUE,      -- id сделки в CRM или номер строки файла
      title           TEXT,             -- название сделки, имена контактов уже закрыты
      company         TEXT,
      company_key     TEXT,             -- ИНН, домен или имя: по нему склеиваем дубли
      site            TEXT,
      domain          TEXT,
      inn             TEXT,
      country         TEXT,
      closed_at       TEXT,             -- YYYY-MM-DD
      loss_reason     TEXT,
      stage           TEXT,
      amount          TEXT,
      owner           TEXT,
      owner_id        TEXT,
      contact_id      TEXT,             -- ссылка на contacts; модель видит только её
      notes           TEXT,             -- история общения, телефоны, почты и имена закрыты
      has_open_deal   INTEGER DEFAULT 0,

      filter_status   TEXT DEFAULT 'pending',   -- pending | in | out
      filter_note     TEXT,
      check_status    TEXT DEFAULT 'pending',   -- pending | alive | dead | parked | liquidated
      check_note      TEXT,
      final_domain    TEXT,
      registry        TEXT,                     -- статус по ЕГРЮЛ, если проверяли
      revenue         TEXT,                     -- динамика выручки, если есть DataNewton
      context_status  TEXT DEFAULT 'pending',   -- pending | done
      context         TEXT,                     -- JSON от чтеца заметок
      signals_status  TEXT DEFAULT 'pending',   -- pending | done
      signals         TEXT,                     -- JSON от искателя сигналов
      score           REAL,
      score_note      TEXT,
      letter_status   TEXT DEFAULT 'none',      -- none | draft | approved | rejected | sent
      letter_subject  TEXT,
      letter_body     TEXT,
      delivered_at    TEXT,
      delivery_note   TEXT,
      batch_id        TEXT,
      updated_at      TEXT
    );
    CREATE TABLE IF NOT EXISTS contacts (     -- персональные данные: только на этом компьютере
      ext_id   TEXT PRIMARY KEY,
      name     TEXT,
      email    TEXT,
      phone    TEXT
    );
    CREATE TABLE IF NOT EXISTS batches (
      id          TEXT PRIMARY KEY,
      stage       TEXT,
      created_at  TEXT,
      status      TEXT DEFAULT 'open',          -- open | saved
      deal_ids    TEXT
    );
  `);
  // базы, созданные до появления колонок, дополняем на месте
  const cols = new Set(db.prepare('PRAGMA table_info(deals)').all().map((c) => c.name));
  for (const [c, type] of [['crm_note_hash', 'TEXT'], ['crm_noted_at', 'TEXT']]) {
    if (!cols.has(c)) db.exec(`ALTER TABLE deals ADD COLUMN ${c} ${type}`);
  }
  return db;
}

export const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export function all(sql, ...args) { return openDb().prepare(sql).all(...args); }
export function get(sql, ...args) { return openDb().prepare(sql).get(...args); }
export function run(sql, ...args) { return openDb().prepare(sql).run(...args); }

export function tx(fn) {
  const d = openDb();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; }
  catch (e) { d.exec('ROLLBACK'); throw e; }
}

// Настройки агента под конкретного человека. Файл my/config.json собирает
// ассистент по ответам на анкету (AGENTS.md, шаг 1). Всё, чего в нём нет, берётся отсюда.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';

export const MY = path.join(ROOT, 'my');
export const CONFIG_FILE = path.join(MY, 'config.json');

export const DEFAULTS = {
  source: 'file',                     // file | bitrix | amo | другое — тогда свой выгрузчик
  lost_stage: '',                     // для файла: текст стадии проигрыша, если в файле есть все сделки
  window_months: [6, 18],             // от и до: свежие ещё помнят отказ, старые уже не помнят нас
  exclude_reasons: ['дубл', 'спам', 'тест', 'нецелев', 'ошибочн'],
  country: 'RU',                      // RU | other | mixed — нужна ли проверка по ЕГРЮЛ
  signals: {                          // вес сигнала в баллах; 0 — не искать
    promise: 5,                       // обещанный повод: «вернёмся после…», и это «после» наступило
    hiring: 3,
    new_product: 3,
    expansion: 3,
    leadership_change: 3,
    growth: 2,
    domain_change: 2,
  },
  min_score: 3,                       // ниже — «пока тихо, не трогаем»
  batch: { context: 25, signals: 10, parallel: 5 },
  letters_per_pass: 20,
  models: {
    claude: { cheap: 'haiku', strong: 'sonnet' },
    codex: { cheap: '', strong: '' }, // ассистент вписывает по списку моделей в Codex
  },
  delivery: { mode: 'file', daily_limit: 30, bcc_self: true },  // file | crm | email
  crm_notes: true,                    // записывать найденное комментарием в карточку сделки (Битрикс24, amoCRM)
  crm_fields: { loss_reason: '', inn: '', site: '' },           // коды своих полей в CRM, если есть
};

export function loadConfig() {
  const user = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  const merged = { ...DEFAULTS, ...user };
  for (const k of ['signals', 'batch', 'models', 'delivery', 'crm_fields']) {
    merged[k] = { ...DEFAULTS[k], ...(user[k] ?? {}) };
  }
  merged.models.claude = { ...DEFAULTS.models.claude, ...(user.models?.claude ?? {}) };
  merged.models.codex = { ...DEFAULTS.models.codex, ...(user.models?.codex ?? {}) };
  merged._exists = fs.existsSync(CONFIG_FILE);
  return merged;
}

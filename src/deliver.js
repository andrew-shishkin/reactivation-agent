// Выдача утверждённых писем. Имя и почта подставляются здесь, на компьютере, —
// нейросеть их не видит. Три способа: файл для менеджера, задача в CRM, отправка с почты.

import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import { env, has, scrub } from './env.js';
import { all, get, run, now } from './db.js';
import { writeCsv } from './table.js';
import { OUT, signalSources, findings, verdict } from './stages.js';
import crypto from 'node:crypto';
import { ROOT } from './env.js';

// «Здравствуйте, {{имя}}!» без имени превращается в «Здравствуйте!»
export function merge(text, { name, company }) {
  const first = firstName(name);
  let s = String(text ?? '');
  s = first ? s.replace(/\{\{\s*имя\s*\}\}/gi, first) : s.replace(/,?\s*\{\{\s*имя\s*\}\}/gi, '');
  return s.replace(/\{\{\s*компания\s*\}\}/gi, company ?? '');
}

// В CRM имя хранится по-разному: «Петров Иван Сергеевич», «Иван Петров», «Иван».
// Обращаемся по имени (и отчеству, если оно есть).
function firstName(full) {
  const w = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '';
  if (w.length === 3 && /(вич|вна|ична|кызы|оглы)$/i.test(w[2])) return `${w[1]} ${w[2]}`;
  if (w.length >= 2 && /(ов|ев|ин|ын|ова|ева|ина|ына|ский|ская|цкий|цкая)$/i.test(w[0])) return w[1];
  return w[0];
}

function approved(limit) {
  return all(`SELECT d.*, c.name AS c_name, c.email AS c_email FROM deals d
              LEFT JOIN contacts c ON c.ext_id = d.contact_id
              WHERE d.letter_status = 'approved' ORDER BY d.score DESC LIMIT ?`, limit);
}

export function sentToday() {
  return get(`SELECT COUNT(*) n FROM deals WHERE letter_status = 'sent' AND delivered_at >= ?`, new Date().toISOString().slice(0, 10)).n;
}

// ---------- файл для менеджеров ----------

export function deliverFile() {
  const rows = approved(100000);
  if (!rows.length) return { count: 0 };
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `к-отправке-${new Date().toISOString().slice(0, 10)}.csv`);
  writeCsv(file, rows.map((d) => ({
    'Компания': d.company,
    'Кому': d.c_name ?? '',
    'Почта': d.c_email ?? '',
    'Тема': merge(d.letter_subject, { name: d.c_name, company: d.company }),
    'Письмо': merge(d.letter_body, { name: d.c_name, company: d.company }),
    'Почему сейчас': d.score_note,
    'Источники': signalSources(d.signals),
    'Ответственный': d.owner,
    'ID сделки': d.ext_id.replace(/^[a-z0-9]+:/, ''),
  })));
  for (const d of rows) run(`UPDATE deals SET letter_status = 'sent', delivered_at = ?, delivery_note = ? WHERE id = ?`, now(), 'в файле для менеджера', d.id);
  return { count: rows.length, file: path.relative(ROOT, file) };
}

// ---------- задача в CRM ----------

export async function deliverCrm(cfg) {
  const mod = cfg.source === 'bitrix' ? await import('./crm/bitrix.js') : cfg.source === 'amo' ? await import('./crm/amo.js') : null;
  if (!mod) throw new Error('Задачи в CRM ставятся для Битрикс24 и amoCRM. Для другой CRM выберите выдачу файлом.');
  // задачу можно поставить только по сделке из той же CRM: у сделок из файла её некуда ставить
  const prefix = cfg.source === 'bitrix' ? 'b24:' : 'amo:';
  const all = approved(100000);
  const rows = all.filter((d) => d.ext_id.startsWith(prefix));
  let done = 0; const errors = [];
  if (rows.length < all.length) errors.push(`${all.length - rows.length} писем по сделкам не из этой CRM — выдайте их файлом: --mode file`);
  for (const d of rows) {
    const letter = `Тема: ${merge(d.letter_subject, { name: d.c_name, company: d.company })}\n\n${merge(d.letter_body, { name: d.c_name, company: d.company })}`;
    try {
      await mod.createTask({
        dealId: d.ext_id,
        ownerId: d.owner_id,
        title: `Реактивация: ${d.company}`,
        text: `Почему сейчас: ${d.score_note}${signalSources(d.signals) ? `\n\nИсточники:\n${signalSources(d.signals)}` : ''}\n\nКому: ${d.c_name || 'контакт по сделке'}\n\nЧерновик письма:\n${letter}`,
      });
      run(`UPDATE deals SET letter_status = 'sent', delivered_at = ?, delivery_note = ? WHERE id = ?`, now(), 'задача в CRM', d.id);
      done++;
    } catch (e) { errors.push(`${d.company}: ${scrub(e.message)}`); }
  }
  return { count: done, errors };
}

// ---------- что нашёл агент — комментарием в карточку сделки ----------

// Пишем один раз, когда по сделке всё выяснено: компания отпала на проверке,
// история показала, что возвращаться не к чему, или сигналы уже поискали.
// Повторно — только если что-то изменилось (например, при перепроверке через месяц).
// В CRM только добавляется комментарий: поля, стадии и сама сделка не меняются.
export async function pushNotes(cfg, { deal } = {}) {
  if (!cfg.crm_notes) return { count: 0, note: 'Запись в карточки выключена в настройках (crm_notes).' };
  const mod = cfg.source === 'bitrix' ? await import('./crm/bitrix.js') : cfg.source === 'amo' ? await import('./crm/amo.js') : null;
  if (!mod) return { count: 0, note: 'Комментарии в карточки пишутся для Битрикс24 и amoCRM. Для сделок из файла всё найденное — в out/итог.csv.' };
  const prefix = cfg.source === 'bitrix' ? 'b24:' : 'amo:';
  const rows = all(`SELECT * FROM deals WHERE ext_id LIKE ? AND filter_status = 'in' AND (
                      check_status IN ('dead', 'parked', 'liquidated')
                      OR json_extract(context, '$.reactivatable') = 0
                      OR signals_status = 'done')
                    ${deal ? `AND (ext_id = ? OR ext_id LIKE ?)` : ''}`,
  prefix + '%', ...(deal ? [String(deal), `%:${deal}`] : []));
  let count = 0, skipped = 0; const errors = [];
  const date = new Date().toISOString().slice(0, 10).split('-').reverse().join('.');
  for (const d of rows) {
    const facts = findings(d);
    const v = verdict(d, cfg);
    const body = [...facts, ...(v ? [`Итог: ${v}`] : [])].join('\n');
    const hash = crypto.createHash('sha1').update(body).digest('hex');
    if (!facts.length || hash === d.crm_note_hash) { skipped++; continue; }
    try {
      await mod.addNote({ dealId: d.ext_id, text: `Агент реактивации, ${date}\n\n${body}` });
      run('UPDATE deals SET crm_note_hash = ?, crm_noted_at = ? WHERE id = ?', hash, now(), d.id);
      count++;
    } catch (e) { errors.push(`${d.company}: ${scrub(e.message)}`); }
  }
  return { count, skipped, errors };
}

// ---------- отправка с вашей почты ----------

// Свой SMTP-клиент на полсотни строк, чтобы не ставить библиотек.
// Почтовый ящик, пароль приложения и адрес сервера — в .env.
class Smtp {
  constructor(sock) { this.sock = sock; this.buf = ''; this.waiters = []; sock.on('data', (d) => this.onData(d)); }
  onData(d) {
    this.buf += d.toString();
    for (;;) {
      const lines = this.buf.split('\r\n');
      const end = lines.findIndex((l) => /^\d{3} /.test(l));
      if (end < 0) return;
      const reply = lines.slice(0, end + 1).join('\n');
      this.buf = lines.slice(end + 1).join('\r\n');
      this.waiters.shift()?.(reply);
    }
  }
  read() { return new Promise((r) => this.waiters.push(r)); }
  async cmd(line, ok = /^[23]/) {
    if (line != null) this.sock.write(line + '\r\n');
    const reply = await this.read();
    if (!ok.test(reply)) throw new Error(scrub(`почтовый сервер ответил: ${reply.split('\n').pop()}`));
    return reply;
  }
}

function connect({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    sock.setTimeout(30000, () => { sock.destroy(); reject(new Error('почтовый сервер не отвечает')); });
    sock.once(secure ? 'secureConnect' : 'connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const header = (s) => `=?UTF-8?B?${b64(s)}?=`;

async function sendOne(smtp, from, to, bcc, subject, body) {
  await smtp.cmd(`MAIL FROM:<${from}>`);
  await smtp.cmd(`RCPT TO:<${to}>`);
  if (bcc) await smtp.cmd(`RCPT TO:<${bcc}>`);
  await smtp.cmd('DATA', /^3/);
  const id = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${from.split('@')[1]}>`;
  const msg = [
    `From: ${from}`, `To: ${to}`, `Subject: ${header(subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${id}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    b64(body).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  await smtp.cmd(msg + '\r\n.');
}

export async function deliverEmail(cfg, { limit } = {}) {
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) if (!has(k)) throw new Error(`Для отправки с почты нужен ${k} в .env`);
  const left = Math.max(0, cfg.delivery.daily_limit - sentToday());
  const take = Math.min(left, limit ?? left);
  if (!take) return { count: 0, note: `сегодня уже отправлено ${sentToday()} из ${cfg.delivery.daily_limit} — остальное завтра` };
  const rows = approved(take).filter((d) => d.c_email);
  const noEmail = approved(100000).filter((d) => !d.c_email);
  for (const d of noEmail) run(`UPDATE deals SET delivery_note = ? WHERE id = ?`, 'нет почты контакта — не отправлено', d.id);

  const host = env('SMTP_HOST'), port = Number(env('SMTP_PORT') || 465), secure = env('SMTP_SECURE') !== 'no';
  const from = env('SMTP_FROM') || env('SMTP_USER');
  const sock = await connect({ host, port, secure });
  const smtp = new Smtp(sock);
  let sent = 0; const errors = [];
  try {
    await smtp.cmd(null);
    await smtp.cmd(`EHLO ${os.hostname().replace(/[^\w.-]/g, '') || 'localhost'}`);
    await smtp.cmd('AUTH LOGIN', /^3/);
    await smtp.cmd(b64(env('SMTP_USER')), /^3/);
    await smtp.cmd(b64(env('SMTP_PASSWORD')));
    for (const d of rows) {
      try {
        await sendOne(smtp, from, d.c_email, cfg.delivery.bcc_self ? from : '',
          merge(d.letter_subject, { name: d.c_name, company: d.company }),
          merge(d.letter_body, { name: d.c_name, company: d.company }));
        run(`UPDATE deals SET letter_status = 'sent', delivered_at = ?, delivery_note = ? WHERE id = ?`, now(), 'отправлено с почты', d.id);
        sent++;
        // пауза 20–40 секунд, чтобы не выглядеть рассылкой
        const pause = env('SEND_PAUSE_MS') ? Number(env('SEND_PAUSE_MS')) : 20000 + Math.random() * 20000;
        await new Promise((r) => setTimeout(r, pause));
      } catch (e) { errors.push(`${d.company}: ${e.message}`); await smtp.cmd('RSET').catch(() => {}); }
    }
    await smtp.cmd('QUIT', /^2/).catch(() => {});
  } finally { sock.end(); }
  return { count: sent, errors, noEmail: noEmail.length };
}

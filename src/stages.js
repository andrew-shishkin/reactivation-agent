// Шаги прогона. Код делает всё, что можно сделать без суждения: отсев, проверки,
// подсчёт баллов, сборку пачек и выдачу. Нейросети достаются только пачки
// с уже закрытыми персональными данными: прочитать историю, найти сигналы, написать письмо.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';
import { all, get, run, tx, now } from './db.js';
import { monthsAgo } from './text.js';
import { checkSite, checkRegistry, checkRevenue, pool } from './check.js';

export const WORK = path.join(ROOT, 'work');
export const OUT = path.join(ROOT, 'out');
const today = () => new Date().toISOString().slice(0, 10);

// ---------- 1. отсев ----------

export function filterDeals(cfg) {
  const [minM, maxM] = cfg.window_months;
  const excl = cfg.exclude_reasons.map((s) => s.toLowerCase()).filter(Boolean);
  const deals = all('SELECT id, company_key, closed_at, loss_reason, stage, has_open_deal FROM deals');
  const stats = { in: 0, window: 0, reason: 0, open: 0, dup: 0, nodate: 0 };
  const decided = new Map();

  for (const d of deals) {
    let out = '';
    if (d.has_open_deal) { out = 'по компании есть открытая сделка'; stats.open++; }
    else if (d.closed_at) {
      const m = monthsAgo(d.closed_at);
      if (m < minM) { out = `закрыта ${Math.round(m)} мес. назад — ещё рано`; stats.window++; }
      else if (m > maxM) { out = `закрыта ${Math.round(m)} мес. назад — слишком давно`; stats.window++; }
    }
    if (!out) {
      const reason = `${d.loss_reason} ${d.stage}`.toLowerCase();
      const hit = excl.find((w) => reason.includes(w));
      if (hit) { out = `причина проигрыша: «${hit}…» — не возвращаемся`; stats.reason++; }
    }
    decided.set(d.id, out);
  }

  // по одной сделке на компанию — самой свежей
  const best = new Map();
  for (const d of deals) {
    if (decided.get(d.id) || !d.company_key) continue;
    const cur = best.get(d.company_key);
    if (!cur || (d.closed_at ?? '') > (cur.closed_at ?? '')) best.set(d.company_key, d);
  }
  for (const d of deals) {
    if (!decided.get(d.id) && d.company_key && best.get(d.company_key)?.id !== d.id) {
      decided.set(d.id, 'по этой компании есть сделка свежее'); stats.dup++;
    }
  }

  tx(() => {
    for (const d of deals) {
      const out = decided.get(d.id);
      if (!out) { stats.in++; if (!d.closed_at) stats.nodate++; }
      run('UPDATE deals SET filter_status = ?, filter_note = ?, updated_at = ? WHERE id = ?',
        out ? 'out' : 'in', out || (d.closed_at ? '' : 'нет даты закрытия — давность не проверить'), now(), d.id);
    }
  });
  return { total: deals.length, ...stats };
}

// ---------- 2. жива ли компания ----------

export async function checkDeals(cfg, { limit = Infinity } = {}) {
  const todo = all(`SELECT id, domain, inn, country FROM deals
                    WHERE filter_status = 'in' AND check_status = 'pending' LIMIT ?`, Number.isFinite(limit) ? limit : -1);
  const stats = { checked: 0, alive: 0, dead: 0, parked: 0, liquidated: 0, warnings: new Set() };
  const wantRegistry = cfg.country !== 'other';

  await pool(todo, 8, async (d) => {
    const site = await checkSite(d.domain);
    let status = site.status, notes = [site.note], registry = null, revenue = null;
    const inn = d.inn || site.inn || '';

    if (status !== 'dead' && wantRegistry && inn) {
      const reg = await checkRegistry(inn);
      if (reg?.error) stats.warnings.add(reg.error);
      else if (reg) { registry = reg.note; if (reg.status === 'liquidated') status = 'liquidated'; }
      if (status === 'alive') {
        const rev = await checkRevenue(inn);
        if (rev?.error) stats.warnings.add(rev.error);
        else if (rev?.note) revenue = JSON.stringify(rev);
      }
    }
    if (registry) notes.push(registry);
    run(`UPDATE deals SET check_status = ?, check_note = ?, final_domain = ?, inn = ?, registry = ?, revenue = ?, updated_at = ?
         WHERE id = ?`, status, notes.join('; '), site.final_domain ?? '', inn, registry, revenue, now(), d.id);
    stats.checked++; stats[status]++;
  });
  stats.left = get(`SELECT COUNT(*) n FROM deals WHERE filter_status = 'in' AND check_status = 'pending'`).n;
  stats.warnings = [...stats.warnings];
  return stats;
}

// ---------- 3–4. пачки для субагентов ----------

const STAGES = {
  context: {
    where: `filter_status = 'in' AND check_status = 'alive' AND context_status = 'pending'`,
    item: (d) => ({
      id: d.id,
      company: d.company,
      closed_at: d.closed_at,
      months_ago: d.closed_at ? Math.round(monthsAgo(d.closed_at)) : null,
      deal_title: d.title,
      stage: d.stage,
      loss_reason: d.loss_reason,
      amount: d.amount,
      // свежее важнее старого: если история длинная, оставляем её конец
      history: (d.notes ?? '').length > 6000 ? '…' + d.notes.slice(-6000) : (d.notes ?? ''),
    }),
  },
  signals: {
    where: `filter_status = 'in' AND check_status = 'alive' AND context_status = 'done' AND signals_status = 'pending'
            AND COALESCE(json_extract(context, '$.reactivatable'), 1) != 0`,
    item: (d) => ({
      id: d.id,
      company: d.company,
      site: d.final_domain || d.domain,
      country: d.country,
      closed_at: d.closed_at,
      check: d.check_note,
      revenue: d.revenue ? JSON.parse(d.revenue).note : null,
      context: pickContext(d.context),
    }),
  },
};

function pickContext(json) {
  const c = json ? JSON.parse(json) : {};
  return { reason: c.reason, promise: c.promise, promise_date: c.promise_date, look_for: c.look_for, angle: c.angle };
}

export function batchNext(stage, size) {
  const st = STAGES[stage];
  if (!st) throw new Error(`Шаг «${stage}» не знаю. Есть: ${Object.keys(STAGES).join(', ')}`);
  const deals = all(`SELECT * FROM deals WHERE ${st.where} AND batch_id IS NULL ORDER BY closed_at DESC LIMIT ?`, size);
  if (!deals.length) return null;
  fs.mkdirSync(WORK, { recursive: true });
  const n = (get('SELECT COUNT(*) n FROM batches').n + 1).toString().padStart(3, '0');
  const id = `${stage}-${n}`;
  const file = path.join(WORK, `${id}.jsonl`);
  fs.writeFileSync(file, deals.map((d) => JSON.stringify(st.item(d))).join('\n') + '\n');
  tx(() => {
    run('INSERT INTO batches (id, stage, created_at, deal_ids) VALUES (?, ?, ?, ?)', id, stage, now(), JSON.stringify(deals.map((d) => d.id)));
    for (const d of deals) run('UPDATE deals SET batch_id = ? WHERE id = ?', id, d.id);
  });
  return { id, file: path.relative(ROOT, file), result: path.relative(ROOT, file.replace(/\.jsonl$/, '.result.jsonl')), count: deals.length };
}

function readJsonl(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [], bad = [];
  lines.forEach((l, i) => { try { rows.push(JSON.parse(l)); } catch { bad.push(i + 1); } });
  return { rows, bad };
}

export function batchSave(resultFile) {
  const abs = path.resolve(ROOT, resultFile);
  if (!fs.existsSync(abs)) throw new Error(`Нет файла ${resultFile}`);
  const id = path.basename(abs).replace(/\.result\.jsonl$/, '');
  const batch = get('SELECT * FROM batches WHERE id = ?', id);
  if (!batch) throw new Error(`Пачки ${id} нет в базе`);
  const ids = new Set(JSON.parse(batch.deal_ids));
  const { rows, bad } = readJsonl(abs);
  let saved = 0;
  const rejected = [];
  const missing = new Set(ids);

  tx(() => {
    for (const r of rows) {
      if (!ids.has(r.id)) continue;
      missing.delete(r.id);
      if (batch.stage === 'context') {
        run(`UPDATE deals SET context = ?, context_status = 'done', batch_id = NULL, updated_at = ? WHERE id = ?`,
          JSON.stringify(r), now(), r.id);
      } else if (batch.stage === 'signals') {
        run(`UPDATE deals SET signals = ?, signals_status = 'done', batch_id = NULL, updated_at = ? WHERE id = ?`,
          JSON.stringify(Array.isArray(r.signals) ? r.signals : []), now(), r.id);
      } else if (batch.stage === 'letters') {
        const problem = letterProblem(r, r.id);
        if (problem) {
          run('UPDATE deals SET batch_id = NULL, letter_status = ?, delivery_note = ? WHERE id = ?', 'none', problem, r.id);
          rejected.push(`№${r.id}: ${problem}`);
          continue;
        }
        run(`UPDATE deals SET letter_subject = ?, letter_body = ?, letter_status = 'draft', batch_id = NULL, updated_at = ? WHERE id = ?`,
          r.subject ?? '', r.body ?? '', now(), r.id);
      }
      saved++;
    }
    // чего не вернули — отпускаем, возьмётся в следующую пачку
    for (const d of missing) run('UPDATE deals SET batch_id = NULL WHERE id = ?', d);
    run(`UPDATE batches SET status = 'saved' WHERE id = ?`, id);
  });
  return { id, stage: batch.stage, saved, rejected, missing: missing.size, badLines: bad.length };
}

export function batchReset() {
  const open = all(`SELECT id FROM batches WHERE status = 'open'`);
  tx(() => {
    run(`UPDATE deals SET batch_id = NULL WHERE batch_id IN (SELECT id FROM batches WHERE status = 'open')`);
    run(`UPDATE batches SET status = 'saved' WHERE status = 'open'`);
  });
  return open.length;
}

// ---------- 5. баллы ----------

export function scoreDeals(cfg) {
  const w = cfg.signals;
  const deals = all(`SELECT id, context, signals, final_domain, revenue FROM deals
                     WHERE filter_status = 'in' AND check_status = 'alive' AND context_status = 'done'`);
  let scored = 0;
  tx(() => {
    for (const d of deals) {
      const ctx = d.context ? JSON.parse(d.context) : {};
      if (ctx.reactivatable === false) {
        run('UPDATE deals SET score = 0, score_note = ? WHERE id = ?', `не возвращаемся: ${ctx.why_not || ctx.reason || 'по истории'}`, d.id);
        continue;
      }
      // по каждому типу сигнала берём самый сильный довод: если код увидел, что срок
      // обещания прошёл, а искатель нашёл, что условие наступило, — это один повод, не два
      const best = new Map();
      const add = (type, pts, why) => {
        if (pts > 0 && pts > (best.get(type)?.pts ?? 0)) best.set(type, { pts, why });
      };
      const ru = (iso) => iso.split('-').reverse().join('.');

      if (ctx.promise && ctx.promise_date && ctx.promise_date <= today()) add('promise', w.promise ?? 0, `срок, к которому обещали вернуться, прошёл (${ru(ctx.promise_date)})`);
      if (d.final_domain) add('domain_change', w.domain_change ?? 0, `сайт переехал на ${d.final_domain}`);
      const rev = d.revenue ? JSON.parse(d.revenue) : null;
      if (rev?.growth >= 15) add('growth', w.growth ?? 0, `выручка ${rev.note.split(': ')[1]}`);

      const sig = d.signals ? JSON.parse(d.signals) : [];
      for (const g of sig) {
        const type = g.type in w ? g.type : 'other';
        const weight = type === 'other' ? 1 : (w[type] ?? 0);
        const strength = Math.max(1, Math.min(3, Number(g.strength) || 1));
        add(type, Math.round(weight * strength / 2 * 10) / 10, g.summary ? g.summary.slice(0, 90) : type);
      }
      const parts = [...best.values()].sort((a, b) => b.pts - a.pts);
      const s = Math.round(parts.reduce((a, p) => a + p.pts, 0) * 10) / 10;
      parts.splice(0, parts.length, ...parts.map((p) => `${p.why} +${p.pts}`));
      run('UPDATE deals SET score = ?, score_note = ?, updated_at = ? WHERE id = ?', s, parts.join('; ') || 'сигналов нет', now(), d.id);
      scored++;
    }
  });
  return { scored };
}

// ---------- 6. письма ----------

export function lettersNext(cfg, size) {
  const deals = all(`SELECT * FROM deals
                     WHERE filter_status = 'in' AND check_status = 'alive' AND score >= ? AND letter_status = 'none' AND batch_id IS NULL
                     ORDER BY score DESC LIMIT ?`, cfg.min_score, size);
  if (!deals.length) return null;
  fs.mkdirSync(WORK, { recursive: true });
  const n = (get('SELECT COUNT(*) n FROM batches').n + 1).toString().padStart(3, '0');
  const id = `letters-${n}`;
  const file = path.join(WORK, `${id}.jsonl`);
  fs.writeFileSync(file, deals.map((d) => JSON.stringify({
    id: d.id,
    company: d.company,
    closed_at: d.closed_at,
    loss_reason: d.loss_reason,
    context: d.context ? JSON.parse(d.context) : {},
    signals: d.signals ? JSON.parse(d.signals) : [],
    why_now: d.score_note,
  })).join('\n') + '\n');
  tx(() => {
    run('INSERT INTO batches (id, stage, created_at, deal_ids) VALUES (?, ?, ?, ?)', id, 'letters', now(), JSON.stringify(deals.map((d) => d.id)));
    for (const d of deals) run('UPDATE deals SET batch_id = ? WHERE id = ?', id, d.id);
  });
  return { id, file: path.relative(ROOT, file), result: path.relative(ROOT, file.replace(/\.jsonl$/, '.result.jsonl')), count: deals.length };
}

// Письмо пишется с {{имя}}, а не с именем. Если в тексте оказалась почта, телефон
// или настоящее имя контакта — значит, что-то просочилось: такое письмо не принимаем.
function letterProblem(r, id) {
  const text = `${r.subject ?? ''}\n${r.body ?? ''}`;
  if (!r.body) return 'пустое письмо';
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) return 'в письме адрес почты';
  if ((text.match(/\d/g) ?? []).length >= 10 && /(\+?\d[\d\s()-]{9,})/.test(text)) return 'в письме похоже на телефон';
  const c = get('SELECT c.name FROM deals d JOIN contacts c ON c.ext_id = d.contact_id WHERE d.id = ?', id);
  const low = text.toLowerCase();
  const leaked = (c?.name ?? '').split(/\s+/).filter((w) => w.length >= 4).some((w) => low.includes(w.toLowerCase().slice(0, -1)));
  if (leaked) return 'в письме настоящее имя контакта вместо {{имя}}';
  return '';
}

export function lettersReview() {
  const drafts = all(`SELECT id, company, score_note, letter_subject, letter_body FROM deals WHERE letter_status = 'draft' ORDER BY score DESC`);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'письма-на-проверку.md');
  const md = ['# Письма на проверку', '',
    'Вместо {{имя}} при отправке подставится имя контакта из CRM. Чтобы утвердить —',
    'напишите ассистенту «утверждаю все» или номера писем, которые убрать.', '',
    ...drafts.flatMap((d) => [`## №${d.id} · ${d.company}`, '', `**Почему сейчас:** ${d.score_note}`, '',
      `**Тема:** ${d.letter_subject}`, '', d.letter_body, '', '---', ''])];
  fs.writeFileSync(file, md.join('\n'));
  return { file: path.relative(ROOT, file), count: drafts.length };
}

export function lettersMark(status, ids) {
  const where = ids === 'all' ? `letter_status = 'draft'` : `letter_status = 'draft' AND id IN (${ids.map(Number).join(',')})`;
  return run(`UPDATE deals SET letter_status = ?, updated_at = ? WHERE ${where}`, status, now()).changes;
}

// ---------- повторный поиск поводов ----------

// У тех, у кого повода не было, через месяц он мог появиться.
export function recheck(cfg, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  return run(`UPDATE deals SET signals_status = 'pending', signals = NULL, score = NULL, score_note = NULL
              WHERE signals_status = 'done' AND letter_status IN ('none', 'rejected')
                AND COALESCE(score, 0) < ? AND updated_at < ?`, cfg.min_score, since).changes;
}

// ---------- сводка ----------

export function status(cfg) {
  const one = (sql) => get(sql).n;
  return {
    'всего сделок': one('SELECT COUNT(*) n FROM deals'),
    'прошли отсев': one(`SELECT COUNT(*) n FROM deals WHERE filter_status = 'in'`),
    'ждут проверки сайта': one(`SELECT COUNT(*) n FROM deals WHERE filter_status = 'in' AND check_status = 'pending'`),
    'живые': one(`SELECT COUNT(*) n FROM deals WHERE filter_status = 'in' AND check_status = 'alive'`),
    'мёртвые и закрытые': one(`SELECT COUNT(*) n FROM deals WHERE filter_status = 'in' AND check_status IN ('dead','parked','liquidated')`),
    'ждут чтения истории': one(`SELECT COUNT(*) n FROM deals WHERE ${STAGES.context.where}`),
    'ждут поиска сигналов': one(`SELECT COUNT(*) n FROM deals WHERE ${STAGES.signals.where}`),
    'с поводом написать': get(`SELECT COUNT(*) n FROM deals WHERE score >= ? AND score > 0`, cfg.min_score).n,
    'черновики писем': one(`SELECT COUNT(*) n FROM deals WHERE letter_status = 'draft'`),
    'утверждены, не отправлены': one(`SELECT COUNT(*) n FROM deals WHERE letter_status = 'approved'`),
    'отправлены или переданы': one(`SELECT COUNT(*) n FROM deals WHERE letter_status = 'sent'`),
    'пачки в работе': one(`SELECT COUNT(*) n FROM batches WHERE status = 'open'`),
  };
}

// ---------- итоговая таблица без персональных данных ----------

export function exportSummary() {
  const rows = all(`SELECT * FROM deals ORDER BY COALESCE(score, -1) DESC, closed_at DESC`).map((d) => {
    const ctx = d.context ? JSON.parse(d.context) : {};
    return {
      'Компания': d.company,
      'Сайт': d.final_domain || d.domain,
      'Закрыта': d.closed_at,
      'Причина проигрыша': d.loss_reason,
      'Отсев': d.filter_status === 'out' ? d.filter_note : 'прошла',
      'Жива ли': d.check_note ?? '',
      'Что было': ctx.reason ?? '',
      'Обещанный повод': [ctx.promise, ctx.promise_date].filter(Boolean).join(' — '),
      'Баллы': d.score ?? '',
      'Почему сейчас': d.score_note ?? '',
      'Письмо': { none: '', draft: 'черновик', approved: 'утверждено', rejected: 'отклонено', sent: 'отправлено' }[d.letter_status],
      'Ответственный': d.owner,
      'ID сделки': d.ext_id.replace(/^[a-z]+:/, ''),
    };
  });
  return rows;
}

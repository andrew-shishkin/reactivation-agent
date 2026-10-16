// Выгрузка проигранных сделок из amoCRM по долгосрочному токену.
// В .env: AMO_SUBDOMAIN (часть адреса до .amocrm.ru) и AMO_TOKEN.
// «Закрыто и не реализовано» в amoCRM — этап 143 в каждой воронке.

import { env, scrub } from '../env.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function base() {
  if (env('AMO_API_URL')) return env('AMO_API_URL'); // только для проверки на подставном сервере
  const sub = env('AMO_SUBDOMAIN').replace(/^https?:\/\//, '').replace(/\.amocrm\.(ru|com).*$/, '');
  if (!sub || !env('AMO_TOKEN')) throw new Error('Впишите AMO_SUBDOMAIN и AMO_TOKEN в .env');
  return `https://${sub}.amocrm.ru/api/v4`;
}

export async function call(path, { method = 'GET', body } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(170); // лимит amoCRM — около семи запросов в секунду
    let r;
    try {
      r = await fetch(base() + path, {
        method,
        headers: { Authorization: `Bearer ${env('AMO_TOKEN')}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      if (attempt === 3) throw new Error(scrub(`amoCRM недоступна: ${e.message}`));
      continue;
    }
    if (r.status === 429) { await sleep(2000); continue; }
    if (r.status === 204) return null;
    if (r.status === 401) throw new Error('amoCRM не приняла токен: проверьте AMO_TOKEN в .env и срок его действия');
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(scrub(`amoCRM, ${path.split('?')[0]}: HTTP ${r.status} ${data?.title ?? ''} ${data?.detail ?? ''}`));
    return data;
  }
  throw new Error('amoCRM не ответила после нескольких попыток');
}

async function list(path, key) {
  const rows = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const d = await call(`${path}${sep}limit=250&page=${page}`);
    const items = d?._embedded?.[key] ?? [];
    rows.push(...items);
    if (!d?._links?.next || !items.length) return rows;
  }
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const idsQs = (name, ids) => ids.map((id) => `filter[${name}][]=${id}`).join('&');

function field(entity, { code, name }) {
  for (const f of entity.custom_fields_values ?? []) {
    if ((code && f.field_code === code) || (name && name.test(f.field_name ?? ''))) {
      return (f.values ?? []).map((v) => v.value).filter(Boolean).join(', ');
    }
  }
  return '';
}

export async function exportLost(cfg, log = console.log) {
  const from = Math.floor((Date.now() - (cfg.window_months[1] + 1) * 30.44 * 86400000) / 1000);

  log('Воронки…');
  const pipelines = (await call('/leads/pipelines'))?._embedded?.pipelines ?? [];
  const statusQs = pipelines.map((p, i) => `filter[statuses][${i}][pipeline_id]=${p.id}&filter[statuses][${i}][status_id]=143`).join('&');

  log('Проигранные сделки…');
  const leads = await list(`/leads?${statusQs}&filter[closed_at][from]=${from}&with=contacts,loss_reason`, 'leads');
  log(`  найдено: ${leads.length}`);
  if (!leads.length) return [];

  const companyIds = [...new Set(leads.map((l) => l._embedded?.companies?.[0]?.id).filter(Boolean))];
  const contactIds = [...new Set(leads.map((l) => (l._embedded?.contacts?.find((c) => c.is_main) ?? l._embedded?.contacts?.[0])?.id).filter(Boolean))];

  log('Компании…');
  const companies = {};
  for (const ids of chunks(companyIds, 50)) for (const c of await list(`/companies?${idsQs('id', ids)}`, 'companies')) companies[c.id] = c;

  log('Контакты (остаются на этом компьютере)…');
  const contacts = {};
  for (const ids of chunks(contactIds, 50)) for (const c of await list(`/contacts?${idsQs('id', ids)}`, 'contacts')) contacts[c.id] = c;

  log('История общения: примечания…');
  const notes = {};
  for (const ids of chunks(leads.map((l) => l.id), 50)) {
    for (const n of await list(`/leads/notes?${idsQs('entity_id', ids)}`, 'notes')) {
      const text = n.params?.text ?? n.params?.service ?? '';
      if (!text) continue;
      (notes[n.entity_id] ??= []).push(`${new Date(n.created_at * 1000).toISOString().slice(0, 10)}: ${String(text).replace(/\s+/g, ' ').trim()}`);
    }
  }

  let users = {};
  try { for (const u of await list('/users', 'users')) users[u.id] = u.name; } catch { users = {}; }

  const innName = cfg.crm_fields.inn ? new RegExp(cfg.crm_fields.inn, 'i') : /ИНН/i;
  return leads.map((l) => {
    const co = companies[l._embedded?.companies?.[0]?.id] ?? {};
    const mainRef = l._embedded?.contacts?.find((c) => c.is_main) ?? l._embedded?.contacts?.[0];
    const ct = mainRef ? contacts[mainRef.id] : null;
    const reason = l._embedded?.loss_reason?.[0]?.name ?? (cfg.crm_fields.loss_reason ? field(l, { name: new RegExp(cfg.crm_fields.loss_reason, 'i') }) : '');
    return {
      ext_id: 'amo:' + l.id,
      title: l.name,
      company: co.name || l.name,
      site: field(co, { code: 'WEB' }),
      inn: field(co, { name: innName }),
      closed_at: l.closed_at || l.updated_at,
      loss_reason: reason,
      stage: 'Закрыто и не реализовано',
      amount: l.price ? String(l.price) : '',
      owner: users[l.responsible_user_id] || `сотрудник ${l.responsible_user_id}`,
      owner_id: String(l.responsible_user_id ?? ''),
      notes: (notes[l.id] ?? []).sort().join('\n'),
      contact: ct ? {
        ext_id: 'amoc:' + ct.id,
        name: ct.name ?? '',
        email: field(ct, { code: 'EMAIL' }).split(', ')[0] ?? '',
        phone: field(ct, { code: 'PHONE' }).split(', ')[0] ?? '',
      } : null,
    };
  });
}

// Примечание в карточку сделки: что нашёл агент, с источниками.
export async function addNote({ dealId, text }) {
  await call('/leads/notes', { method: 'POST', body: [{ entity_id: Number(dealId.replace(/^amo:/, '')), note_type: 'common', params: { text } }] });
}

export async function createTask({ dealId, ownerId, title, text }) {
  const id = Number(dealId.replace(/^amo:/, ''));
  await call('/tasks', {
    method: 'POST',
    body: [{ text: `${title}\n\n${text}`, complete_till: Math.floor(Date.now() / 1000) + 2 * 86400, entity_id: id, entity_type: 'leads', responsible_user_id: Number(ownerId) || undefined }],
  });
}

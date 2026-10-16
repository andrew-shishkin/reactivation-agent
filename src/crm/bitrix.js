// Выгрузка проигранных сделок из Битрикс24 через входящий вебхук.
// Адрес вебхука — в .env, BITRIX_WEBHOOK_URL. Права вебхука: CRM, задачи.
// Сделки, компании, контакты и история идут прямо в базу на этом компьютере,
// мимо нейросети: она увидит их уже без имён, почт и телефонов.

import { env, scrub } from '../env.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function base() {
  let u = env('BITRIX_WEBHOOK_URL');
  if (!u) throw new Error('Нет адреса вебхука: впишите BITRIX_WEBHOOK_URL в .env');
  return u.endsWith('/') ? u : u + '/';
}

// Битрикс принимает вложенные параметры только в виде filter[ID][0]=1
function qs(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') out.push(qs(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v ?? '')}`);
  }
  return out.filter(Boolean).join('&');
}

export async function call(method, params = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(550); // лимит Битрикс24 — около двух запросов в секунду
    let r;
    try {
      r = await fetch(base() + method + '.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      if (attempt === 3) throw new Error(scrub(`Битрикс24 недоступен: ${e.message}`));
      continue;
    }
    const data = await r.json().catch(() => ({}));
    if (data.error === 'QUERY_LIMIT_EXCEEDED') { await sleep(2000); continue; }
    if (data.error) throw new Error(scrub(`Битрикс24, ${method}: ${data.error_description || data.error}`));
    if (!r.ok) throw new Error(scrub(`Битрикс24, ${method}: HTTP ${r.status}`));
    return data;
  }
  throw new Error(`Битрикс24, ${method}: не ответил после нескольких попыток`);
}

async function list(method, params) {
  const rows = [];
  let start = 0;
  for (;;) {
    const d = await call(method, { ...params, start });
    rows.push(...(Array.isArray(d.result) ? d.result : d.result?.tasks ?? []));
    if (d.next == null) return rows;
    start = d.next;
  }
}

// до 50 команд за один запрос
async function batch(cmds) {
  const out = {};
  const keys = Object.keys(cmds);
  for (let i = 0; i < keys.length; i += 50) {
    const part = Object.fromEntries(keys.slice(i, i + 50).map((k) => [k, cmds[k]]));
    const d = await call('batch', { halt: 0, cmd: part });
    Object.assign(out, d.result?.result ?? {});
  }
  return out;
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const clean = (s) => String(s ?? '').replace(/\[\/?[a-z]+[^\]]*\]/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const multi = (v) => (Array.isArray(v) ? v.map((x) => x.VALUE).filter(Boolean).join(', ') : '');

export async function exportLost(cfg, log = console.log) {
  const fromDate = new Date(Date.now() - (cfg.window_months[1] + 1) * 30.44 * 86400000).toISOString().slice(0, 10);
  const lossField = cfg.crm_fields.loss_reason;

  log('Стадии воронок…');
  const stages = Object.fromEntries((await list('crm.status.list', {})).map((s) => [s.STATUS_ID, s.NAME]));

  log('Проигранные сделки…');
  const select = ['ID', 'TITLE', 'COMPANY_ID', 'CONTACT_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'CLOSEDATE', 'DATE_MODIFY',
    'ASSIGNED_BY_ID', 'STAGE_ID', 'COMMENTS', ...(lossField ? [lossField] : [])];
  const deals = await list('crm.deal.list', { filter: { STAGE_SEMANTIC_ID: 'F', '>=DATE_MODIFY': fromDate }, select, order: { ID: 'DESC' } });
  log(`  найдено: ${deals.length}`);
  if (!deals.length) return [];

  const companyIds = [...new Set(deals.map((d) => d.COMPANY_ID).filter((x) => x && x !== '0'))];
  const contactIds = [...new Set(deals.map((d) => d.CONTACT_ID).filter((x) => x && x !== '0'))];

  log('Компании и реквизиты…');
  const companies = {}, inns = {};
  for (const ids of chunks(companyIds, 50)) {
    for (const c of await list('crm.company.list', { filter: { ID: ids }, select: ['ID', 'TITLE', 'WEB', ...(cfg.crm_fields.inn ? [cfg.crm_fields.inn] : [])] })) companies[c.ID] = c;
    for (const r of await list('crm.requisite.list', { filter: { ENTITY_TYPE_ID: 4, ENTITY_ID: ids }, select: ['ENTITY_ID', 'RQ_INN'] })) {
      if (r.RQ_INN) inns[r.ENTITY_ID] = r.RQ_INN;
    }
  }

  log('Открытые сделки по тем же компаниям…');
  const openCompanies = new Set();
  for (const ids of chunks(companyIds, 50)) {
    for (const d of await list('crm.deal.list', { filter: { CLOSED: 'N', COMPANY_ID: ids }, select: ['COMPANY_ID'] })) openCompanies.add(d.COMPANY_ID);
  }

  log('Контакты (остаются на этом компьютере)…');
  const contacts = {};
  for (const ids of chunks(contactIds, 50)) {
    for (const c of await list('crm.contact.list', { filter: { ID: ids }, select: ['ID', 'NAME', 'SECOND_NAME', 'LAST_NAME', 'EMAIL', 'PHONE'] })) contacts[c.ID] = c;
  }

  log('История общения: комментарии и дела…');
  const cmds = {};
  for (const d of deals) {
    cmds[`c${d.ID}`] = 'crm.timeline.comment.list?' + qs({ filter: { ENTITY_ID: d.ID, ENTITY_TYPE: 'deal' }, select: ['COMMENT', 'CREATED'] });
    cmds[`a${d.ID}`] = 'crm.activity.list?' + qs({ filter: { OWNER_TYPE_ID: 2, OWNER_ID: d.ID }, select: ['SUBJECT', 'DESCRIPTION', 'CREATED'] });
  }
  const hist = await batch(cmds);

  let owners = {};
  try {
    const ids = [...new Set(deals.map((d) => d.ASSIGNED_BY_ID))];
    for (const u of await list('user.get', { filter: { ID: ids } })) owners[u.ID] = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ');
  } catch { owners = {}; } // у вебхука может не быть права на пользователей — тогда останутся номера

  return deals.map((d) => {
    const co = companies[d.COMPANY_ID] ?? {};
    const ct = contacts[d.CONTACT_ID];
    const notes = [
      ...(hist[`c${d.ID}`] ?? []).map((c) => ({ at: c.CREATED, text: clean(c.COMMENT) })),
      ...(hist[`a${d.ID}`] ?? []).map((a) => ({ at: a.CREATED, text: clean([a.SUBJECT, a.DESCRIPTION].filter(Boolean).join(': ')) })),
      ...(d.COMMENTS ? [{ at: d.DATE_MODIFY, text: clean(d.COMMENTS) }] : []),
    ].filter((n) => n.text).sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .map((n) => `${String(n.at).slice(0, 10)}: ${n.text}`).join('\n');
    return {
      ext_id: 'b24:' + d.ID,
      title: d.TITLE,
      company: co.TITLE || d.TITLE,
      site: multi(co.WEB),
      inn: inns[d.COMPANY_ID] || (cfg.crm_fields.inn ? co[cfg.crm_fields.inn] : ''),
      closed_at: d.CLOSEDATE || d.DATE_MODIFY,
      loss_reason: [stages[d.STAGE_ID], lossField ? d[lossField] : ''].filter(Boolean).join(': '),
      stage: stages[d.STAGE_ID] ?? d.STAGE_ID,
      amount: d.OPPORTUNITY ? `${d.OPPORTUNITY} ${d.CURRENCY_ID ?? ''}`.trim() : '',
      owner: owners[d.ASSIGNED_BY_ID] || `сотрудник ${d.ASSIGNED_BY_ID}`,
      owner_id: d.ASSIGNED_BY_ID,
      notes,
      has_open_deal: openCompanies.has(d.COMPANY_ID),
      contact: ct ? {
        ext_id: 'b24c:' + ct.ID,
        name: [ct.NAME, ct.SECOND_NAME, ct.LAST_NAME].filter(Boolean).join(' '),
        email: multi(ct.EMAIL).split(', ')[0] ?? '',
        phone: multi(ct.PHONE).split(', ')[0] ?? '',
      } : null,
    };
  });
}

// Задача ответственному по сделке — с поводом и готовым письмом в описании.
export async function createTask({ dealId, ownerId, title, text }) {
  const id = dealId.replace(/^b24:/, '');
  const deadline = new Date(Date.now() + 2 * 86400000).toISOString();
  await call('tasks.task.add', { fields: { TITLE: title, DESCRIPTION: text, RESPONSIBLE_ID: ownerId, UF_CRM_TASK: [`D_${id}`], DEADLINE: deadline } });
}

// Загрузка сделок в базу прогона: из файла или из CRM.
// Персональные данные (имя, почта, телефон контакта) уходят в отдельную таблицу
// и дальше этого компьютера не идут. В заметках они закрываются сразу при загрузке.

import { readTable } from './table.js';
import { tx, run, get, now } from './db.js';
import { parseDate, domainOf, normInn, companyKey, mask } from './text.js';

// Названия колонок в выгрузках разных CRM. Сравнение без регистра и пробелов.
const COLUMNS = {
  ext_id: ['id', 'idсделки', 'номерсделки', 'номер', 'dealid', 'recordid'],
  title: ['названиесделки', 'сделка', 'название', 'dealname', 'title', 'name'],
  company: ['компания', 'названиекомпании', 'клиент', 'организация', 'company', 'account', 'accountname', 'organization'],
  site: ['сайт', 'сайткомпании', 'web', 'website', 'domain', 'домен', 'url', 'companywebsite'],
  inn: ['инн', 'инн компании', 'inn', 'taxid'],
  closed_at: ['датазакрытия', 'закрыта', 'датапроигрыша', 'closedate', 'closedat', 'dateclosed', 'датаизменения', 'изменена', 'modified'],
  loss_reason: ['причинаотказа', 'причинапроигрыша', 'причина', 'причинапотери', 'lossreason', 'lostreason', 'closedlostreason'],
  stage: ['стадия', 'этап', 'статус', 'stage', 'dealstage', 'status'],
  amount: ['сумма', 'бюджет', 'amount', 'value', 'dealvalue', 'opportunity'],
  owner: ['ответственный', 'менеджер', 'owner', 'dealowner', 'responsible'],
  notes: ['комментарий', 'комментарии', 'примечание', 'примечания', 'заметки', 'описание', 'история', 'notes', 'comments', 'description', 'note'],
  contact_name: ['контакт', 'контактноелицо', 'фио', 'имяконтакта', 'contact', 'contactname', 'fullname'],
  email: ['email', 'e-mail', 'почта', 'рабочийe-mail', 'рабочийemail', 'электроннаяпочта', 'contactemail'],
  phone: ['телефон', 'рабочийтелефон', 'мобильныйтелефон', 'phone', 'contactphone'],
  country: ['страна', 'country'],
};

const norm = (s) => String(s).toLowerCase().replace(/[\s_.\-«»"]/g, '');

export function mapColumns(headers) {
  const map = {};
  const used = new Set();
  for (const [field, names] of Object.entries(COLUMNS)) {
    const wanted = names.map(norm);
    const hit = headers.find((h) => !used.has(h) && wanted.includes(norm(h)))
      ?? headers.find((h) => !used.has(h) && wanted.some((w) => w.length >= 5 && norm(h).includes(w)));
    if (hit) { map[field] = hit; used.add(hit); }
  }
  return map;
}

export function importFile(file, { lostStage = '' } = {}) {
  const rows = readTable(file);
  if (!rows.length) throw new Error('В файле нет строк');
  const map = mapColumns(Object.keys(rows[0]));
  const pick = (r, f) => (map[f] ? r[map[f]] : '');

  let skippedStage = 0;
  const records = [];
  rows.forEach((r, i) => {
    if (lostStage && map.stage && !norm(pick(r, 'stage')).includes(norm(lostStage))) { skippedStage++; return; }
    const ext = pick(r, 'ext_id') || `row-${i + 2}`;
    records.push({
      ext_id: 'f:' + ext,
      title: pick(r, 'title'),
      company: pick(r, 'company') || pick(r, 'title'),
      site: pick(r, 'site'),
      inn: pick(r, 'inn'),
      country: pick(r, 'country'),
      closed_at: pick(r, 'closed_at'),
      loss_reason: pick(r, 'loss_reason'),
      stage: pick(r, 'stage'),
      amount: pick(r, 'amount'),
      owner: pick(r, 'owner'),
      notes: pick(r, 'notes'),
      contact: { name: pick(r, 'contact_name'), email: pick(r, 'email'), phone: pick(r, 'phone') },
    });
  });
  const res = saveDeals(records);
  return { ...res, rows: rows.length, skippedStage, map };
}

// Общая запись для файла и для CRM. Повторная загрузка обновляет поля сделки,
// но не сбрасывает уже сделанные проверки.
export function saveDeals(records) {
  let added = 0, updated = 0;
  tx(() => {
    for (const d of records) {
      const contactId = d.contact && (d.contact.name || d.contact.email || d.contact.phone)
        ? (d.contact.ext_id ?? 'c:' + d.ext_id) : null;
      if (contactId) {
        run(`INSERT INTO contacts (ext_id, name, email, phone) VALUES (?, ?, ?, ?)
             ON CONFLICT(ext_id) DO UPDATE SET name = excluded.name, email = excluded.email, phone = excluded.phone`,
        contactId, d.contact.name ?? '', d.contact.email ?? '', d.contact.phone ?? '');
      }
      const names = [d.contact?.name].filter(Boolean);
      const domain = domainOf(d.site);
      const inn = normInn(d.inn);
      const row = {
        title: mask(d.title, names),
        company: d.company ?? '',
        company_key: companyKey({ inn, domain, company: d.company }),
        site: d.site ?? '',
        domain,
        inn,
        country: d.country ?? '',
        closed_at: parseDate(d.closed_at),
        loss_reason: mask(d.loss_reason, names),
        stage: d.stage ?? '',
        amount: d.amount ?? '',
        owner: d.owner ?? '',
        owner_id: d.owner_id ?? '',
        contact_id: contactId,
        notes: mask(d.notes, names),
        has_open_deal: d.has_open_deal ? 1 : 0,
      };
      const exists = get('SELECT id FROM deals WHERE ext_id = ?', d.ext_id);
      const cols = Object.keys(row);
      if (exists) {
        run(`UPDATE deals SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE ext_id = ?`,
          ...cols.map((c) => row[c]), now(), d.ext_id);
        updated++;
      } else {
        run(`INSERT INTO deals (ext_id, ${cols.join(', ')}, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
          d.ext_id, ...cols.map((c) => row[c]), now());
        added++;
      }
    }
  });
  return { added, updated };
}

// Мелкие разборы: даты, домены, ключ компании и закрытие персональных данных.

// Даты из выгрузок бывают какие угодно: 03.02.2025, 2025-02-03, 03/02/2025 14:20,
// 2025-02-03T11:00:00+03:00, а в amoCRM — секунды с 1970 года.
export function parseDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{9,10}$/.test(s)) return new Date(+s * 1000).toISOString().slice(0, 10);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

export function monthsAgo(dateStr, today = new Date()) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return (today - d) / (30.44 * 86400000);
}

export function domainOf(site) {
  let s = String(site ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.split(/[\s,;]+/)[0];
  if (s.includes('@')) s = s.split('@')[1];
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  return /\.[a-zа-я]{2,}$/i.test(s) ? s : '';
}

// Для сравнения «переехал ли сайт»: shop.lamoda.ru и lamoda.ru — один и тот же.
export function rootDomain(d) {
  const parts = String(d ?? '').split('.');
  const two = ['co.uk', 'com.au', 'com.br', 'co.jp', 'com.tr', 'msk.ru', 'spb.ru', 'com.ua', 'org.ru', 'net.ru'];
  const tail2 = parts.slice(-2).join('.');
  return two.includes(tail2) ? parts.slice(-3).join('.') : tail2;
}

export const normInn = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return /^\d{10}$|^\d{12}$/.test(d) ? d : '';
};

export function companyKey({ inn, domain, company }) {
  if (inn) return 'inn:' + inn;
  if (domain) return 'dom:' + rootDomain(domain);
  const n = String(company ?? '').toLowerCase()
    .replace(/["«»'`]/g, '')
    .replace(/\b(ооо|оао|зао|пао|ао|ип|llc|ltd|inc|gmbh|group|групп)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  return n ? 'name:' + n : '';
}

// ---------- персональные данные ----------

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
// телефоны: +7 (999) 123-45-67, 8 999 1234567, +44 20 7946 0958 — от 10 цифр с разделителями
const PHONE = /(?:(?:\+\d{1,3}|\b8)[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)\d{2,4}[\s-]?\d{2}[\s-]?\d{2}\b/g;
const INN_CONTEXT = /(ИНН|КПП|ОГРН|INN)\s*[:№]?\s*\d+/gi;

// Закрывает почты, телефоны и известные имена контактов. Имена берутся из таблицы
// контактов на этом компьютере: если в заметке написано «Иван Петров обещал…»,
// модель увидит «[контакт] обещал…». ИНН и ОГРН не трогаем — это данные компании.
export function mask(text, names = []) {
  let s = String(text ?? '');
  if (!s) return s;
  const keep = [];
  s = s.replace(INN_CONTEXT, (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; });
  s = s.replace(EMAIL, '[email]');
  s = s.replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 10 ? '[телефон]' : m));
  for (const n of names) {
    for (const re of namePatterns(n)) s = s.replace(re, '$1[контакт]');
  }
  s = s.replace(/(\[контакт\]\s*){2,}/g, '[контакт] ');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}

// «Петров Иван Сергеевич» → каждое слово от трёх букв. От длинных слов берём основу
// и разрешаем до трёх букв окончания, чтобы ловить «Петрову», «Петрова», «Ивану».
function namePatterns(full) {
  const words = String(full ?? '').split(/\s+/).filter((w) => w.length >= 3);
  return words
    .sort((a, b) => b.length - a.length)
    .map((w) => {
      const stem = w.length >= 4 ? w.slice(0, -1) : w;
      return new RegExp(`(^|[^\\p{L}])${escapeRe(stem)}\\p{L}{0,3}(?=[^\\p{L}]|$)`, 'giu');
    });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

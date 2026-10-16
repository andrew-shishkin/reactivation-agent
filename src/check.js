// Шаг «жива ли компания» — целиком кодом, без нейросети и без токенов.
// Сайт: открывается ли, не припаркован ли домен, не переехал ли на другой.
// ЕГРЮЛ: статус по ИНН через DaData (бесплатно до 10 000 запросов в сутки),
// выручка — через DataNewton, если есть ключ.

import { env, has, scrub } from './env.js';
import { rootDomain, normInn } from './text.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const PARKED = [
  /domain (is )?for sale/i, /buy this domain/i, /this domain (may be|is) for sale/i, /домен продается/i,
  /домен продаётся/i, /домен .{0,40}(зарегистрирован|припаркован)/i, /parked (free|domain)/i,
  /sedo(parking)?\.com/i, /dan\.com/i, /hugedomains/i, /afternic/i, /godaddy.{0,40}(parked|for sale)/i,
  /reg\.ru.{0,80}(домен|парковк)/i, /сайт (не опубликован|в разработке|временно недоступен)/i,
  /account (has been )?suspended/i, /аккаунт (заблокирован|приостановлен)/i, /срок (оплаты|регистрации).{0,40}истек/i,
];

async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' },
  });
  const reader = res.body?.getReader();
  let body = '', size = 0;
  if (reader) {
    const dec = new TextDecoder();
    while (size < 300000) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      body += dec.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
  }
  return { status: res.status, finalUrl: res.url, body };
}

// Мёртвым считаем только то, в чём уверены: домен не существует.
// Защита от ботов, бесконечные переадресации, таймауты и сбои сертификата у живых
// компаний бывают постоянно — из-за них компанию не выбрасываем.
function classify(e) {
  const c = String(e?.cause?.code ?? e?.code ?? '');
  const m = String(e?.cause?.message ?? e?.message ?? '');
  if (/ENOTFOUND/.test(c)) return { dead: true, text: 'домен не существует (DNS)' };
  if (/redirect count/i.test(m)) return { dead: false, text: 'сайт отвечает, но не пускает робота (защита)' };
  if (/ECONNREFUSED/.test(c)) return { dead: false, text: 'сервер не принимает соединения' };
  if (/CERT|SSL|TLS/i.test(c + m)) return { dead: false, text: 'ошибка сертификата' };
  if (e?.name === 'TimeoutError' || /ETIMEDOUT|timeout/i.test(c + m)) return { dead: false, text: 'не ответил за 15 секунд' };
  if (/EAI_AGAIN/.test(c)) return { dead: false, text: 'временный сбой DNS' };
  return { dead: false, text: (c || m || 'ошибка').slice(0, 80) };
}

export async function checkSite(domain) {
  if (!domain) return { status: 'alive', note: 'сайта нет в данных — проверяем по остальному' };
  const tries = [`https://${domain}`, `https://www.${domain}`, `http://${domain}`];
  let last = null;
  for (const url of tries) {
    try {
      const r = await fetchPage(url);
      if (r.status >= 500) { last = { dead: false, text: `сайт отвечает ошибкой ${r.status}` }; continue; }
      const finalHost = new URL(r.finalUrl).hostname.replace(/^www\./, '');
      const text = r.body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
      if (PARKED.some((re) => re.test(text)) && text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').length < 20000) {
        return { status: 'parked', note: 'домен припаркован или продаётся' };
      }
      const moved = rootDomain(finalHost) !== rootDomain(domain);
      const inn = findInn(text);
      return {
        status: 'alive',
        note: moved ? `сайт переехал на ${finalHost}` : (r.status >= 400 ? `сайт отвечает (код ${r.status}: защита от роботов или вход по паролю)` : 'сайт открывается'),
        final_domain: moved ? finalHost : '',
        inn,
      };
    } catch (e) {
      last = classify(e);
      if (last.dead) break;
    }
  }
  return last?.dead
    ? { status: 'dead', note: `сайт не открывается: ${last.text}` }
    : { status: 'alive', note: `проверить сайт не удалось: ${last?.text ?? 'нет ответа'} — считаем живой, решат реестр и новости` };
}

function findInn(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const m = text.match(/ИНН[\s:№/]*?(\d{10}|\d{12})(?!\d)/);
  return m ? normInn(m[1]) : '';
}

// ---------- ЕГРЮЛ ----------

const STATES = {
  ACTIVE: ['alive', 'действует'],
  REORGANIZING: ['alive', 'в процессе реорганизации'],
  LIQUIDATING: ['liquidated', 'ликвидируется'],
  LIQUIDATED: ['liquidated', 'ликвидирована'],
  BANKRUPT: ['liquidated', 'банкротство'],
};

export async function checkRegistry(inn) {
  inn = normInn(inn);
  if (!inn || !has('DADATA_KEY')) return null;
  try {
    const r = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${env('DADATA_KEY')}` },
      body: JSON.stringify({ query: inn }),
    });
    if (r.status === 401 || r.status === 403) return { error: 'DaData не принял ключ — проверьте DADATA_KEY в .env' };
    if (r.status === 429) return { error: 'DaData: дневной лимит запросов исчерпан, продолжим завтра' };
    if (!r.ok) return { error: scrub(`DaData ответил ${r.status}`) };
    const data = (await r.json())?.suggestions?.[0]?.data;
    if (!data) return { status: 'alive', note: 'в ЕГРЮЛ по этому ИНН ничего не нашлось' };
    const [status, word] = STATES[data.state?.status] ?? ['alive', data.state?.status ?? 'статус неизвестен'];
    return { status, note: `ЕГРЮЛ: ${word}` };
  } catch (e) {
    return { error: scrub(`DaData недоступен: ${e.message}`) };
  }
}

// Выручка по годам из DataNewton. Структура ответа у сервиса меняется, поэтому
// ищем строку 2110 («Выручка») по всему ответу, а не по жёсткому пути.
export async function checkRevenue(inn) {
  inn = normInn(inn);
  if (!inn || !has('DATANEWTON_KEY')) return null;
  try {
    const url = `https://api.datanewton.ru/v1/finance?key=${encodeURIComponent(env('DATANEWTON_KEY'))}&inn=${inn}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return { error: `DataNewton ответил ${r.status}` };
    const byYear = {};
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (k === '2110' && v && typeof v === 'object') {
          for (const [y, val] of Object.entries(v)) if (/^20\d\d$/.test(y) && typeof val === 'number') byYear[y] = val;
        } else walk(v);
      }
    })(await r.json());
    const years = Object.keys(byYear).sort().slice(-2);
    if (years.length < 2) return { note: 'выручки за два года в ответе нет' };
    const [a, b] = years.map((y) => byYear[y]);
    const pct = a ? Math.round(((b - a) / Math.abs(a)) * 100) : null;
    // единицы у отчётности разные (рубли или тысячи), поэтому показываем только изменение
    if (pct == null) return { note: `выручка за ${years[0]} нулевая, за ${years[1]} есть` };
    return { note: `выручка ${years[0]}→${years[1]}: ${pct > 0 ? '+' : ''}${pct}%`, growth: pct };
  } catch (e) {
    return { error: scrub(`DataNewton недоступен: ${e.message}`) };
  }
}

export async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

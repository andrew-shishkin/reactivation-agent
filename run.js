#!/usr/bin/env node
// Агент реактивации закрытой базы. Команды запускает ассистент (Claude Code или Codex),
// а не человек: порядок работы — в AGENTS.md.
//
//   node run.js doctor                      готово ли всё к работе
//   node run.js import --file data/x.csv    загрузить сделки из CSV или Excel
//   node run.js import --crm bitrix|amo     выгрузить проигранные сделки из CRM
//   node run.js filter                      отсев по давности, причине и дублям
//   node run.js check [--limit N]           жив ли сайт, статус в ЕГРЮЛ
//   node run.js batch next context|signals  пачка для субагента
//   node run.js batch save <файл>           принять ответ субагента
//   node run.js batch reset                 отпустить брошенные пачки
//   node run.js score                       баллы по сигналам
//   node run.js letters next                пачка для письма
//   node run.js letters review              файл с письмами на проверку
//   node run.js letters approve all|1,2,3   утвердить
//   node run.js letters reject 1,2,3        отклонить
//   node run.js deliver [--limit N]         выдать утверждённые: файл, CRM или почта
//   node run.js notes [--deal N]            записать найденное комментарием в карточки сделок в CRM
//   node run.js recheck [--days 30]         снова искать поводы у тех, у кого их не было
//   node run.js export                      итоговая таблица без персональных данных
//   node run.js status                      сколько на каком шаге

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, has, die, ROOT } from './src/env.js';
import { loadConfig, CONFIG_FILE } from './src/config.js';
import { importFile, saveDeals } from './src/importer.js';
import * as st from './src/stages.js';
import { deliverFile, deliverCrm, deliverEmail, sentToday, pushNotes } from './src/deliver.js';
import { writeCsv } from './src/table.js';

loadEnv();
const [cmd, sub, ...rest] = process.argv.slice(2);
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const cfg = loadConfig();

const say = (s = '') => console.log(s);
const table = (o) => { for (const [k, v] of Object.entries(o)) say(`  ${k}: ${v}`); };

try {
  switch (cmd) {
    case 'doctor': {
      const [major] = process.versions.node.split('.').map(Number);
      say(`Node.js ${process.versions.node}: ${major >= 22 ? 'подходит' : 'нужна версия 22 или выше'}`);
      say(`Настройки (my/config.json): ${cfg._exists ? 'есть' : 'ещё нет — их соберёт ассистент по анкете'}`);
      say(`Описание оффера (my/offer.md): ${fs.existsSync(path.join(ROOT, 'my', 'offer.md')) ? 'есть' : 'ещё нет'}`);
      say(`Сигналы (my/signals.md): ${fs.existsSync(path.join(ROOT, 'my', 'signals.md')) ? 'есть' : 'ещё нет'}`);
      say(`Файл .env: ${fs.existsSync(path.join(ROOT, '.env')) ? 'есть' : 'нет'}`);
      for (const [k, what] of [['BITRIX_WEBHOOK_URL', 'Битрикс24'], ['AMO_TOKEN', 'amoCRM'], ['DADATA_KEY', 'ЕГРЮЛ через DaData'],
        ['DATANEWTON_KEY', 'выручка через DataNewton'], ['SMTP_PASSWORD', 'отправка с почты']]) {
        say(`  ${what}: ${has(k) ? 'ключ вписан' : 'не подключено'}`);
      }
      break;
    }

    case 'import': {
      let res;
      if (opt('file')) {
        const file = path.resolve(ROOT, opt('file'));
        if (!fs.existsSync(file)) die(`Нет файла ${opt('file')}`);
        res = importFile(file, { lostStage: cfg.lost_stage });
        say(`Строк в файле: ${res.rows}${res.skippedStage ? `, не в стадии «${cfg.lost_stage}»: ${res.skippedStage}` : ''}`);
        say(`Распознаны колонки: ${Object.entries(res.map).map(([k, v]) => `${k} ← «${v}»`).join(', ')}`);
        for (const need of ['company', 'closed_at']) if (!res.map[need]) say(`  ! не нашёл колонку для «${need}» — проверьте заголовки`);
        if (!res.map.site && !res.map.inn) say('  ! нет ни сайта, ни ИНН: проверить, жива ли компания, будет не по чему');
        if (!res.map.notes) say('  ! нет колонки с историей общения: повод из заметок искать будет не в чем');
      } else if (opt('crm')) {
        const name = opt('crm');
        const mod = name === 'bitrix' ? await import('./src/crm/bitrix.js') : name === 'amo' ? await import('./src/crm/amo.js') : null;
        if (!mod) die('Готовые выгрузки есть для bitrix и amo. Для другой CRM ассистент пишет выгрузку сам (AGENTS.md).');
        const records = await mod.exportLost(cfg, (s) => say(s));
        res = saveDeals(records);
      } else die('Укажите --file <путь> или --crm bitrix|amo');
      say(`Новых сделок: ${res.added}, обновлено: ${res.updated}`);
      break;
    }

    case 'filter': {
      const r = st.filterDeals(cfg);
      say(`Всего: ${r.total}. Прошли отсев: ${r.in}`);
      say(`  вне окна ${cfg.window_months[0]}–${cfg.window_months[1]} мес.: ${r.window}; причина «не возвращаемся»: ${r.reason}; есть открытая сделка: ${r.open}; дубли компании: ${r.dup}`);
      if (r.nodate) say(`  без даты закрытия, давность не проверена: ${r.nodate}`);
      break;
    }

    case 'check': {
      const r = await st.checkDeals(cfg, { limit: opt('limit') ? Number(opt('limit')) : Infinity, deal: opt('deal') });
      say(`Проверено: ${r.checked}. Живые: ${r.alive}, сайт не открывается: ${r.dead}, домен припаркован: ${r.parked}, ликвидированы: ${r.liquidated}`);
      if (r.left) say(`Осталось проверить: ${r.left}`);
      for (const w of r.warnings) say(`  ! ${w}`);
      if (cfg.country !== 'other' && !has('DADATA_KEY')) say('  ЕГРЮЛ не проверялся: нет DADATA_KEY в .env');
      break;
    }

    case 'batch': {
      if (sub === 'next') {
        const stage = rest[0];
        const size = Number(opt('size')) || cfg.batch[stage] || 20;
        const b = st.batchNext(stage, size, { deal: opt('deal') });
        if (!b) { say(`Для шага «${stage}» больше ничего нет.`); break; }
        say(`Пачка ${b.id}: ${b.count} сделок`);
        say(`  читать: ${b.file}`);
        say(`  ответ писать в: ${b.result}`);
      } else if (sub === 'save') {
        const r = st.batchSave(rest[0]);
        say(`Пачка ${r.id} (${r.stage}): сохранено ${r.saved}${r.missing ? `, без ответа ${r.missing} — вернутся в следующую пачку` : ''}${r.badLines ? `, непонятных строк ${r.badLines}` : ''}`);
        for (const x of r.rejected) say(`  ! письмо не принято, ${x} — вернётся в следующую пачку писем`);
        if (r.noSource) say(`  ! сигналов без ссылки на источник отброшено: ${r.noSource}`);
      } else if (sub === 'reset') {
        say(`Отпущено пачек: ${st.batchReset()}`);
      } else die('batch next <шаг> | batch save <файл> | batch reset');
      break;
    }

    case 'score': {
      const r = st.scoreDeals(cfg);
      say(`Посчитано: ${r.scored}. С поводом написать (от ${cfg.min_score} баллов): ${st.status(cfg)['с поводом написать']}`);
      break;
    }

    case 'letters': {
      if (sub === 'next') {
        const b = st.lettersNext(cfg, Number(opt('size')) || cfg.letters_per_pass, { deal: opt('deal') });
        if (!b) { say('Новых писем писать не по кому.'); break; }
        say(`Пачка ${b.id}: ${b.count} писем`);
        say(`  читать: ${b.file}`);
        say(`  ответ писать в: ${b.result}`);
      } else if (sub === 'review') {
        const r = st.lettersReview();
        say(`Черновиков: ${r.count}. Файл: ${r.file}`);
      } else if (sub === 'approve' || sub === 'reject') {
        const ids = rest[0] === 'all' ? 'all' : String(rest[0] ?? '').split(',').filter(Boolean);
        if (ids !== 'all' && !ids.length) die('Укажите all или номера через запятую');
        say(`${sub === 'approve' ? 'Утверждено' : 'Отклонено'}: ${st.lettersMark(sub === 'approve' ? 'approved' : 'rejected', ids)}`);
      } else die('letters next | review | approve all|1,2 | reject 1,2');
      break;
    }

    case 'deliver': {
      const mode = opt('mode') || cfg.delivery.mode;
      if (mode === 'file') {
        const r = deliverFile();
        say(r.count ? `Писем в файле: ${r.count}. Файл: ${r.file} — в нём имена и почты, открывает только человек.` : 'Утверждённых писем нет.');
      } else if (mode === 'crm') {
        const r = await deliverCrm(cfg);
        say(`Задач поставлено: ${r.count}`);
        for (const e of r.errors) say(`  ! ${e}`);
      } else if (mode === 'email') {
        const r = await deliverEmail(cfg, { limit: opt('limit') ? Number(opt('limit')) : undefined });
        say(r.note ?? `Отправлено: ${r.count}. Сегодня всего: ${sentToday()} из ${cfg.delivery.daily_limit}`);
        if (r.noEmail) say(`  у ${r.noEmail} контактов нет почты — они в файле через --mode file`);
        for (const e of r.errors ?? []) say(`  ! ${e}`);
      } else die('Способ выдачи: file, crm или email');
      break;
    }

    case 'notes': {
      const r = await pushNotes(cfg, { deal: opt('deal') });
      say(r.note ?? `Комментариев в карточки сделок записано: ${r.count}${r.skipped ? `, без изменений с прошлого раза: ${r.skipped}` : ''}`);
      for (const e of r.errors ?? []) say(`  ! ${e}`);
      break;
    }

    case 'recheck': {
      const days = Number(opt('days')) || 30;
      say(`Вернул в поиск сигналов: ${st.recheck(cfg, days)} (без повода, проверялись больше ${days} дней назад)`);
      break;
    }

    case 'export': {
      fs.mkdirSync(st.OUT, { recursive: true });
      const file = path.join(st.OUT, 'итог.csv');
      const rows = st.exportSummary();
      writeCsv(file, rows);
      say(`Итоговая таблица: ${path.relative(ROOT, file)} (${rows.length} строк, без имён и почт)`);
      break;
    }

    case 'status': {
      say('Где сейчас база:');
      table(st.status(cfg));
      break;
    }

    default:
      say(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(3)).join('\n'));
  }
} catch (e) {
  die(`Ошибка: ${e.message}`);
}

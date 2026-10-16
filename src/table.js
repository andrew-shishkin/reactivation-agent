// Чтение и запись таблиц: CSV (любой разделитель, кавычки, BOM) и Excel .xlsx.
// Excel читается без сторонних библиотек: это zip с XML внутри.

import fs from 'node:fs';
import zlib from 'node:zlib';

export function readTable(file) {
  if (/\.xlsx$/i.test(file)) return readXlsx(file);
  if (/\.xls$/i.test(file)) throw new Error('Старый формат .xls не читается. Откройте файл в Excel и сохраните как .xlsx или CSV.');
  return readCsv(fs.readFileSync(file, 'utf8'));
}

// ---------- CSV ----------

export function readCsv(text) {
  text = text.replace(/^﻿/, '');
  const head = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : text.length);
  const sep = [';', ',', '\t'].sort((a, b) => count(head, b) - count(head, a))[0];

  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return toObjects(rows);
}

const count = (s, ch) => s.split(ch).length - 1;

function toObjects(rows) {
  if (!rows.length) return [];
  const cols = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => Object.fromEntries(cols.map((c, i) => [c, String(r[i] ?? '').trim()])));
}

// BOM и точка с запятой — чтобы русский Excel открыл файл двойным щелчком без кракозябр.
export function writeCsv(file, rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const cell = (v) => {
    if (v == null) return '';
    // переносы строк внутри письма сохраняем: в кавычках Excel их понимает
    const s = String(v).replace(/\r\n/g, '\n').trim();
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))];
  fs.writeFileSync(file, '﻿' + lines.join('\n') + '\n');
}

// ---------- XLSX ----------

function unzip(buf) {
  // конец центрального каталога
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Файл не похож на .xlsx');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

const xmlText = (s) => s
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');

function readXlsx(file) {
  const z = unzip(fs.readFileSync(file));
  const shared = z['xl/sharedStrings.xml']
    ? [...z['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join(''))
    : [];
  const sheetName = Object.keys(z).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!sheetName) throw new Error('В .xlsx не нашлось листа');
  const xml = z[sheetName]();

  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1] ?? '';
      const col = [...ref].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const type = attrs.match(/t="(\w+)"/)?.[1];
      const body = cm[2] ?? '';
      let v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
      if (type === 's') v = shared[+v] ?? '';
      else if (type === 'inlineStr') v = xmlText(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? '');
      else v = xmlText(v);
      // даты Excel хранит числом дней от 1899-12-30
      if (/s="\d+"/.test(attrs) && /^\d{5}(\.\d+)?$/.test(v) && +v > 30000 && +v < 60000) {
        v = new Date(Date.UTC(1899, 11, 30) + Math.round(+v * 86400000)).toISOString().slice(0, 10);
      }
      row[col >= 0 ? col : row.length] = v;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return toObjects(rows.filter((r) => r.some((v) => String(v).trim() !== '')));
}

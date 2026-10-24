#!/usr/bin/env node
// Готовит игру для SD-карты Cardputer: dist-cardputer/games/space-arena/
//   index.html (как есть), manifest.json, ресурсы js/css/json только в виде .gz
//   (прошивка сама отдаёт X.gz по запросу X, с Content-Encoding: gzip).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'dist');
const id = 'space-arena';
const out = path.join(root, 'dist-cardputer', 'games', id);
if (!fs.existsSync(path.join(src, 'index.html'))) { console.error('нет dist/: сначала npm run build'); process.exit(1); }

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const manifest = {
  title: 'Space Arena',
  description: 'Космический бой на векторной арене: от лица пилота, 1–4 игрока и боты. Одному или по сети.',
  min: 1,
  max: 4,
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

let plain = 0, packed = 0;
function copy(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, e.name);
    const to = path.join(out, rel, e.name);
    if (e.isDirectory()) { copy(from, path.join(rel, e.name)); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const buf = fs.readFileSync(from);
    plain += buf.length;
    if (/\.(js|css|json|svg|txt)$/.test(e.name) && e.name !== 'manifest.json') {
      const gz = zlib.gzipSync(buf, { level: 9 });
      fs.writeFileSync(to + '.gz', gz);
      packed += gz.length;
      console.log(`  ${path.join(rel, e.name)}  ${(buf.length / 1024).toFixed(1)} КБ → ${(gz.length / 1024).toFixed(1)} КБ (.gz)`);
    } else {
      fs.writeFileSync(to, buf);
      packed += buf.length;
      console.log(`  ${path.join(rel, e.name)}  ${(buf.length / 1024).toFixed(1)} КБ`);
    }
  }
}
copy(src);
console.log(`Готово: ${out}\nВсего ${(plain / 1024).toFixed(0)} КБ → ${(packed / 1024).toFixed(0)} КБ на SD. Скопируйте папку ${id}/ в /games/ на карту.`);

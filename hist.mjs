// Günlük mum (5 yıl) -> data/h/  |   Gün içi 5 dakikalık mum (son seans) -> data/i/
// Önce update.mjs ile data/bist.json ve data/nasdaq.json oluşmuş olmalı.
import fs from 'node:fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jobs = { bist: { suffix: '.IS', top: 1000 }, nasdaq: { suffix: '', top: 300 } };  // NASDAQ'ta en yüksek işlem hacimli 300 hisse
const sets = [['5y', '1d', 'h'], ['1d', '5m', 'i']];

for (const [mk, { suffix, top }] of Object.entries(jobs)) {
  const d = JSON.parse(fs.readFileSync(`data/${mk}.json`, 'utf8'));
  const syms = d.stocks.filter(s => mk === 'bist' || !(s.sym.length === 5 && /[WUR]$/.test(s.sym)))
    .sort((a, b) => (b.vol * b.price || 0) - (a.vol * a.price || 0)).slice(0, top).map(s => s.sym);
  for (const [range, interval, dir] of sets) {
    fs.mkdirSync(`data/${dir}/${mk}`, { recursive: true });
    let ok = 0, i = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (i < syms.length) {
        const sym = syms[i++];
        for (let a = 0; a < 3; a++) {
          try {
            const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}${suffix}?range=${range}&interval=${interval}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (r.status === 429) { await sleep(2000 * (a + 1)); continue; }
            if (!r.ok) break;
            const res = (await r.json()).chart?.result?.[0], t = res?.timestamp, q = res?.indicators?.quote?.[0];
            if (!t || !q) break;
            const rows = [];
            t.forEach((ts, k) => { if ([q.open[k], q.high[k], q.low[k], q.close[k]].every(v => v != null))
              rows.push([ts * 1000, +q.open[k].toFixed(4), +q.high[k].toFixed(4), +q.low[k].toFixed(4), +q.close[k].toFixed(4), q.volume[k] || 0]); });
            if (rows.length) { fs.writeFileSync(`data/${dir}/${mk}/${sym}.json`, JSON.stringify(rows)); ok++; }
            break;
          } catch { await sleep(1000); }
        }
        await sleep(120);
      }
    }));
    console.log(`${mk} ${dir === 'h' ? 'günlük' : 'gün içi'}: ${ok}/${syms.length} hisse alındı`);
  }
}

// Kullanım: node update.mjs bist | node update.mjs nasdaq
import fs from 'node:fs';
const mkt = process.argv[2] || 'bist';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = { 'User-Agent': 'Mozilla/5.0' };

async function symbols() {
  if (mkt === 'bist')
    return fs.readFileSync('bist-symbols.txt', 'utf8').split(/\s+/).filter(Boolean).map(s => [s, s + '.IS']);
  const t = await (await fetch('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt')).text();
  return t.split('\n').slice(1).map(l => l.split('|'))
    .filter(c => /^[A-Z]{1,5}$/.test(c[0]) && c[3] === 'N' && c[6] === 'N')   // test issue ve ETF olmayanlar
    .map(c => [c[0], c[0], c[1]]);
}

async function quote([sym, ys, fallbackName]) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?range=1d&interval=1d`, { headers: UA });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) return null;
      const m = (await r.json()).chart?.result?.[0]?.meta;
      if (!m?.regularMarketPrice) return null;
      const p = m.regularMarketPrice, prev = m.chartPreviousClose;
      return { sym, name: m.longName || m.shortName || fallbackName || sym, cur: m.currency, price: p, prev,
               chg: prev ? (p / prev - 1) * 100 : 0, vol: m.regularMarketVolume, hi: m.regularMarketDayHigh,
               lo: m.regularMarketDayLow, h52: m.fiftyTwoWeekHigh, l52: m.fiftyTwoWeekLow };
    } catch { await sleep(1000); }
  }
  return null;
}

const list = await symbols();
const out = [];
let idx = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (idx < list.length) { const q = await quote(list[idx++]); if (q) out.push(q); await sleep(120); }
}));

console.log(`${mkt}: ${out.length}/${list.length} hisse alındı`);
if (out.length < list.length * 0.5) { console.error('Çok az veri geldi, eski dosya korunuyor.'); process.exit(1); }
out.sort((a, b) => a.sym.localeCompare(b.sym));
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(`data/${mkt}.json`, JSON.stringify({ updated: new Date().toISOString(), count: out.length, stocks: out }));

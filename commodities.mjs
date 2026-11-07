// Emtia, döviz, kripto ve endeks verisi (Yahoo Finance)
//   data/emtia.json            -> anlık fiyat + 1 hafta / 1 ay / 1 yıl değişim
//   data/h/emtia/<ID>.json     -> 5 yıllık günlük mum   [t,o,h,l,c,v]  (hisselerle aynı format)
//   data/i/emtia/<ID>.json     -> gün içi 5 dakikalık mum
// Kullanım: node commodities.mjs
import fs from 'node:fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = { 'User-Agent': 'Mozilla/5.0' };

// id, ad, grup, Yahoo sembolü, birim
export const ITEMS = [
  ['BRENT',    'Brent Petrol',      'Enerji',  'BZ=F',     '$/varil'],
  ['WTI',      'WTI Ham Petrol',    'Enerji',  'CL=F',     '$/varil'],
  ['NATGAS',   'Doğalgaz',          'Enerji',  'NG=F',     '$/MMBtu'],
  ['GOLD',     'Altın (ons)',       'Metal',   'GC=F',     '$/ons'],
  ['SILVER',   'Gümüş (ons)',       'Metal',   'SI=F',     '$/ons'],
  ['COPPER',   'Bakır',             'Metal',   'HG=F',     '$/lb'],
  ['PLATINUM', 'Platin',            'Metal',   'PL=F',     '$/ons'],
  ['WHEAT',    'Buğday',            'Tarım',   'ZW=F',     '¢/bushel'],
  ['CORN',     'Mısır',             'Tarım',   'ZC=F',     '¢/bushel'],
  ['SUGAR',    'Şeker',             'Tarım',   'SB=F',     '¢/lb'],
  ['COFFEE',   'Kahve',             'Tarım',   'KC=F',     '¢/lb'],
  ['COTTON',   'Pamuk',             'Tarım',   'CT=F',     '¢/lb'],
  ['USDTRY',   'USD / TRY',         'Döviz',   'USDTRY=X', '₺'],
  ['EURTRY',   'EUR / TRY',         'Döviz',   'EURTRY=X', '₺'],
  ['BTC',      'Bitcoin',           'Kripto',  'BTC-USD',  '$'],
  ['BIST100',  'BIST 100',          'Endeks',  'XU100.IS', 'puan'],
  ['SP500',    'S&P 500',           'Endeks',  '^GSPC',    'puan'],
  ['NASDAQ100','NASDAQ 100',        'Endeks',  '^NDX',     'puan'],
];
const OZ = 31.1035;   // 1 troy ons = 31,1035 gram

async function yahoo(sym, range, interval) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`, { headers: UA });
      if (r.status === 429) { await sleep(2000 * (a + 1)); continue; }
      if (!r.ok) return null;
      const res = (await r.json()).chart?.result?.[0];
      if (!res) return null;
      const t = res.timestamp || [], q = res.indicators?.quote?.[0] || {};
      const rows = [];
      t.forEach((ts, k) => {
        if ([q.open?.[k], q.high?.[k], q.low?.[k], q.close?.[k]].every(v => v != null))
          rows.push([ts * 1000, +q.open[k].toFixed(4), +q.high[k].toFixed(4), +q.low[k].toFixed(4), +q.close[k].toFixed(4), q.volume?.[k] || 0]);
      });
      return { meta: res.meta, rows };
    } catch { await sleep(1000); }
  }
  return null;
}

const dayKey = t => new Date(t).toISOString().slice(0, 10);
// n işlem günü önceki kapanışa göre yüzde değişim
function chgBack(rows, n) {
  if (rows.length <= n) return null;
  const a = rows[rows.length - 1 - n][4], b = rows[rows.length - 1][4];
  return a ? (b / a - 1) * 100 : null;
}

function quoteFrom(id, name, group, unit, meta, daily) {
  const p = meta?.regularMarketPrice ?? daily.at(-1)?.[4];
  if (p == null) return null;
  const prev = meta?.chartPreviousClose ?? meta?.previousClose ?? (daily.length > 1 ? daily.at(-2)[4] : null);
  return {
    sym: id, name, group, unit, cur: meta?.currency || '',
    price: p, prev, chg: prev ? (p / prev - 1) * 100 : 0,
    hi: meta?.regularMarketDayHigh ?? null, lo: meta?.regularMarketDayLow ?? null,
    h52: meta?.fiftyTwoWeekHigh ?? null, l52: meta?.fiftyTwoWeekLow ?? null,
    ch1w: chgBack(daily, 5), ch1m: chgBack(daily, 21), ch3m: chgBack(daily, 63), ch1y: chgBack(daily, 252),
  };
}

const out = [], store = {};
let idx = 0;
fs.mkdirSync('data/h/emtia', { recursive: true });
fs.mkdirSync('data/i/emtia', { recursive: true });

await Promise.all(Array.from({ length: 4 }, async () => {
  while (idx < ITEMS.length) {
    const [id, name, group, ys, unit] = ITEMS[idx++];
    const d = await yahoo(ys, '5y', '1d');
    if (!d || !d.rows.length) { console.error(`${id}: günlük veri alınamadı`); continue; }
    const q = quoteFrom(id, name, group, unit, d.meta, d.rows);
    if (q) { out.push(q); store[id] = { q, daily: d.rows }; }
    await sleep(150);
    const i = await yahoo(ys, '1d', '5m');
    if (i?.rows.length) fs.writeFileSync(`data/i/emtia/${id}.json`, JSON.stringify(i.rows));
    fs.writeFileSync(`data/h/emtia/${id}.json`, JSON.stringify(d.rows));
    await sleep(150);
  }
}));

// Türetilmiş seri: Gram altın (TL) = ons altın / 31,1035 x USD/TRY
if (store.GOLD && store.USDTRY) {
  const fx = new Map(store.USDTRY.daily.map(r => [dayKey(r[0]), r[4]]));
  const rows = [];
  for (const r of store.GOLD.daily) {
    const k = fx.get(dayKey(r[0]));
    if (k) rows.push([r[0], ...[r[1], r[2], r[3], r[4]].map(v => +(v / OZ * k).toFixed(4)), r[5]]);
  }
  const g = store.GOLD.q, u = store.USDTRY.q;
  if (rows.length) {
    out.push({
      sym: 'GRAMALTIN', name: 'Gram Altın', group: 'Metal', unit: '₺/gram', cur: 'TRY',
      price: g.price / OZ * u.price, prev: g.prev && u.prev ? g.prev / OZ * u.prev : null,
      chg: g.prev && u.prev ? (g.price / OZ * u.price / (g.prev / OZ * u.prev) - 1) * 100 : 0,
      hi: null, lo: null, h52: null, l52: null,
      ch1w: chgBack(rows, 5), ch1m: chgBack(rows, 21), ch3m: chgBack(rows, 63), ch1y: chgBack(rows, 252),
    });
    fs.writeFileSync('data/h/emtia/GRAMALTIN.json', JSON.stringify(rows));
  }
}

console.log(`emtia: ${out.length}/${ITEMS.length + 1} seri alındı`);
if (out.length < ITEMS.length * 0.5) { console.error('Çok az veri geldi, eski dosya korunuyor.'); process.exit(1); }
const order = ITEMS.map(x => x[0]).concat('GRAMALTIN');
out.sort((a, b) => order.indexOf(a.sym) - order.indexOf(b.sym));
fs.writeFileSync('data/emtia.json', JSON.stringify({ updated: new Date().toISOString(), count: out.length, items: out }));

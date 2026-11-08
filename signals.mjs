// Teknik sinyal taraması + geriye dönük test + canlı takip  ->  data/signals.json, data/signals-log.json
// Kural tabanlıdır (yapay zeka / makine öğrenmesi YOK). Veri: data/h/{bist,nasdaq}/*.json  ([t,o,h,l,c,v], günlük)
// Bu çıktı yatırım tavsiyesi değildir; geçmiş performans geleceği garanti etmez.
import fs from 'node:fs';

const CFG = {
  minBars: 260,
  ret21: [-0.08, 0.15],      // son 1 ay: ne patlamış ne çökmüş
  ret63: [-0.10, 0.30],      // son 3 ay
  dev63: 0.15,               // fiyatın 63 günlük ortalamadan sapması (aşırı uzamış olmasın)
  rsi: [50, 72],
  volMult: 1.3,              // kırılım günü hacim >= 1.3 x 20 gün ortalaması
  maxRisk: 0.08, minRisk: 0.01, rr: 2,
  hold: 20, cool: 10,
  minTurn: { bist: 5e6, nasdaq: 2e6 },  // 20 gün ortalama günlük işlem tutarı (yerel para)
};

const sma = (a, n) => { const o = Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const emaRaw = (a, n) => { const k = 2 / (n + 1); let e = null; return a.map(v => e = e == null ? v : v * k + e * (1 - k)); };
function rsi(c, n = 14) { const o = Array(c.length).fill(null); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; if (i <= n) { g += Math.max(d, 0); l += Math.max(-d, 0); if (i === n) { g /= n; l /= n; o[i] = 100 - 100 / (1 + (l ? g / l : 1e9)); } } else { g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = 100 - 100 / (1 + (l ? g / l : 1e9)); } } return o; }
const winMax = (a, i, n) => { let m = -Infinity; for (let j = i - n; j < i; j++) m = Math.max(m, a[j]); return m; };
const winMin = (a, i, n) => { let m = Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.min(m, a[j]); return m; };

function prep(rows) {
  const t = rows.map(r => r[0]), h = rows.map(r => r[2]), l = rows.map(r => r[3]), c = rows.map(r => r[4]), v = rows.map(r => r[5]);
  const e12 = emaRaw(c, 12), e26 = emaRaw(c, 26), macd = c.map((_, i) => e12[i] - e26[i]), sig = emaRaw(macd, 9);
  const K = 3, ph = Array(c.length).fill(false), pl = Array(c.length).fill(false);
  for (let j = K; j < c.length - K; j++) { let H = true, L = true; for (let q = 1; q <= K; q++) { if (h[j] < h[j - q] || h[j] <= h[j + q]) H = false; if (l[j] > l[j - q] || l[j] >= l[j + q]) L = false; } ph[j] = H; pl[j] = L; }
  return { ph, pl, t, h, l, c, v, s20: sma(c, 20), s50: sma(c, 50), m63: sma(c, 63), v20: sma(v, 20), turn: sma(c.map((x, i) => x * v[i]), 20), rsi: rsi(c), hist: macd.map((x, i) => x - sig[i]) };
}

function evaluate(P, i) {
  const { c, h, l, v } = P;
  if (i < 210 || P.s50[i - 10] == null || P.v20[i] == null || P.rsi[i] == null) return null;
  const r21 = c[i] / c[i - 21] - 1, r63 = c[i] / c[i - 63] - 1, dev = c[i] / P.m63[i] - 1;
  if (r21 < CFG.ret21[0] || r21 > CFG.ret21[1] || r63 < CFG.ret63[0] || r63 > CFG.ret63[1] || Math.abs(dev) > CFG.dev63) return null;
  if (!(c[i] > P.s50[i] && P.s20[i] >= P.s50[i] && P.s50[i] > P.s50[i - 10])) return null;               // trend
  if (!(c[i] > winMax(h, i, 20))) return null;                                                             // 20 günlük direnç kırılımı
  if (!(v[i] >= CFG.volMult * P.v20[i])) return null;                                                      // hacim teyidi
  if (!(P.rsi[i] >= CFG.rsi[0] && P.rsi[i] <= CFG.rsi[1] && P.hist[i] > 0)) return null;                   // momentum
  const stop = winMin(l, i, 10), risk = (c[i] - stop) / c[i];                                               // destek = son 10 günün dibi
  if (!(risk >= CFG.minRisk && risk <= CFG.maxRisk)) return null;
  return { stop, risk, target: c[i] * (1 + CFG.rr * risk), rsi: P.rsi[i], volx: v[i] / P.v20[i], r21, r63 };
}

function outcome(P, i, s) {      // i. günün kapanışından giriş varsayımı; aynı gün stop ve hedef ise temkinli olarak stop
  const end = Math.min(i + CFG.hold, P.c.length - 1);
  for (let j = i + 1; j <= end; j++) {
    if (P.l[j] <= s.stop) return { res: 'stop', r: -s.risk, done: true };
    if (P.h[j] >= s.target) return { res: 'hedef', r: CFG.rr * s.risk, done: true };
  }
  if (end - i >= CFG.hold) return { res: 'süre', r: P.c[end] / P.c[i] - 1, done: true };
  return { res: 'açık', r: P.c[end] / P.c[i] - 1, done: false };
}


/* ---- Formasyon: düşüş trendinden sonra yatay bant (taban / konsolidasyon) ----
   1) Önceki ~160 günde alçalan tepeler ve alçalan dipler, en az %15 düşüş
   2) Son 40 günde dar, yatay bir bant (en az 2 tepe + 2 dip), net eğim yok
   3) Bant dibi, düşüşün dibinin %3'ünden fazla altına inmemiş (satış baskısı durmuş)
   4) Bant, önceki düşüşün boyutunun yarısından küçük
   Yön vaadi YOKTUR: bant iki yöne de kırılabilir. Geçmişte hangi yöne kırıldığı ölçülür. */
const PAT = { W: 40, K: 3, lookback: 160, minDecline: 0.15, maxRange: 0.18, minRange: 0.04, maxSlope: 0.06, hold: 40, upBrk: 1.02, dnBrk: 0.98 };
function evalPattern(P, i) {
  const { c, h, l } = P, a = i - PAT.W + 1;
  if (i < 200) return null;
  let hi = -Infinity, lo = Infinity;
  for (let j = a; j <= i; j++) { hi = Math.max(hi, h[j]); lo = Math.min(lo, l[j]); }
  const rng = (hi - lo) / ((hi + lo) / 2);
  if (rng > PAT.maxRange || rng < PAT.minRange || Math.abs(c[i] / c[a] - 1) > PAT.maxSlope) return null;
  if (c[i] < lo * 0.99 || c[i] > hi * 1.03) return null;
  let nh = 0, nl = 0; for (let j = a; j <= i - PAT.K; j++) { if (P.ph[j]) nh++; if (P.pl[j]) nl++; }
  if (nh < 2 || nl < 2) return null;
  const H = [], L = [];
  for (let j = Math.max(0, i - PAT.lookback); j < a; j++) { if (P.ph[j]) H.push(h[j]); if (P.pl[j]) L.push(l[j]); }
  if (H.length < 2 || L.length < 2) return null;
  const desc = x => { let d = 0; for (let q = 1; q < x.length; q++) if (x[q] < x[q - 1]) d++; return d / (x.length - 1); };
  if (desc(H) < 0.6 || desc(L) < 0.6 || H[H.length - 1] >= H[0] || L[L.length - 1] >= L[0]) return null;
  const top = Math.max(...H), bottom = Math.min(...L), decline = (top - bottom) / top;
  if (decline < PAT.minDecline || lo < bottom * 0.97 || (hi - lo) > 0.5 * (top - bottom)) return null;
  return { lo, hi, decline: decline * 100, range: rng * 100 };
}
function patOutcome(P, i, s) {
  const end = Math.min(i + PAT.hold, P.c.length - 1);
  for (let j = i + 1; j <= end; j++) {
    if (P.c[j] > s.hi * PAT.upBrk) return { res: 'yukarı', r: P.c[j] / P.c[i] - 1, done: true };
    if (P.c[j] < s.lo * PAT.dnBrk) return { res: 'aşağı', r: P.c[j] / P.c[i] - 1, done: true };
  }
  return end - i >= PAT.hold ? { res: 'bant içinde', r: P.c[end] / P.c[i] - 1, done: true } : { res: 'açık', r: P.c[end] / P.c[i] - 1, done: false };
}
const pst = { n: 0, up: 0, dn: 0, none: 0, sumR: 0, pos: 0, base: 0, basePos: 0 }, patterns = [];
const stats = { n: 0, win: 0, sumR: 0, hedef: 0, stop: 0, base: 0, baseWin: 0, stocks: 0, years: 0 };
const signals = [], now = Date.now();
const cache = {};
for (const mk of ['bist', 'nasdaq']) {
  const dir = `data/h/${mk}`; if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const sym = f.replace('.json', ''); let rows;
    try { rows = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
    if (rows.length < CFG.minBars) continue;
    const P = prep(rows), n = rows.length, last = n - 1;
    cache[`${mk}:${sym}`] = P;
    if (!(P.turn[last] >= CFG.minTurn[mk])) continue;
    stats.stocks++; stats.years += (n - 210) / 252;
    let cool = 0;
    for (let i = 210; i < n - CFG.hold; i++) {              // geriye dönük test (yalnızca sonucu belli olmuş günler)
      if (i % 5 === 0) { stats.base++; if (P.c[i + CFG.hold] > P.c[i]) stats.baseWin++; }
      if (cool > 0) { cool--; continue; }
      const s = evaluate(P, i); if (!s) continue;
      const o = outcome(P, i, s); cool = CFG.cool;
      stats.n++; stats.sumR += o.r; if (o.r > 0) stats.win++; if (o.res === 'hedef') stats.hedef++; if (o.res === 'stop') stats.stop++;
    }
    let pcool = 0;                                           // formasyon geriye dönük testi (her 3 günde bir bakılır)
    for (let i = 200; i < n - PAT.hold; i += 3) {
      if ((i - 200) % 6 === 0) { pst.base++; if (P.c[i + PAT.hold] > P.c[i]) pst.basePos++; }
      if (pcool > 0) { pcool -= 3; continue; }
      const s = evalPattern(P, i); if (!s) continue;
      const o = patOutcome(P, i, s); pcool = 30;
      pst.n++; pst.sumR += o.r; if (o.r > 0) pst.pos++; if (o.res === 'yukarı') pst.up++; else if (o.res === 'aşağı') pst.dn++; else pst.none++;
    }
    if (now - P.t[last] < 6 * 864e5) {
      const s = evalPattern(P, last);
      if (s) patterns.push({ mk, sym, date: new Date(P.t[last]).toISOString().slice(0, 10), price: +P.c[last].toFixed(2), lo: +s.lo.toFixed(2), hi: +s.hi.toFixed(2), decline: +s.decline.toFixed(0), range: +s.range.toFixed(0), status: P.c[last] > s.hi ? 'yukarı kırılım' : 'bant içinde' });
    }
    if (now - P.t[last] < 6 * 864e5) {                      // bugünün sinyali
      const s = evaluate(P, last);
      if (s) signals.push({ mk, sym, date: new Date(P.t[last]).toISOString().slice(0, 10), price: +P.c[last].toFixed(2), stop: +s.stop.toFixed(2), target: +s.target.toFixed(2), risk: +(s.risk * 100).toFixed(1), rsi: +s.rsi.toFixed(0), volx: +s.volx.toFixed(1), r21: +(s.r21 * 100).toFixed(1), r63: +(s.r63 * 100).toFixed(1) });
    }
  }
}
signals.sort((a, b) => b.volx - a.volx);

/* ---- canlı takip günlüğü: sinyal tarihinden sonra gerçekte ne oldu ---- */
const LOG = 'data/signals-log.json';
let log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : [];
for (const s of signals) if (!log.some(x => x.mk === s.mk && x.sym === s.sym && x.date === s.date)) log.push({ ...s, status: 'açık', r: 0 });
for (const e of log) {
  if (e.status !== 'açık') continue;
  const P = cache[`${e.mk}:${e.sym}`]; if (!P) continue;
  const i = P.t.findIndex(t => new Date(t).toISOString().slice(0, 10) === e.date); if (i < 0) continue;
  const o = outcome(P, i, { stop: e.stop, target: e.target, risk: e.risk / 100 });
  e.status = o.res; e.r = +(o.r * 100).toFixed(2);
}
log = log.filter(e => now - Date.parse(e.date) < 400 * 864e5);
const closed = log.filter(e => e.status !== 'açık');
const live = { total: log.length, closed: closed.length, win: closed.filter(e => e.r > 0).length, avg: closed.length ? +(closed.reduce((a, e) => a + e.r, 0) / closed.length).toFixed(2) : null };

const PLOG = 'data/patterns-log.json';
let plog = fs.existsSync(PLOG) ? JSON.parse(fs.readFileSync(PLOG, 'utf8')) : [];
for (const s of patterns) if (!plog.some(x => x.mk === s.mk && x.sym === s.sym && now - Date.parse(x.date) < 30 * 864e5)) plog.push({ ...s, outcome: 'açık', r: 0 });
for (const e of plog) {
  if (e.outcome !== 'açık') continue;
  const P = cache[`${e.mk}:${e.sym}`]; if (!P) continue;
  const i = P.t.findIndex(t => new Date(t).toISOString().slice(0, 10) === e.date); if (i < 0) continue;
  const o = patOutcome(P, i, e); e.outcome = o.res; e.r = +(o.r * 100).toFixed(2);
}
plog = plog.filter(e => now - Date.parse(e.date) < 400 * 864e5);
const pclosed = plog.filter(e => e.outcome !== 'açık');
const patLive = { total: plog.length, closed: pclosed.length, up: pclosed.filter(e => e.outcome === 'yukarı').length, dn: pclosed.filter(e => e.outcome === 'aşağı').length };
const months = Math.max(stats.years * 12 / Math.max(stats.stocks, 1), 1);
const out = {
  updated: new Date().toISOString(), config: CFG, signals,
  backtest: { signals: stats.n, stocks: stats.stocks, perMonth: +(stats.n / months).toFixed(1), winRate: stats.n ? +(100 * stats.win / stats.n).toFixed(1) : null,
    targetRate: stats.n ? +(100 * stats.hedef / stats.n).toFixed(1) : null, stopRate: stats.n ? +(100 * stats.stop / stats.n).toFixed(1) : null,
    avgReturn: stats.n ? +(100 * stats.sumR / stats.n).toFixed(2) : null, baselineWinRate: stats.base ? +(100 * stats.baseWin / stats.base).toFixed(1) : null },
  live,
  patterns,
  patBacktest: { n: pst.n, upRate: pst.n ? +(100 * pst.up / pst.n).toFixed(1) : null, downRate: pst.n ? +(100 * pst.dn / pst.n).toFixed(1) : null, noneRate: pst.n ? +(100 * pst.none / pst.n).toFixed(1) : null,
    avgReturn40: pst.n ? +(100 * pst.sumR / pst.n).toFixed(2) : null, positive40: pst.n ? +(100 * pst.pos / pst.n).toFixed(1) : null, baselinePositive40: pst.base ? +(100 * pst.basePos / pst.base).toFixed(1) : null },
  patLive,
};
fs.writeFileSync('data/signals.json', JSON.stringify(out));
fs.writeFileSync(LOG, JSON.stringify(log));
fs.writeFileSync(PLOG, JSON.stringify(plog));
console.log(`formasyon: bugün ${patterns.length} | backtest ${JSON.stringify(out.patBacktest)}`);
console.log(`bugünün sinyali: ${signals.length} | backtest: ${JSON.stringify(out.backtest)} | canlı: ${JSON.stringify(live)}`);

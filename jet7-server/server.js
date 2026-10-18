// JET7 — servidor do Modo Real
// Arbitragem de inventário entre stablecoins (sem moeda local: funciona a partir de Angola).
// O saldo fica nas corretoras (USDT e a outra stablecoin em cada uma),
// compra-se numa e vende-se na outra ao mesmo tempo. Sem saques entre corretoras.
// DRY_RUN=true (padrão) calcula tudo com preços reais mas NÃO envia ordens.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.2.0';
const PORT = process.env.PORT || 8080;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const MASTER_KEY = process.env.MASTER_KEY || '';
const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT ?? 0.15);   // lucro líquido mínimo (%)
const MAX_ORDER_QUOTE = Number(process.env.MAX_ORDER_QUOTE ?? 200);  // valor máximo por operação (na moeda de cotação)
const DEFAULT_AMOUNT = Number(process.env.DEFAULT_AMOUNT ?? 50);     // quantidade base sugerida por oportunidade
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);
const SYMBOLS = (process.env.SYMBOLS || 'USDC/USDT,FDUSD/USDT,USDE/USDT,TUSD/USDT,PYUSD/USDT,USD1/USDT,EURC/USDT,EURI/USDT,EURC/USDC').split(',').map(s => s.trim()).filter(Boolean);
const EXCHANGES = (process.env.EXCHANGES || 'binance,bybit,okx,kucoin,bitget,mexc,gate').split(',').map(s => s.trim()).filter(Boolean);
const COINS = [...new Set(SYMBOLS.flatMap(s => s.split('/')))];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.enc.json');
const HIST_FILE = path.join(DATA_DIR, 'history.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!ACCESS_TOKEN || ACCESS_TOKEN.length < 24) { console.error('Defina ACCESS_TOKEN (mín. 24 caracteres) no .env'); process.exit(1); }
if (!/^[0-9a-f]{64}$/i.test(MASTER_KEY)) { console.error('Defina MASTER_KEY com 64 caracteres hex (npm run gerar-chaves)'); process.exit(1); }

// ---------- encriptação das chaves API (AES-256-GCM) ----------
const KEY = Buffer.from(MASTER_KEY, 'hex');
function enc(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') };
}
function dec(e) {
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(e.iv, 'hex'));
  d.setAuthTag(Buffer.from(e.tag, 'hex'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, 'hex')), d.final()]).toString('utf8'));
}
const readJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 });

// ---------- corretoras ----------
const clients = {};       // id -> instância ccxt (pública ou autenticada)
let STOPPED = false;      // botão de emergência

function spotOpts(id) {
  // só mercado spot (evita carregar futuros e endpoints bloqueados por região)
  const o = { defaultType: 'spot' };
  if (id === 'binance') o.fetchMarkets = ['spot'];
  if (id === 'bybit') o.fetchMarkets = ['spot'];
  if (id === 'bitget') o.fetchMarkets = ['spot'];
  return o;
}
function buildClient(id) {
  const store = readJSON(KEYS_FILE, {});
  const creds = store[id] ? dec(store[id]) : envCreds(id);
  const ex = new ccxt[id]({ enableRateLimit: true, timeout: 15000, options: spotOpts(id), ...creds });
  clients[id] = ex;
  return ex;
}
const client = id => clients[id] || buildClient(id);
// chaves também podem vir de variáveis de ambiente (persistem no Render Free): KUCOIN_API_KEY, KUCOIN_SECRET, KUCOIN_PASSWORD
function envCreds(id) {
  const P = id.toUpperCase();
  let k = process.env[P + '_API_KEY'], s = process.env[P + '_SECRET'], pw = process.env[P + '_PASSWORD'];
  const all = process.env[P + '_CREDS']; // formato: APIKEY:SECRET[:PASSPHRASE]
  if (all && !k) { const parts = all.trim().split(':'); k = parts[0]; s = parts[1]; if (parts.length > 2) pw = parts.slice(2).join(':'); }
  if (!k || !s) return {};
  const c = { apiKey: k.trim(), secret: s.trim() }; if (pw) c.password = pw.trim(); return c;
}
const hasKeys = id => !!readJSON(KEYS_FILE, {})[id] || !!envCreds(id).apiKey;

async function ensureMarkets(ex) { if (!ex.markets) await ex.loadMarkets(); return ex.markets; }

const marketFail = {}; // corretora indisponível (ex.: bloqueio regional) -> tenta de novo após 60s
async function supports(id, symbol) {
  if (marketFail[id] && Date.now() - marketFail[id] < 60000) return false;
  try { const m = await ensureMarkets(client(id)); delete marketFail[id]; return !!m[symbol]; }
  catch (e) { marketFail[id] = Date.now(); console.warn(`[${id}] mercados indisponíveis: ${e.message.slice(0, 120)}`); return false; }
}

function takerFee(ex, symbol) {
  const m = ex.markets && ex.markets[symbol];
  return m && typeof m.taker === 'number' ? m.taker : 0.001;
}

// preço médio para encher `amount` no livro (inclui slippage real) e o pior preço tocado
function walk(levels, amount) {
  let left = amount, cost = 0, worst = null;
  for (const [p, q] of levels) {
    const take = Math.min(left, q);
    cost += take * p; left -= take; worst = p;
    if (left <= 1e-12) break;
  }
  if (left > 1e-12) return null; // livro sem profundidade suficiente
  return { avg: cost / amount, worst };
}

async function quote(buyId, sellId, symbol, amount) {
  const bx = client(buyId), sx = client(sellId);
  await Promise.all([ensureMarkets(bx), ensureMarkets(sx)]);
  const [bb, sb] = await Promise.all([bx.fetchOrderBook(symbol, 20), sx.fetchOrderBook(symbol, 20)]);
  const buy = walk(bb.asks, amount), sell = walk(sb.bids, amount);
  if (!buy || !sell) return null;
  const fb = takerFee(bx, symbol), fs_ = takerFee(sx, symbol);
  const cost = amount * buy.avg * (1 + fb);
  const revenue = amount * sell.avg * (1 - fs_);
  const net = revenue - cost;
  return {
    symbol, buyExchange: buyId, sellExchange: sellId, amount,
    buyPrice: buy.avg, sellPrice: sell.avg, buyLimit: buy.worst, sellLimit: sell.worst,
    grossPct: (sell.avg / buy.avg - 1) * 100,
    netPct: (net / cost) * 100, netProfit: net, quote: symbol.split('/')[1],
    fees: { buy: fb, sell: fs_ }
  };
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(cors({ origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS }));
app.use('/api', (req, res, next) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(t), b = Buffer.from(ACCESS_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'Token inválido' });
  next();
});
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ ok: false, error: e.message }));

app.get('/api/health', wrap(async (req, res) => {
  res.json({ ok: true, version: VERSION, dryRun: DRY_RUN, stopped: STOPPED, symbols: SYMBOLS,
    minProfitPct: MIN_PROFIT_PCT, maxOrderQuote: MAX_ORDER_QUOTE,
    exchanges: EXCHANGES.map(id => ({ id, keys: hasKeys(id) })) });
}));

app.post('/api/keys', wrap(async (req, res) => {
  const { exchange, apiKey, secret, password } = req.body || {};
  if (!EXCHANGES.includes(exchange)) return res.status(400).json({ ok: false, error: 'Corretora não suportada' });
  if (!apiKey || !secret) return res.status(400).json({ ok: false, error: 'API Key e Secret são obrigatórios' });
  const creds = { apiKey: String(apiKey).trim(), secret: String(secret).trim() };
  if (password) creds.password = String(password).trim();
  // valida a chave antes de guardar
  const test = new ccxt[exchange]({ enableRateLimit: true, timeout: 15000, options: spotOpts(exchange), ...creds });
  try { await test.fetchBalance(); } catch (e) { return res.status(400).json({ ok: false, error: 'Chave recusada pela corretora: ' + e.message }); }
  const store = readJSON(KEYS_FILE, {}); store[exchange] = enc(creds); writeJSON(KEYS_FILE, store);
  delete clients[exchange];
  res.json({ ok: true });
}));

app.delete('/api/keys/:exchange', wrap(async (req, res) => {
  const store = readJSON(KEYS_FILE, {}); delete store[req.params.exchange]; writeJSON(KEYS_FILE, store);
  delete clients[req.params.exchange]; res.json({ ok: true });
}));

app.get('/api/balances', wrap(async (req, res) => {
  const out = await Promise.all(EXCHANGES.filter(hasKeys).map(async id => {
    try {
      const b = await client(id).fetchBalance();
      const out = { exchange: id };
      for (const c of COINS) out[c] = b.total[c] ?? 0;
      return out;
    } catch (e) { return { exchange: id, error: e.message }; }
  }));
  res.json({ ok: true, balances: out });
}));

let oppCache = { key: '', at: 0, data: null, pending: null };
app.get('/api/opportunities', wrap(async (req, res) => {
  const amount = Number(req.query.amount) || DEFAULT_AMOUNT;
  const key = amount + '|' + (req.query.all || '');
  if (oppCache.key === key && oppCache.data && Date.now() - oppCache.at < 5000) return res.json(oppCache.data);
  if (oppCache.key === key && oppCache.pending) return res.json(await oppCache.pending);
  oppCache.key = key;
  oppCache.pending = scanOpps(amount, req.query.all === '1');
  try { oppCache.data = await oppCache.pending; oppCache.at = Date.now(); } finally { oppCache.pending = null; }
  res.json(oppCache.data);
}));
async function scanOpps(amount, all) {
  const list = [];
  for (const symbol of SYMBOLS) {
    const ids = [];
    for (const id of EXCHANGES) if (await supports(id, symbol)) ids.push(id);
    const pairs = [];
    for (const a of ids) for (const b of ids) if (a !== b) pairs.push([a, b]);
    const qs = await Promise.all(pairs.map(([a, b]) => quote(a, b, symbol, amount).catch(() => null)));
    for (const q of qs) if (q && (all || q.netPct > 0)) list.push({ id: `${symbol}:${q.buyExchange}>${q.sellExchange}`, ...q });
  }
  list.sort((x, y) => y.netPct - x.netPct);
  return { ok: true, minProfitPct: MIN_PROFIT_PCT, opportunities: list.slice(0, 20) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function record(t) { const h = readJSON(HIST_FILE, []); h.unshift({ at: new Date().toISOString(), ...t }); writeJSON(HIST_FILE, h.slice(0, 1000)); }

app.post('/api/execute', wrap(async (req, res) => {
  if (STOPPED) return res.status(423).json({ ok: false, status: 'aborted', message: 'Bot parado pelo botão de emergência' });
  const { buyExchange, sellExchange, symbol } = req.body || {};
  const amount = Number(req.body?.amount);
  if (!EXCHANGES.includes(buyExchange) || !EXCHANGES.includes(sellExchange) || buyExchange === sellExchange)
    return res.status(400).json({ ok: false, error: 'Corretoras inválidas' });
  if (!SYMBOLS.includes(symbol)) return res.status(400).json({ ok: false, error: 'Par não permitido' });
  if (!(amount > 0)) return res.status(400).json({ ok: false, error: 'Quantidade inválida' });
  if (!DRY_RUN && (!hasKeys(buyExchange) || !hasKeys(sellExchange)))
    return res.status(400).json({ ok: false, error: 'Faltam chaves API nas duas corretoras' });

  const [base, quoteCur] = symbol.split('/');
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (STOPPED) break;
    // RECALCULAR ROTA com livros de ofertas atuais
    const q = await quote(buyExchange, sellExchange, symbol, amount);
    last = q;
    if (!q) { await sleep(1500); continue; }
    if (q.amount * q.buyPrice > MAX_ORDER_QUOTE)
      return res.status(400).json({ ok: false, status: 'aborted', message: `Acima do limite por operação (${MAX_ORDER_QUOTE} ${quoteCur})` });

    // PROTEÇÃO ANTI-PERDA: só avança com lucro líquido acima do mínimo
    if (q.netPct < MIN_PROFIT_PCT) { await sleep(1500 * attempt); continue; }

    if (DRY_RUN) {
      const t = { status: 'dry_run', symbol, buyExchange, sellExchange, amount, netProfit: q.netProfit, netPct: q.netPct, attempts: attempt };
      record(t);
      return res.json({ ok: true, ...t, message: `Simulação: lucro líquido ${q.netProfit.toFixed(4)} ${quoteCur} (${q.netPct.toFixed(3)}%) — nenhuma ordem enviada (DRY_RUN)`, orders: [] });
    }

    // saldo suficiente nos dois lados (o dinheiro já está em cada corretora)
    const bx = client(buyExchange), sx = client(sellExchange);
    const [bBal, sBal] = await Promise.all([bx.fetchBalance(), sx.fetchBalance()]);
    if ((bBal.free[quoteCur] ?? 0) < amount * q.buyLimit * 1.002 || (sBal.free[base] ?? 0) < amount)
      return res.json({ ok: true, status: 'aborted', attempts: attempt, netProfit: 0, message: `Saldo insuficiente: precisa de ${quoteCur} na ${buyExchange} e ${base} na ${sellExchange}`, orders: [] });

    // ordens LIMIT IOC no pior preço calculado: nunca executam a preço pior que o recalculado
    const amt = Number(bx.amountToPrecision(symbol, amount));
    const [o1, o2] = await Promise.allSettled([
      bx.createOrder(symbol, 'limit', 'buy', amt, Number(bx.priceToPrecision(symbol, q.buyLimit)), { timeInForce: 'IOC' }),
      sx.createOrder(symbol, 'limit', 'sell', amt, Number(sx.priceToPrecision(symbol, q.sellLimit)), { timeInForce: 'IOC' })
    ]);
    const orders = [o1, o2].map((r, i) => r.status === 'fulfilled'
      ? { side: i ? 'sell' : 'buy', id: r.value.id, filled: r.value.filled, price: r.value.average ?? r.value.price, status: r.value.status }
      : { side: i ? 'sell' : 'buy', error: r.reason?.message });
    const fb = orders[0].filled || 0, fsl = orders[1].filled || 0;
    const ok = orders.every(o => !o.error) && fb > 0 && Math.abs(fb - fsl) <= amt * 0.01;
    if (!ok && (fb > 0 || fsl > 0)) STOPPED = true; // perna desequilibrada: pára tudo até o utilizador verificar
    const t = { status: ok ? 'executed' : (fb > 0 || fsl > 0) ? 'partial' : 'aborted', symbol, buyExchange, sellExchange, amount: amt, netProfit: ok ? q.netProfit : 0, netPct: q.netPct, attempts: attempt, orders };
    record(t);
    return res.json({ ok: true, ...t, message: ok
      ? `Executado: lucro estimado ${q.netProfit.toFixed(4)} ${quoteCur}`
      : (fb > 0 || fsl > 0)
        ? `Desequilíbrio: comprou ${fb} e vendeu ${fsl} ${base}. Bot parado — reequilibre os saldos e volte a ligar o servidor.`
        : 'Nenhuma ordem executou (preço mudou antes) — sem perda' });
  }
  const t = { status: 'held', symbol, buyExchange, sellExchange, amount, netProfit: 0, attempts: MAX_ATTEMPTS, lastNetPct: last?.netPct ?? null };
  record(t);
  res.json({ ok: true, ...t, message: `Sem lucro após ${MAX_ATTEMPTS} recálculos — nenhuma ordem enviada, saldo mantido`, orders: [] });
}));

app.post('/api/stop', wrap(async (req, res) => { STOPPED = true; res.json({ ok: true, stopped: true }); }));
app.post('/api/resume', wrap(async (req, res) => { STOPPED = false; res.json({ ok: true, stopped: false }); }));
app.get('/api/history', wrap(async (req, res) => res.json({ ok: true, trades: readJSON(HIST_FILE, []).slice(0, 200) })));

app.get('/', (req, res) => res.type('text').send('JET7 server ' + VERSION));
app.listen(PORT, () => console.log(`JET7 server ${VERSION} na porta ${PORT} — DRY_RUN=${DRY_RUN}`));

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

const VERSION = '1.8.0';
const PORT = process.env.PORT || 8080;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const MASTER_KEY = process.env.MASTER_KEY || '';
const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const MIN_PROFIT_PCT = Number(process.env.MIN_PROFIT_PCT ?? 0.15);   // lucro líquido mínimo (%)
const MAX_ORDER_QUOTE = Number(process.env.MAX_ORDER_QUOTE ?? 200);  // valor máximo por operação (na moeda de cotação)
const DEFAULT_AMOUNT = Number(process.env.DEFAULT_AMOUNT ?? 50);     // quantidade base sugerida por oportunidade
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);
const SYMBOLS = (process.env.SYMBOLS || 'USDC/USDT,FDUSD/USDT,USDE/USDT,TUSD/USDT,PYUSD/USDT,USD1/USDT,DAI/USDT,USDD/USDT,RLUSD/USDT,USDP/USDT,USDS/USDT,FDUSD/USDC,USDE/USDC,USD1/USDC,PYUSD/USDC').split(',').map(s => s.trim()).filter(Boolean);
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
let STOPPED = false;      // botão de emergência (guardado no Gist: sobrevive a reinícios)
function setStopped(v) { STOPPED = !!v; try { autobot.stopped = STOPPED; saveAutobot(); } catch (e) {} }

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

// desconto de taxa por pagar com o token da corretora (BNB, KCS, MX, GT). Só afeta o cálculo/simulação.
// FEE_DISCOUNT=false desliga; FEE_DISCOUNTS=binance:0.75,kucoin:0.8,... substitui os multiplicadores.
const FEE_DISCOUNT = String(process.env.FEE_DISCOUNT ?? 'true').toLowerCase() !== 'false';
const FEE_MULT = Object.assign({ binance: 0.75, kucoin: 0.8, mexc: 0.8, gate: 0.9, bitget: 0.8 },
  Object.fromEntries((process.env.FEE_DISCOUNTS || '').split(',').map(x => x.split(':').map(y => y.trim()))
    .filter(([k, v]) => k && !isNaN(Number(v))).map(([k, v]) => [k, Number(v)])));
// taxas reais da conta (lidas pela API de cada corretora, cache 6h). Sem chave ou se falhar: taxa geral do mercado.
const FEE_TTL = 6 * 3600 * 1000;
const accountFees = {}; // id -> { at, fees: {symbol: taker}, error }
const feeInflight = {};
function refreshFees(id) {
  if (!feeInflight[id]) feeInflight[id] = Promise.all([_refreshFees(id), refreshToken(id)]).finally(() => { delete feeInflight[id]; });
  return feeInflight[id];
}
// o desconto por token só conta se houver saldo desse token na corretora (lido a cada 10 min)
const FEE_TOKEN = { binance: 'BNB', kucoin: 'KCS', mexc: 'MX', gate: 'GT', bitget: 'BGB' };
const tokenBal = {}; // id -> { at, amount, error }
async function refreshToken(id) {
  const t = FEE_TOKEN[id], c = tokenBal[id];
  if (!t || !hasKeys(id) || (c && Date.now() - c.at < 600000)) return;
  try { const b = await client(id).fetchBalance(); tokenBal[id] = { at: Date.now(), amount: Number(b.free?.[t] ?? b.total?.[t] ?? 0) }; }
  catch (e) { tokenBal[id] = { at: Date.now(), amount: c?.amount ?? 0, error: e.message.slice(0, 120) }; }
}
const discountOn = id => FEE_DISCOUNT && !!FEE_MULT[id] && (tokenBal[id]?.amount || 0) > 0;
async function _refreshFees(id) {
  const c = accountFees[id];
  if (c && Date.now() - c.at < (c.error ? 600000 : FEE_TTL)) return;
  if (!hasKeys(id)) return;
  const ex = client(id), fees = {}, makers = {};
  let gtDiscount = false;
  try {
    await ensureMarkets(ex);
    const syms = SYMBOLS.filter(s => ex.markets[s]);
    if (ex.has.fetchTradingFees) {
      const all = await ex.fetchTradingFees();
      for (const s of syms) { if (all[s] && typeof all[s].taker === 'number') fees[s] = all[s].taker; if (all[s] && typeof all[s].maker === 'number') makers[s] = all[s].maker; }
      if (id === 'gate') gtDiscount = Object.values(all).some(f => f?.info?.gt_discount === true);
    }
    if (ex.has.fetchTradingFee) {
      for (const s of syms.filter(s => fees[s] === undefined)) {
        try { const f = await ex.fetchTradingFee(s); if (typeof f.taker === 'number') fees[s] = f.taker; if (typeof f.maker === 'number') makers[s] = f.maker; } catch (e) {}
      }
    }
    if (id === 'gate' && !gtDiscount) {
      for (const s of syms) { try { const f = await ex.fetchTradingFee(s); if (f?.info?.gt_discount === true) { gtDiscount = true; } break; } catch (e) { break; } }
    }
    accountFees[id] = { at: Date.now(), fees, makers, gtDiscount };
  } catch (e) {
    accountFees[id] = { at: Date.now(), fees: accountFees[id]?.fees || {}, makers: accountFees[id]?.makers || {}, error: e.message.slice(0, 160) };
  }
}
function takerFee(ex, symbol) {
  const m = ex.markets && ex.markets[symbol];
  const real = accountFees[ex.id]?.fees?.[symbol];
  const base = typeof real === 'number' ? Math.abs(real) : (m && typeof m.taker === 'number' ? m.taker : 0.001);
  // a Gate já devolve a taxa com desconto GT quando está ligado (gt_taker_fee): não aplicar o desconto duas vezes
  const already = typeof real === 'number' && ex.id === 'gate' && accountFees.gate?.gtDiscount;
  return discountOn(ex.id) && !already ? base * FEE_MULT[ex.id] : base;
}


// taxa maker (ordem limitada que fica no livro). Pode ser 0 ou negativa (rebate) — usa-se o valor real com sinal.
function makerFee(ex, symbol) {
  const m = ex.markets && ex.markets[symbol];
  const real = accountFees[ex.id]?.makers?.[symbol];
  const base = typeof real === 'number' ? real : (m && typeof m.maker === 'number' ? m.maker : takerFee(ex, symbol));
  const already = typeof real === 'number' && ex.id === 'gate' && accountFees.gate?.gtDiscount;
  return discountOn(ex.id) && !already && base > 0 ? base * FEE_MULT[ex.id] : base;
}
// SIMULAÇÃO maker numa ponta: (A) compra com ordem limitada no melhor bid da corretora de compra e vende a mercado,
// ou (B) compra a mercado e vende com ordem limitada no melhor ask da corretora de venda. Escolhe a melhor.
// Atenção: só lucra se alguém executar a ordem limitada; até lá o preço pode mudar.
const MAKER_MAX_SPREAD = Number(process.env.MAKER_MAX_SPREAD ?? 0.3); // livro com spread maior = mercado parado, ordem dificilmente executa
function makerVariant(bb, sb, fb, fs_, mb, ms, amount) {
  const out = [];
  const sell = walk(sb.bids, amount), bid = bb.bids[0]?.[0];
  if (sell && bid) { const cost = amount * bid * (1 + mb), rev = amount * sell.avg * (1 - fs_);
    const sp = ((bb.asks[0]?.[0] || bid) / bid - 1) * 100;
    out.push({ side: 'compra', bookSpreadPct: sp, makerExchangeFee: mb, limitPrice: bid, cost, revenue: rev, net: rev - cost, netPct: (rev - cost) / cost * 100 }); }
  const buy = walk(bb.asks, amount), ask = sb.asks[0]?.[0];
  if (buy && ask) { const cost = amount * buy.avg * (1 + fb), rev = amount * ask * (1 - ms);
    const sp = (ask / (sb.bids[0]?.[0] || ask) - 1) * 100;
    out.push({ side: 'venda', bookSpreadPct: sp, makerExchangeFee: ms, limitPrice: ask, cost, revenue: rev, net: rev - cost, netPct: (rev - cost) / cost * 100 }); }
  for (const o of out) o.realistic = o.bookSpreadPct <= MAKER_MAX_SPREAD;
  out.sort((a, b) => (b.realistic - a.realistic) || (b.net - a.net));
  return out[0] || null;
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

function calcRoute(bb, sb, fb, fs_, amount) {
  const buy = walk(bb.asks, amount), sell = walk(sb.bids, amount);
  if (!buy || !sell) return null;
  const spend = amount * buy.avg, feeBuy = spend * fb;
  const gross = amount * sell.avg, feeSell = gross * fs_;
  const cost = spend + feeBuy, revenue = gross - feeSell, net = revenue - cost;
  return { buy, sell, spend, feeBuy, gross, feeSell, cost, revenue, net, netPct: (net / cost) * 100 };
}

async function quote(buyId, sellId, symbol, amount) {
  const bx = client(buyId), sx = client(sellId);
  await Promise.all([ensureMarkets(bx), ensureMarkets(sx)]);
  await Promise.all([refreshFees(buyId), refreshFees(sellId)]);
  const [bb, sb] = await Promise.all([bx.fetchOrderBook(symbol, 20), sx.fetchOrderBook(symbol, 20)]);
  const fb = takerFee(bx, symbol), fs_ = takerFee(sx, symbol);
  const r = calcRoute(bb, sb, fb, fs_, amount);
  if (!r) return null;
  const mb = makerFee(bx, symbol), ms = makerFee(sx, symbol), mv = makerVariant(bb, sb, fb, fs_, mb, ms, amount);
  // maior quantidade (até MAX_ORDER_QUOTE) que ainda dá lucro líquido >= mínimo, com os livros atuais
  // tamanho (até MAX_ORDER_QUOTE) que dá o MAIOR lucro em USDT com lucro líquido >= mínimo
  const hiAmt = MAX_ORDER_QUOTE / Math.max(bb.asks[0]?.[0] || 1, 1e-9);
  let lo = 0, best = null;
  for (let i = 1; i <= 40; i++) {
    const amt = hiAmt * i / 40, m = calcRoute(bb, sb, fb, fs_, amt);
    if (m && m.netPct >= MIN_PROFIT_PCT && (!best || m.net > best.net)) { best = m; lo = amt; }
  }
  const q = symbol.split('/')[1];
  return {
    symbol, buyExchange: buyId, sellExchange: sellId, amount,
    buyPrice: r.buy.avg, sellPrice: r.sell.avg, buyLimit: r.buy.worst, sellLimit: r.sell.worst,
    grossPct: (r.sell.avg / r.buy.avg - 1) * 100,
    netPct: r.netPct, netProfit: r.net, quote: q,
    fees: { buy: fb, sell: fs_, buyMaker: mb, sellMaker: ms },
    maker: mv ? { side: mv.side, limitPrice: mv.limitPrice, bookSpreadPct: mv.bookSpreadPct, realistic: mv.realistic, invest: mv.cost, revenue: mv.revenue, netProfit: mv.net, netPct: mv.netPct, meetsMin: mv.netPct >= MIN_PROFIT_PCT,
      note: `Ordem limitada na ${mv.side} a ${mv.limitPrice} — só lucra se for executada; a outra ponta a mercado` } : null,
    // previsão em valores, antes de qualquer ordem
    preview: {
      invest: r.cost, revenue: r.revenue, grossProfit: r.gross - r.spend,
      feesTotal: r.feeBuy + r.feeSell, netProfit: r.net, netPct: r.netPct,
      meetsMin: r.netPct >= MIN_PROFIT_PCT, minProfitPct: MIN_PROFIT_PCT,
      maxAmount: best ? lo : 0, maxInvest: best ? best.cost : 0, maxNetProfit: best ? best.net : 0
    }
  };
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(cors({ origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS }));
// ---------- VIGILÂNCIA DEX (só leitura, sem carteira) ----------
// Compara o USDC/USDT das corretoras com a KyberSwap em redes baratas. Avisa quando a diferença líquida de gás
// passa de DEX_ALERT_PCT (0,3% por defeito), que já paga as transferências. Não envia nada para a blockchain.
const DEX_ALERT_PCT = Number(process.env.DEX_ALERT_PCT ?? 0.3), DEX_AMOUNT = Number(process.env.DEX_AMOUNT ?? 200), DEX_EVERY_MIN = Number(process.env.DEX_EVERY_MIN ?? 2);
const DEX_CHAINS = {
  bsc: { USDC: ['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18], USDT: ['0x55d398326f99059fF775485246999027B3197955', 18] },
  polygon: { USDC: ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6], USDT: ['0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6] },
  base: { USDC: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6], USDT: ['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6] },
  arbitrum: { USDC: ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6], USDT: ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6] }
};
const dexWatch = { at: null, amount: DEX_AMOUNT, alertPct: DEX_ALERT_PCT, cex: null, routes: [], best: null, alerts: [], error: null };
async function kyberQuote(chain, from, to, amount) {
  const [ai, di] = DEX_CHAINS[chain][from], [ao] = DEX_CHAINS[chain][to];
  const amt = BigInt(Math.round(amount * 1e6)) * 10n ** BigInt(di - 6);
  const r = await fetch(`https://aggregator-api.kyberswap.com/${chain}/api/v1/routes?tokenIn=${ai}&tokenOut=${ao}&amountIn=${amt}`, { headers: { 'x-client-id': 'jet7' } });
  if (!r.ok) throw new Error('KyberSwap ' + chain + ' ' + r.status);
  const d = (await r.json())?.data?.routeSummary; if (!d) throw new Error('KyberSwap ' + chain + ' sem rota');
  const dout = DEX_CHAINS[chain][to][1];
  return { out: Number(BigInt(d.amountOut) / 10n ** BigInt(Math.max(dout - 6, 0))) / 1e6, gasUsd: Number(d.gasUsd) || 0 };
}
async function cexUsdcRef() {
  let bid = null, ask = null;
  for (const id of EXCHANGES) {
    if (!(await supports(id, 'USDC/USDT').catch(() => false))) continue;
    try { const ob = await client(id).fetchOrderBook('USDC/USDT', 20); const b = ob.bids[0]?.[0], a = ob.asks[0]?.[0];
      if (b && (!bid || b > bid.price)) bid = { exchange: id, price: b, fee: takerFee(client(id), 'USDC/USDT') };
      if (a && (!ask || a < ask.price)) ask = { exchange: id, price: a, fee: takerFee(client(id), 'USDC/USDT') }; } catch (e) {}
  }
  return { bid, ask };
}
async function dexWatchTick() {
  try {
    const cex = await cexUsdcRef(); if (!cex.bid || !cex.ask) throw new Error('Sem preço USDC/USDT nas corretoras');
    const A = DEX_AMOUNT, routes = [];
    await Promise.all(Object.keys(DEX_CHAINS).map(async chain => {
      try {
        // CEX→DEX: compra USDC na corretora, troca USDC→USDT na DEX
        const s1 = await kyberQuote(chain, 'USDC', 'USDT', A);
        const cost1 = A * cex.ask.price * (1 + cex.ask.fee);
        routes.push({ route: `Comprar USDC na ${cex.ask.exchange} → vender na KyberSwap (${chain})`, chain, dir: 'CEX→DEX', grossPct: (s1.out / (A * cex.ask.price) - 1) * 100, netPct: ((s1.out - s1.gasUsd) / cost1 - 1) * 100, netUsdt: s1.out - s1.gasUsd - cost1, gasUsd: s1.gasUsd });
        // DEX→CEX: troca USDT→USDC na DEX, vende USDC na corretora
        const s2 = await kyberQuote(chain, 'USDT', 'USDC', A);
        const rev2 = s2.out * cex.bid.price * (1 - cex.bid.fee);
        routes.push({ route: `Comprar USDC na KyberSwap (${chain}) → vender na ${cex.bid.exchange}`, chain, dir: 'DEX→CEX', grossPct: (s2.out * cex.bid.price / A - 1) * 100, netPct: ((rev2 - s2.gasUsd) / A - 1) * 100, netUsdt: rev2 - s2.gasUsd - A, gasUsd: s2.gasUsd });
      } catch (e) {}
    }));
    routes.sort((a, b) => b.netPct - a.netPct);
    Object.assign(dexWatch, { at: new Date().toISOString(), cex, routes, best: routes[0] || null, error: null });
    for (const r of routes) if (r.netPct >= DEX_ALERT_PCT) { dexWatch.alerts.unshift({ at: dexWatch.at, ...r }); console.log(`ALERTA DEX: ${r.route} ${r.netPct.toFixed(3)}%`); }
    dexWatch.alerts = dexWatch.alerts.slice(0, 50);
  } catch (e) { dexWatch.error = e.message; }
}
setTimeout(dexWatchTick, 15000); setInterval(dexWatchTick, DEX_EVERY_MIN * 60000);
// só dados públicos de mercado (sem saldos nem chaves): pode ser lido sem token, para alertas externos
app.get('/public/dex-watch', (req, res) => res.json({ ok: true, version: VERSION, ...dexWatch, routes: dexWatch.routes.map(r => ({ ...r, grossPct: +r.grossPct.toFixed(4), netPct: +r.netPct.toFixed(4), netUsdt: +r.netUsdt.toFixed(4) })) }));

app.use('/api', (req, res, next) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(t), b = Buffer.from(ACCESS_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'Token inválido' });
  next();
});
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ ok: false, error: e.message }));

app.get('/api/health', wrap(async (req, res) => {
  res.json({ ok: true, version: VERSION, dryRun: DRY_RUN, feeDiscount: FEE_DISCOUNT ? Object.fromEntries(Object.keys(FEE_TOKEN).map(id => [id, { token: FEE_TOKEN[id], balance: tokenBal[id]?.amount ?? null, active: discountOn(id), mult: FEE_MULT[id] }])) : false, stopped: STOPPED, symbols: SYMBOLS,
    minProfitPct: MIN_PROFIT_PCT, maxOrderQuote: MAX_ORDER_QUOTE, autobot: { enabled: autobot.enabled, lastScanAt: autoState.lastScanAt, simulated: autoState.simulated, trades: autoState.trades }, historySync: { enabled: histSync.enabled, gist: !!gistId, lastOk: histSync.lastOk, lastError: histSync.lastError },
    exchanges: EXCHANGES.map(id => ({ id, keys: hasKeys(id) })) });
}));

// desconto GT na Gate (taxa spot 0,10% -> 0,09% em VIP0). Só muda a forma de pagar a taxa; não mexe na estratégia.
app.get('/api/gate/gt-fee', wrap(async (req, res) => {
  if (!hasKeys('gate')) return res.status(400).json({ ok: false, error: 'Gate sem chave' });
  const r = await client('gate').privateAccountGetDebitFee();
  res.json({ ok: true, gate: r });
}));
app.post('/api/gate/gt-fee', wrap(async (req, res) => {
  if (!hasKeys('gate')) return res.status(400).json({ ok: false, error: 'Gate sem chave' });
  const enabled = req.body?.enabled !== false;
  await client('gate').privateAccountPostDebitFee({ enabled });
  const r = await client('gate').privateAccountGetDebitFee();
  res.json({ ok: true, gate: r });
}));

// desconto BGB na Bitget (taxa spot -20% pagando em BGB). Só muda a forma de pagar a taxa.
async function bitgetDeduct(method, body) {
  // conta unificada (UTA) usa v3; conta clássica usa v2
  const c = client('bitget');
  try {
    return method === 'GET' ? await c.privateUtaGetV3AccountDeductInfo() : await c.privateUtaPostV3AccountSwitchDeduct(body || {});
  } catch (e) {
    if (!/40084|not.*unified|classic/i.test(e.message)) throw e;
    return c.request(method === 'GET' ? 'v2/spot/account/deduct-info' : 'v2/spot/account/switch-deduct', ['private', 'spot'], method, body || {});
  }
}
app.get('/api/bitget/bgb-fee', wrap(async (req, res) => {
  if (!hasKeys('bitget')) return res.status(400).json({ ok: false, error: 'Bitget sem chave' });
  res.json({ ok: true, bitget: await bitgetDeduct('GET') });
}));
app.post('/api/bitget/bgb-fee', wrap(async (req, res) => {
  if (!hasKeys('bitget')) return res.status(400).json({ ok: false, error: 'Bitget sem chave' });
  const deduct = req.body?.enabled === false ? 'off' : 'on';
  const r = await bitgetDeduct('POST', { deduct });
  res.json({ ok: true, result: r, bitget: await bitgetDeduct('GET') });
}));

app.get('/api/fees', wrap(async (req, res) => {
  const ids = EXCHANGES.filter(hasKeys);
  await Promise.all(ids.map(refreshFees));
  const out = {};
  for (const id of ids) {
    const ex = client(id); out[id] = { error: accountFees[id]?.error, source: {}, effective: {} };
    for (const s of SYMBOLS) if (ex.markets && ex.markets[s]) {
      out[id].source[s] = typeof accountFees[id]?.fees?.[s] === 'number' ? 'conta' : 'mercado';
      out[id].effective[s] = +(takerFee(ex, s) * 100).toFixed(4);
    }
  }
  res.json({ ok: true, feesPct: out });
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
let makerCache = { at: 0, list: [] };
// comparação taker × maker (simulação): as 20 rotas com maior lucro usando ordem maker numa ponta
app.get('/api/maker-opportunities', wrap(async (req, res) => {
  if (Date.now() - makerCache.at > 15000) await scanOpps(Number(req.query.amount) || DEFAULT_AMOUNT, true);
  res.json({ ok: true, minProfitPct: MIN_PROFIT_PCT, simulation: true, opportunities: makerCache.list.map(q => ({ id: q.id, symbol: q.symbol, buyExchange: q.buyExchange, sellExchange: q.sellExchange, amount: q.amount,
    taker: { netPct: q.netPct, netProfit: q.netProfit }, maker: q.maker, fees: q.fees })) });
}));
async function scanOpps(amount, all) {
  const list = [];
  for (const symbol of SYMBOLS) {
    const ids = [];
    for (const id of EXCHANGES) if (await supports(id, symbol)) ids.push(id);
    const pairs = [];
    for (const a of ids) for (const b of ids) if (a !== b) pairs.push([a, b]);
    const qs = await Promise.all(pairs.map(([a, b]) => quote(a, b, symbol, amount).catch(() => null)));
    for (const q of qs) if (q && (all || q.netPct > 0 || q.maker?.netPct > 0)) list.push({ id: `${symbol}:${q.buyExchange}>${q.sellExchange}`, ...q });
  }
  makerCache = { at: Date.now(), list: list.filter(q => q.maker).sort((x, y) => (y.maker.realistic - x.maker.realistic) || (y.maker.netProfit - x.maker.netProfit)).slice(0, 20) };
  // ordena pelo lucro em USDT: primeiro o maior lucro possível, depois o lucro na quantidade base
  list.sort((x, y) => (y.preview.maxNetProfit - x.preview.maxNetProfit) || (y.netProfit - x.netProfit));
  return { ok: true, minProfitPct: MIN_PROFIT_PCT, opportunities: list.slice(0, 20) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function record(t) { const h = readJSON(HIST_FILE, []); h.unshift({ at: new Date().toISOString(), ...t }); writeJSON(HIST_FILE, h.slice(0, 1000)); scheduleHistSync(); }

// histórico persistente num Gist privado do GitHub (o disco do Render Free apaga-se a cada deploy).
// Ativo só com GITHUB_TOKEN (token com permissão Gists: leitura e escrita). GIST_ID é opcional: o servidor encontra ou cria o gist.
const GH_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GIST_FILE = 'jet7-history.json';
let gistId = (process.env.GIST_ID || '').trim(), histSync = { enabled: !!GH_TOKEN, lastOk: null, lastError: null }, syncTimer = null;
async function gh(pathname, opts = {}) {
  const r = await fetch('https://api.github.com' + pathname, { ...opts, headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'jet7-server', 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error('GitHub ' + r.status + ': ' + (await r.text()).slice(0, 160));
  return r.json();
}
async function findOrCreateGist() {
  if (gistId) return gistId;
  for (let page = 1; page <= 5 && !gistId; page++) {
    const list = await gh('/gists?per_page=100&page=' + page);
    const g = list.find(x => x.files && x.files[GIST_FILE]); if (g) gistId = g.id;
    if (list.length < 100) break;
  }
  if (!gistId) gistId = (await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'JET7 histórico (privado)', public: false, files: { [GIST_FILE]: { content: '[]' } } }) })).id;
  return gistId;
}
async function loadHistFromGist() {
  if (!GH_TOKEN) return;
  try {
    const g = await gh('/gists/' + await findOrCreateGist());
    const f = g.files[GIST_FILE]; let remote = [];
    if (f) remote = JSON.parse(f.truncated ? await (await fetch(f.raw_url)).text() : (f.content || '[]'));
    const local = readJSON(HIST_FILE, []), seen = new Set(), merged = [];
    for (const t of [...local, ...remote]) { const k = t.at + '|' + (t.id || t.symbol || ''); if (!seen.has(k)) { seen.add(k); merged.push(t); } }
    merged.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    writeJSON(HIST_FILE, merged.slice(0, 1000)); histSync.lastOk = new Date().toISOString(); histSync.lastError = null;
    console.log(`Histórico carregado do Gist: ${merged.length} registos`);
  } catch (e) { histSync.lastError = e.message; console.warn('Gist: ' + e.message); }
}
function scheduleHistSync() {
  if (!GH_TOKEN) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      await gh('/gists/' + await findOrCreateGist(), { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(readJSON(HIST_FILE, []), null, 1) } } }) });
      histSync.lastOk = new Date().toISOString(); histSync.lastError = null;
    } catch (e) { histSync.lastError = e.message; console.warn('Gist: ' + e.message); }
  }, 3000);
}
loadHistFromGist();

// PREVISÃO: quanto se ganha nesta rota antes de executar (não envia ordens)
app.get('/api/preview', wrap(async (req, res) => {
  const { buy, sell, symbol } = req.query; const amount = Number(req.query.amount) || DEFAULT_AMOUNT;
  if (!EXCHANGES.includes(buy) || !EXCHANGES.includes(sell) || buy === sell) return res.status(400).json({ ok: false, error: 'Corretoras inválidas' });
  if (!SYMBOLS.includes(symbol)) return res.status(400).json({ ok: false, error: 'Par não permitido' });
  const q = await quote(buy, sell, symbol, amount);
  if (!q) return res.json({ ok: true, available: false, message: 'Livro sem profundidade suficiente para esta quantidade' });
  const p = q.preview, c = q.quote;
  res.json({ ok: true, available: true, ...q, dryRun: DRY_RUN,
    message: `Previsão: investe ${p.invest.toFixed(4)} ${c}, recebe ${p.revenue.toFixed(4)} ${c}, taxas ${p.feesTotal.toFixed(4)} ${c} → lucro líquido ${p.netProfit.toFixed(4)} ${c} (${p.netPct.toFixed(3)}%). ` +
      (p.meetsMin ? 'Passa o mínimo.' : `Abaixo do mínimo de ${MIN_PROFIT_PCT}% — não executaria.`) +
      (p.maxAmount > 0 ? ` Cabe até ${p.maxInvest.toFixed(2)} ${c} com lucro ≈ ${p.maxNetProfit.toFixed(4)} ${c}.` : '') });
}));

app.post('/api/execute', wrap(async (req, res) => {
  const r = await executeRoute({ ...(req.body || {}), source: 'manual' });
  res.status(r.code).json(r.body);
}));

// EXECUÇÃO DA ROTA COMPLETA (usada pelo clique manual e pelo Autobot)
async function executeRoute(input) {
  const send = (code, body) => ({ code, body });
  const source = input.source || 'manual';
  if (STOPPED) return send(423, { ok: false, status: 'aborted', message: 'Bot parado pelo botão de emergência' });
  const { buyExchange, sellExchange, symbol } = input;
  const amount = Number(input.amount);
  if (!EXCHANGES.includes(buyExchange) || !EXCHANGES.includes(sellExchange) || buyExchange === sellExchange)
    return send(400, { ok: false, error: 'Corretoras inválidas' });
  if (!SYMBOLS.includes(symbol)) return send(400, { ok: false, error: 'Par não permitido' });
  if (!(amount > 0)) return send(400, { ok: false, error: 'Quantidade inválida' });
  if (!DRY_RUN && (!hasKeys(buyExchange) || !hasKeys(sellExchange)))
    return send(400, { ok: false, error: 'Faltam chaves API nas duas corretoras' });

  const [base, quoteCur] = symbol.split('/');
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (STOPPED) break;
    // RECALCULAR ROTA com livros de ofertas atuais
    let q = await quote(buyExchange, sellExchange, symbol, amount);
    last = q;
    if (!q) { await sleep(1500); continue; }
    if (q.amount * q.buyPrice > MAX_ORDER_QUOTE)
      return send(400, { ok: false, status: 'aborted', message: `Acima do limite por operação (${MAX_ORDER_QUOTE} ${quoteCur})` });

    // PROTEÇÃO ANTI-PERDA: só avança com lucro líquido acima do mínimo
    if (q.netPct < MIN_PROFIT_PCT) { await sleep(1500 * attempt); continue; }

    if (DRY_RUN) {
      const t = { status: 'dry_run', symbol, buyExchange, sellExchange, amount, netProfit: q.netProfit, netPct: q.netPct, attempts: attempt, preview: q.preview };
      record({ source, ...t });
      return send(200, { ok: true, ...t, message: `Simulação: lucro líquido ${q.netProfit.toFixed(4)} ${quoteCur} (${q.netPct.toFixed(3)}%) — nenhuma ordem enviada (DRY_RUN)`, orders: [] });
    }

    // saldo suficiente nos dois lados (o dinheiro já está em cada corretora)
    const bx = client(buyExchange), sx = client(sellExchange);
    const [bBal, sBal] = await Promise.all([bx.fetchBalance(), sx.fetchBalance()]);
    if ((bBal.free[quoteCur] ?? 0) < amount * q.buyLimit * 1.002 || (sBal.free[base] ?? 0) < amount)
      return send(200, { ok: true, status: 'aborted', attempts: attempt, netProfit: 0, message: `Saldo insuficiente: precisa de ${quoteCur} na ${buyExchange} e ${base} na ${sellExchange}`, orders: [] });

    // REVERIFICAÇÃO FINAL: livros lidos de novo imediatamente antes de enviar as ordens
    const f = await quote(buyExchange, sellExchange, symbol, amount);
    if (!f || f.netPct < MIN_PROFIT_PCT) { last = f || last; await sleep(1500 * attempt); continue; }
    Object.assign(q, f);

    // ordens LIMIT IOC no pior preço calculado: nunca executam a preço pior que o recalculado
    const amt = Number(bx.amountToPrecision(symbol, amount));
    const [o1, o2] = await Promise.allSettled([
      bx.createOrder(symbol, 'limit', 'buy', amt, Number(bx.priceToPrecision(symbol, q.buyLimit)), { timeInForce: 'IOC' }),
      sx.createOrder(symbol, 'limit', 'sell', amt, Number(sx.priceToPrecision(symbol, q.sellLimit)), { timeInForce: 'IOC' })
    ]);
    const orders = [o1, o2].map((r, i) => r.status === 'fulfilled'
      ? { side: i ? 'sell' : 'buy', id: r.value.id, filled: r.value.filled, price: r.value.average ?? r.value.price, status: r.value.status }
      : { side: i ? 'sell' : 'buy', error: r.reason?.message });
    let fb = orders[0].filled || 0, fsl = orders[1].filled || 0;
    // PERNA INCOMPLETA: tenta completar o lado que ficou atrás (até 3x, sempre com lucro líquido >= 0 na rota completa)
    if ((fb > 0 || fsl > 0) && Math.abs(fb - fsl) > amt * 0.01) {
      const fix = await completeLeg({ bx, sx, symbol, fb, fsl, q });
      orders.push(...fix.orders); fb = fix.fb; fsl = fix.fsl;
    }
    const ok = fb > 0 && Math.abs(fb - fsl) <= amt * 0.01;
    if (!ok && (fb > 0 || fsl > 0)) setStopped(true); // continua desequilibrada: pára tudo até o utilizador verificar
    const t = { status: ok ? 'executed' : (fb > 0 || fsl > 0) ? 'partial' : 'aborted', symbol, buyExchange, sellExchange, amount: amt, netProfit: ok ? q.netProfit : 0, netPct: q.netPct, attempts: attempt, preview: q.preview, orders };
    record({ source, ...t });
    return send(200, { ok: true, ...t, message: ok
      ? `Executado: lucro estimado ${q.netProfit.toFixed(4)} ${quoteCur}`
      : (fb > 0 || fsl > 0)
        ? `Desequilíbrio: comprou ${fb} e vendeu ${fsl} ${base}. Bot parado — reequilibre os saldos e volte a ligar o servidor.`
        : 'Nenhuma ordem executou (preço mudou antes) — sem perda' });
  }
  const t = { status: 'held', symbol, buyExchange, sellExchange, amount, netProfit: 0, attempts: MAX_ATTEMPTS, lastNetPct: last?.netPct ?? null };
  record({ source, ...t });
  return send(200, { ok: true, ...t, message: `Sem lucro após ${MAX_ATTEMPTS} recálculos — nenhuma ordem enviada, saldo mantido`, orders: [] });
}

// completa a perna que ficou para trás sem vender abaixo do custo da compra (nem comprar acima da venda)
async function completeLeg({ bx, sx, symbol, fb, fsl, q }) {
  const orders = [];
  for (let i = 0; i < 3 && Math.abs(fb - fsl) > 1e-9; i++) {
    const diff = Math.abs(fb - fsl);
    try {
      if (fb > fsl) {               // comprou mais do que vendeu: vender o resto na corretora de venda
        const ob = await sx.fetchOrderBook(symbol, 20); const w = walk(ob.bids, diff);
        const floor = q.buyPrice * (1 + q.fees.buy) / (1 - q.fees.sell); // preço mínimo sem prejuízo
        if (!w || w.worst < floor) { await sleep(1500); continue; }
        const o = await sx.createOrder(symbol, 'limit', 'sell', Number(sx.amountToPrecision(symbol, diff)), Number(sx.priceToPrecision(symbol, w.worst)), { timeInForce: 'IOC' });
        fsl += o.filled || 0; orders.push({ side: 'sell', fix: true, id: o.id, filled: o.filled, price: o.average ?? o.price });
      } else {                      // vendeu mais do que comprou: comprar o resto na corretora de compra
        const ob = await bx.fetchOrderBook(symbol, 20); const w = walk(ob.asks, diff);
        const cap = q.sellPrice * (1 - q.fees.sell) / (1 + q.fees.buy); // preço máximo sem prejuízo
        if (!w || w.worst > cap) { await sleep(1500); continue; }
        const o = await bx.createOrder(symbol, 'limit', 'buy', Number(bx.amountToPrecision(symbol, diff)), Number(bx.priceToPrecision(symbol, w.worst)), { timeInForce: 'IOC' });
        fb += o.filled || 0; orders.push({ side: 'buy', fix: true, id: o.id, filled: o.filled, price: o.average ?? o.price });
      }
    } catch (e) { orders.push({ fix: true, error: e.message }); await sleep(1500); }
  }
  return { orders, fb, fsl };
}

// INVENTÁRIO: mostra quantas operações ainda cabem em cada lado e avisa quando é preciso reequilibrar
const REBALANCE_MIN_OPS = Number(process.env.REBALANCE_MIN_OPS ?? 2);
app.get('/api/inventory', wrap(async (req, res) => {
  const amount = Number(req.query.amount) || DEFAULT_AMOUNT;
  const ids = EXCHANGES.filter(hasKeys);
  const bals = {};
  await Promise.all(ids.map(async id => { try { bals[id] = (await client(id).fetchBalance()).free; } catch (e) { bals[id] = { error: e.message }; } }));
  const out = ids.map(id => {
    const b = bals[id] || {}; if (b.error) return { exchange: id, error: b.error };
    const coins = Object.fromEntries(COINS.map(c => [c, b[c] ?? 0]));
    const opsBuy = Math.floor((coins.USDT || 0) / amount), opsBuyUSDC = Math.floor((coins.USDC || 0) / amount); // compras possíveis (pares /USDT e /USDC)
    const low = COINS.filter(c => c !== 'USDT' && c !== 'USDC' && (coins[c] || 0) > 0 && coins[c] < amount * REBALANCE_MIN_OPS);
    return { exchange: id, coins, opsBuy, opsBuyUSDC, needsRebalance: opsBuy < REBALANCE_MIN_OPS || low.length > 0, lowCoins: low };
  });
  res.json({ ok: true, amount, minOps: REBALANCE_MIN_OPS, inventory: out,
    note: 'Reequilibrar só quando necessário, pela rede mais barata (ex.: BEP20 / TRC20 conforme a moeda), e de preferência em lote.' });
}));

// ---------- ROTA COM TRANSFERÊNCIA (método Arb Desk) ----------
// Compra a moeda na corretora A, pede o endereço de depósito na B, saca pela rede mais barata em comum,
// espera o depósito, recalcula e só vende na B se ainda houver lucro (senão mantém a moeda, sem prejuízo).
// O lucro já desconta a taxa de saque da rede. Em DRY_RUN só simula; em real precisa de chaves com SAQUE
// (de preferência com lista branca de endereços) nas corretoras de origem.
const NET_TTL = 30 * 60000;
const TRANSFER_TIMEOUT_MIN = Number(process.env.TRANSFER_TIMEOUT_MIN ?? 30);
const netCache = {}; // id -> { at, cur, error }
const NET_ALIAS = { OPTIMISM: 'OP', 'AVAXC-CHAIN': 'AVAXC', AVAX_C: 'AVAXC', BSC: 'BEP20', TRX: 'TRC20', ETH: 'ERC20', POLYGON: 'MATIC', ARB: 'ARBITRUM', ARBONE: 'ARBITRUM', KAVAEVM: 'KAVAEVM' };
const normNet = n => { const u = String(n || '').toUpperCase(); return NET_ALIAS[u] || u; };
async function networksOf(id) {
  const c = netCache[id];
  if (c && Date.now() - c.at < (c.error ? 300000 : NET_TTL)) return c.cur;
  const ex = client(id); let cur = {};
  try {
    cur = await ex.fetchCurrencies() || {};
    const codes = [...new Set(SYMBOLS.map(x => x.split('/')[0]))];
    const missing = codes.some(code => Object.values(cur[code]?.networks || {}).some(n => typeof n.fee !== 'number'));
    if (missing && ex.has.fetchDepositWithdrawFees && hasKeys(id)) {
      try {
        const f = await ex.fetchDepositWithdrawFees(codes);
        for (const code of codes) for (const [net, v] of Object.entries(f[code]?.networks || {})) {
          const w = v?.withdraw?.fee; if (typeof w !== 'number') continue;
          cur[code] = cur[code] || { networks: {} }; cur[code].networks = cur[code].networks || {};
          const k = Object.keys(cur[code].networks).find(x => normNet(x) === normNet(net)) || net;
          cur[code].networks[k] = { ...(cur[code].networks[k] || {}), fee: w };
        }
      } catch (e) {}
    }
    netCache[id] = { at: Date.now(), cur };
  } catch (e) { netCache[id] = { at: Date.now(), cur: c?.cur || {}, error: e.message.slice(0, 160) }; }
  return netCache[id].cur;
}
// redes em comum: saque ativo em A, depósito ativo em B, taxa de saque conhecida; a mais barata primeiro
function commonNets(curA, curB, code) {
  const a = curA[code]?.networks || {}, b = curB[code]?.networks || {};
  const bMap = {}; for (const [k, v] of Object.entries(b)) bMap[normNet(k)] = { key: k, ...v };
  const out = [];
  for (const [k, v] of Object.entries(a)) {
    const nb = bMap[normNet(k)];
    if (!nb || v.withdraw === false || v.active === false || nb.deposit === false || nb.active === false || typeof v.fee !== 'number') continue;
    out.push({ network: normNet(k), netA: k, netB: nb.key, fee: v.fee, min: v.limits?.withdraw?.min ?? null });
  }
  return out.sort((x, y) => x.fee - y.fee);
}
function calcTransfer(bb, sb, fb, fs_, amount, wfee) {
  const buy = walk(bb.asks, amount); if (!buy) return null;
  const got = amount * (1 - fb) - wfee;       // taxa de compra cobrada na moeda + taxa de saque
  if (got <= 0) return null;
  const sell = walk(sb.bids, got); if (!sell) return null;
  const cost = amount * buy.avg, revenue = got * sell.avg * (1 - fs_), net = revenue - cost;
  return { buy, sell, got, cost, revenue, net, netPct: net / cost * 100, feesTotal: cost * fb + wfee * buy.avg + got * sell.avg * fs_ };
}
async function quoteTransfer(buyId, sellId, symbol, amount) {
  const [base, q] = symbol.split('/');
  const bx = client(buyId), sx = client(sellId);
  await Promise.all([ensureMarkets(bx), ensureMarkets(sx), refreshFees(buyId), refreshFees(sellId)]);
  const [curA, curB] = await Promise.all([networksOf(buyId), networksOf(sellId)]);
  const nets = commonNets(curA, curB, base);
  if (!nets.length) return null;
  const net = nets[0];
  const [bb, sb] = await Promise.all([bx.fetchOrderBook(symbol, 20), sx.fetchOrderBook(symbol, 20)]);
  const fb = takerFee(bx, symbol), fs_ = takerFee(sx, symbol);
  const r = calcTransfer(bb, sb, fb, fs_, amount, net.fee);
  if (!r) return null;
  const hiAmt = MAX_ORDER_QUOTE / Math.max(bb.asks[0]?.[0] || 1, 1e-9);
  let best = null, bestAmt = 0;
  for (let i = 1; i <= 40; i++) {
    const amt = hiAmt * i / 40; if (net.min && amt < net.min) continue;
    const m = calcTransfer(bb, sb, fb, fs_, amt, net.fee);
    if (m && m.netPct >= MIN_PROFIT_PCT && (!best || m.net > best.net)) { best = m; bestAmt = amt; }
  }
  return {
    type: 'transfer', symbol, buyExchange: buyId, sellExchange: sellId, amount, quote: q,
    network: net.network, withdrawFee: net.fee, withdrawMin: net.min, otherNetworks: nets.slice(1, 4).map(n => ({ network: n.network, fee: n.fee })),
    buyPrice: r.buy.avg, sellPrice: r.sell.avg, buyLimit: r.buy.worst, sellLimit: r.sell.worst,
    grossPct: (r.sell.avg / r.buy.avg - 1) * 100, netPct: r.netPct, netProfit: r.net, fees: { buy: fb, sell: fs_ },
    steps: ['VERIFICAR PREÇOS', 'VERIFICAR SALDO', `COMPRAR ${base} na ${buyId}`, `ENDEREÇO DE DEPÓSITO na ${sellId} (${net.network}, taxa ${net.fee} ${base})`, 'SAQUE', 'AGUARDAR DEPÓSITO', 'RECALCULAR ROTA', `VENDER ${base} na ${sellId}`],
    preview: { invest: r.cost, revenue: r.revenue, feesTotal: r.feesTotal, netProfit: r.net, netPct: r.netPct, meetsMin: r.netPct >= MIN_PROFIT_PCT, minProfitPct: MIN_PROFIT_PCT,
      maxAmount: best ? bestAmt : 0, maxInvest: best ? best.cost : 0, maxNetProfit: best ? best.net : 0 }
  };
}
async function scanTransfers(amount, all) {
  const list = [];
  for (const symbol of SYMBOLS) {
    const ids = [];
    for (const id of EXCHANGES) if (await supports(id, symbol)) ids.push(id);
    const pairs = []; for (const a of ids) for (const b of ids) if (a !== b) pairs.push([a, b]);
    const qs = await Promise.all(pairs.map(([a, b]) => quoteTransfer(a, b, symbol, amount).catch(() => null)));
    for (const q of qs) if (q && (all || q.netPct > 0)) list.push({ id: `T:${symbol}:${q.buyExchange}>${q.sellExchange}`, ...q });
  }
  list.sort((x, y) => (y.preview.maxNetProfit - x.preview.maxNetProfit) || (y.netProfit - x.netProfit));
  return { ok: true, type: 'transfer', minProfitPct: MIN_PROFIT_PCT, opportunities: list.slice(0, 20) };
}
app.get('/api/transfer-opportunities', wrap(async (req, res) => res.json(await scanTransfers(Number(req.query.amount) || DEFAULT_AMOUNT, req.query.all === '1'))));
app.get('/api/networks', wrap(async (req, res) => {
  const code = String(req.query.coin || 'USDT').toUpperCase(), ids = EXCHANGES.filter(id => !(marketFail[id] && Date.now() - marketFail[id] < 60000));
  const out = {};
  await Promise.all(ids.map(async id => { const c = await networksOf(id); out[id] = Object.entries(c[code]?.networks || {}).map(([k, v]) => ({ network: normNet(k), fee: v.fee ?? null, withdraw: v.withdraw !== false, deposit: v.deposit !== false })).sort((a, b) => (a.fee ?? 1e9) - (b.fee ?? 1e9)); }));
  res.json({ ok: true, coin: code, networks: out });
}));

// execução da rota com transferência: corre em segundo plano (o depósito pode demorar minutos)
const transferJobs = new Map();
function jobStep(job, step, info) { job.steps.push({ at: new Date().toISOString(), step, info }); job.current = step; }
async function executeTransfer(input) {
  if (STOPPED) return { code: 423, body: { ok: false, status: 'aborted', message: 'Bot parado pelo botão de emergência' } };
  const { buyExchange, sellExchange, symbol } = input, source = input.source || 'manual';
  const amount = Number(input.amount);
  if (!EXCHANGES.includes(buyExchange) || !EXCHANGES.includes(sellExchange) || buyExchange === sellExchange) return { code: 400, body: { ok: false, error: 'Corretoras inválidas' } };
  if (!SYMBOLS.includes(symbol)) return { code: 400, body: { ok: false, error: 'Par não permitido' } };
  if (!(amount > 0)) return { code: 400, body: { ok: false, error: 'Quantidade inválida' } };
  const q = await quoteTransfer(buyExchange, sellExchange, symbol, amount);
  if (!q) return { code: 200, body: { ok: true, status: 'aborted', message: 'Sem rede em comum ou livro sem profundidade' } };
  if (q.amount * q.buyPrice > MAX_ORDER_QUOTE) return { code: 400, body: { ok: false, status: 'aborted', message: `Acima do limite por operação (${MAX_ORDER_QUOTE} ${q.quote})` } };
  if (q.withdrawMin && amount * (1 - q.fees.buy) < q.withdrawMin) return { code: 200, body: { ok: true, status: 'aborted', message: `Abaixo do saque mínimo da rede ${q.network} (${q.withdrawMin})` } };
  if (q.netPct < MIN_PROFIT_PCT) { const t = { type: 'transfer', status: 'held', symbol, buyExchange, sellExchange, amount, netProfit: 0, lastNetPct: q.netPct, network: q.network }; record({ source, ...t }); return { code: 200, body: { ok: true, ...t, message: `Lucro ${q.netPct.toFixed(3)}% abaixo do mínimo depois da taxa de saque — nada executado` } }; }
  if (DRY_RUN) {
    const t = { type: 'transfer', status: 'dry_run', symbol, buyExchange, sellExchange, amount, network: q.network, withdrawFee: q.withdrawFee, netProfit: q.netProfit, netPct: q.netPct, steps: q.steps, preview: q.preview };
    record({ source, ...t });
    return { code: 200, body: { ok: true, ...t, message: `Simulação: ${q.steps.join(' → ')} · lucro líquido ${q.netProfit.toFixed(4)} ${q.quote} (${q.netPct.toFixed(3)}%) — nada enviado (DRY_RUN)` } };
  }
  if (!hasKeys(buyExchange) || !hasKeys(sellExchange)) return { code: 400, body: { ok: false, error: 'Faltam chaves API nas duas corretoras' } };
  const job = { id: crypto.randomBytes(6).toString('hex'), type: 'transfer', source, symbol, buyExchange, sellExchange, amount, network: q.network, status: 'running', steps: [], startedAt: new Date().toISOString() };
  transferJobs.set(job.id, job);
  runTransferJob(job, q).catch(e => { job.status = 'error'; job.error = e.message; jobStep(job, 'ERRO', e.message); record({ source, type: 'transfer', status: 'error', symbol, buyExchange, sellExchange, amount, netProfit: 0, message: e.message, steps: job.steps }); setStopped(true); });
  return { code: 202, body: { ok: true, status: 'running', jobId: job.id, message: 'Rota com transferência iniciada — acompanhe em /api/transfer-jobs/' + job.id } };
}
async function runTransferJob(job, q) {
  const { buyExchange, sellExchange, symbol, amount } = job, [base, quoteCur] = symbol.split('/');
  const bx = client(buyExchange), sx = client(sellExchange);
  jobStep(job, 'VERIFICAR SALDO');
  const bBal = await bx.fetchBalance();
  if ((bBal.free[quoteCur] ?? 0) < amount * q.buyLimit * 1.002) { job.status = 'aborted'; jobStep(job, 'CANCELADO', `Saldo insuficiente de ${quoteCur} na ${buyExchange}`); record({ source: job.source, type: 'transfer', status: 'aborted', symbol, buyExchange, sellExchange, amount, netProfit: 0, message: 'Saldo insuficiente' }); return; }
  jobStep(job, 'ENDEREÇO DE DEPÓSITO');
  const curB = await networksOf(sellExchange), curA = await networksOf(buyExchange);
  const net = commonNets(curA, curB, base).find(n => n.network === q.network);
  if (!net) throw new Error('Rede ' + q.network + ' deixou de estar disponível');
  const addr = await sx.fetchDepositAddress(base, { network: net.netB });
  if (!addr?.address) throw new Error('Sem endereço de depósito na ' + sellExchange);
  jobStep(job, 'COMPRAR CRIPTO');
  const f = await quoteTransfer(buyExchange, sellExchange, symbol, amount);
  if (!f || f.netPct < MIN_PROFIT_PCT) { job.status = 'held'; jobStep(job, 'MANTIDO', 'Lucro desapareceu antes de comprar — nada executado'); record({ source: job.source, type: 'transfer', status: 'held', symbol, buyExchange, sellExchange, amount, netProfit: 0 }); return; }
  const amt = Number(bx.amountToPrecision(symbol, amount));
  const o = await bx.createOrder(symbol, 'limit', 'buy', amt, Number(bx.priceToPrecision(symbol, f.buyLimit)), { timeInForce: 'IOC' });
  const bought = o.filled || 0;
  if (!(bought > 0)) { job.status = 'aborted'; jobStep(job, 'CANCELADO', 'Compra não executou (preço mudou) — sem perda'); record({ source: job.source, type: 'transfer', status: 'aborted', symbol, buyExchange, sellExchange, amount, netProfit: 0 }); return; }
  const cost = o.cost ?? bought * (o.average ?? f.buyPrice);
  await sleep(1500);
  const freeBase = (await bx.fetchBalance()).free[base] ?? bought;
  const sendAmt = Math.min(bought, freeBase);
  jobStep(job, 'SAQUE', `${sendAmt} ${base} via ${net.network} (taxa ${net.fee})`);
  const w = await bx.withdraw(base, sendAmt, addr.address, addr.tag, { network: net.netA });
  job.withdrawId = w?.id;
  jobStep(job, 'AGUARDAR DEPÓSITO');
  const before = (await sx.fetchBalance()).free[base] ?? 0, expect = sendAmt - net.fee, deadline = Date.now() + TRANSFER_TIMEOUT_MIN * 60000;
  let arrived = false, got = 0;
  while (Date.now() < deadline) {
    await sleep(20000);
    const now = (await sx.fetchBalance()).free[base] ?? 0;
    if (now - before >= expect * 0.98) { arrived = true; got = Math.min(now - before, expect); break; }
  }
  if (!arrived) { job.status = 'waiting_deposit'; jobStep(job, 'DEPÓSITO ATRASADO', `Ainda não chegou após ${TRANSFER_TIMEOUT_MIN} min — Autobot parado até verificar`); setStopped(true); record({ source: job.source, type: 'transfer', status: 'waiting_deposit', symbol, buyExchange, sellExchange, amount: bought, netProfit: 0, withdrawId: job.withdrawId }); return; }
  const sellQty = got || expect, floor = cost / (sellQty * (1 - takerFee(sx, symbol)));  // preço mínimo de venda sem prejuízo
  for (let i = 1; i <= MAX_ATTEMPTS * 2; i++) {
    jobStep(job, 'RECALCULAR ROTA', 'tentativa ' + i);
    const ob = await sx.fetchOrderBook(symbol, 20), wk = walk(ob.bids, sellQty);
    if (wk && wk.worst >= floor) {
      jobStep(job, 'VENDER');
      const so = await sx.createOrder(symbol, 'limit', 'sell', Number(sx.amountToPrecision(symbol, sellQty)), Number(sx.priceToPrecision(symbol, wk.worst)), { timeInForce: 'IOC' });
      const rev = (so.cost ?? (so.filled || 0) * (so.average ?? wk.avg)) * (1 - takerFee(sx, symbol));
      if ((so.filled || 0) > 0) { const profit = rev - cost * ((so.filled || 0) / sellQty); job.status = 'executed'; job.netProfit = profit; jobStep(job, 'CONCLUÍDO', `lucro ${profit.toFixed(4)} ${quoteCur}`); record({ source: job.source, type: 'transfer', status: 'executed', symbol, buyExchange, sellExchange, amount: bought, network: net.network, netProfit: profit, steps: job.steps }); return; }
    }
    await sleep(15000 * i);
  }
  job.status = 'held_coin'; jobStep(job, 'MANTIDO', `Venda sem lucro neste momento — ${base} fica na ${sellExchange} (sem vender abaixo do custo)`);
  record({ source: job.source, type: 'transfer', status: 'held_coin', symbol, buyExchange, sellExchange, amount: bought, netProfit: 0 });
}
app.post('/api/execute-transfer', wrap(async (req, res) => { const r = await executeTransfer({ ...(req.body || {}), source: 'manual' }); res.status(r.code).json(r.body); }));
app.get('/api/transfer-jobs/:id', wrap(async (req, res) => { const j = transferJobs.get(req.params.id); if (!j) return res.status(404).json({ ok: false, error: 'Não encontrado' }); res.json({ ok: true, job: j }); }));
app.get('/api/transfer-jobs', wrap(async (req, res) => res.json({ ok: true, jobs: [...transferJobs.values()].slice(-20).reverse() })));

// ---------- AUTOBOT 24h no servidor ----------
// Corre sozinho com a configuração definida: procura a rota com maior lucro em USDT e executa-a
// pela mesma função do clique manual (recálculo, reverificação, anti-perda). Em DRY_RUN só simula.
const AUTOBOT_FILE = path.join(DATA_DIR, 'autobot.json');
const GIST_AUTOBOT = 'jet7-autobot.json';
const AUTOBOT_DEFAULT = { enabled: false, routeTypes: ['simultanea', 'transferencia'], amount: DEFAULT_AMOUNT, minProfitUsdt: 0, intervalSec: 45, cooldownSec: 120, symbols: [], exchanges: [] };
let autobot = { ...AUTOBOT_DEFAULT, ...readJSON(AUTOBOT_FILE, {}) };
const autoState = { running: false, lastScanAt: null, lastScanMs: null, lastBest: null, lastAction: null, lastError: null, trades: 0, simulated: 0, profitUsdt: 0, startedAt: null };
const routeCooldown = new Map();
let autoTimer = null;

function sanitizeAutobot(c) {
  const o = { ...autobot };
  if (typeof c.enabled === 'boolean') o.enabled = c.enabled;
  if (c.amount != null) o.amount = Math.min(Math.max(Number(c.amount) || DEFAULT_AMOUNT, 1), MAX_ORDER_QUOTE);
  if (c.minProfitUsdt != null) o.minProfitUsdt = Math.max(Number(c.minProfitUsdt) || 0, 0);
  if (c.intervalSec != null) o.intervalSec = Math.min(Math.max(Number(c.intervalSec) || 45, 20), 3600);
  if (c.cooldownSec != null) o.cooldownSec = Math.min(Math.max(Number(c.cooldownSec) || 0, 0), 86400);
  if (Array.isArray(c.symbols)) o.symbols = c.symbols.filter(x => SYMBOLS.includes(x));
  if (Array.isArray(c.routeTypes)) o.routeTypes = c.routeTypes.filter(x => ['simultanea', 'transferencia'].includes(x));
  if (Array.isArray(c.exchanges)) o.exchanges = c.exchanges.filter(x => EXCHANGES.includes(x));
  return o;
}
async function saveAutobot() {
  writeJSON(AUTOBOT_FILE, autobot);
  if (!GH_TOKEN) return;
  try { await gh('/gists/' + await findOrCreateGist(), { method: 'PATCH', body: JSON.stringify({ files: { [GIST_AUTOBOT]: { content: JSON.stringify(autobot, null, 1) } } }) }); }
  catch (e) { console.warn('Gist autobot: ' + e.message); }
}
async function loadAutobotFromGist() {
  if (!GH_TOKEN) return;
  try {
    const g = await gh('/gists/' + await findOrCreateGist());
    const f = g.files[GIST_AUTOBOT];
    if (f && f.content) { autobot = { ...AUTOBOT_DEFAULT, ...JSON.parse(f.content) }; writeJSON(AUTOBOT_FILE, autobot); if (autobot.stopped) { STOPPED = true; console.log('Botão de emergência continua ATIVO'); } console.log('Autobot carregado do Gist: ' + (autobot.enabled ? 'LIGADO' : 'desligado')); }
  } catch (e) { console.warn('Gist autobot: ' + e.message); }
}

async function autobotTick() {
  if (!autobot.enabled || autoState.running) return;
  if (STOPPED) { autoState.lastAction = { at: new Date().toISOString(), status: 'paused', message: 'Botão de emergência ativo' }; return; }
  autoState.running = true; const t0 = Date.now();
  try {
    const types = autobot.routeTypes && autobot.routeTypes.length ? autobot.routeTypes : ['simultanea'];
    const parts = await Promise.all([
      types.includes('simultanea') ? scanOpps(autobot.amount, false) : { opportunities: [] },
      types.includes('transferencia') && ![...transferJobs.values()].some(j => j.status === 'running') ? scanTransfers(autobot.amount, false) : { opportunities: [] }
    ]);
    const data = { opportunities: parts[0].opportunities.concat(parts[1].opportunities).sort((x, y) => (y.preview.maxNetProfit - x.preview.maxNetProfit) || (y.netProfit - x.netProfit)) };
    autoState.lastScanAt = new Date().toISOString(); autoState.lastScanMs = Date.now() - t0;
    const now = Date.now();
    const cands = data.opportunities.filter(o =>
      (o.preview.meetsMin || (o.preview.maxNetProfit > 0 && o.preview.maxAmount <= autobot.amount)) && Math.max(o.netProfit, o.preview.maxNetProfit) >= autobot.minProfitUsdt &&
      (!autobot.symbols.length || autobot.symbols.includes(o.symbol)) &&
      (!autobot.exchanges.length || (autobot.exchanges.includes(o.buyExchange) && autobot.exchanges.includes(o.sellExchange))) &&
      (DRY_RUN || (hasKeys(o.buyExchange) && hasKeys(o.sellExchange))) &&
      !((routeCooldown.get(o.id) || 0) > now));
    autoState.lastBest = data.opportunities[0] ? { id: data.opportunities[0].id, netPct: data.opportunities[0].netPct, netProfit: data.opportunities[0].netProfit, maxNetProfit: data.opportunities[0].preview.maxNetProfit } : null;
    if (!cands.length) { autoState.lastAction = { at: autoState.lastScanAt, status: 'waiting', message: 'Nenhuma rota acima do mínimo' }; return; }
    for (const o of cands.slice(0, 3)) {
      const args = { buyExchange: o.buyExchange, sellExchange: o.sellExchange, symbol: o.symbol, amount: o.preview.maxAmount > 0 ? Math.min(o.preview.maxAmount, autobot.amount) : autobot.amount, source: 'autobot' };
      const r = o.type === 'transfer' ? await executeTransfer(args) : await executeRoute(args);
      const b = r.body || {};
      autoState.lastAction = { at: new Date().toISOString(), route: o.id, status: b.status || (b.ok ? 'ok' : 'error'), netProfit: b.netProfit ?? 0, message: b.message || b.error };
      if (b.status === 'aborted' && /Saldo insuficiente/.test(b.message || '')) { routeCooldown.set(o.id, Date.now() + 10 * 60000); continue; }
      routeCooldown.set(o.id, Date.now() + autobot.cooldownSec * 1000);
      if (b.status === 'running') { autoState.trades++; break; }
      if (b.status === 'executed') { autoState.trades++; autoState.profitUsdt += b.netProfit || 0; }
      if (b.status === 'dry_run') { autoState.simulated++; autoState.profitUsdt += b.netProfit || 0; }
      break;
    }
  } catch (e) { autoState.lastError = { at: new Date().toISOString(), message: e.message }; }
  finally { autoState.running = false; }
}
function scheduleAutobot() {
  clearTimeout(autoTimer);
  if (!autobot.enabled) return;
  autoTimer = setTimeout(async () => { await autobotTick(); scheduleAutobot(); }, autobot.intervalSec * 1000);
}
function autobotStatus() {
  return { ok: true, dryRun: DRY_RUN, stopped: STOPPED, config: autobot, state: autoState,
    message: autobot.enabled ? (DRY_RUN ? 'Autobot ligado em SIMULAÇÃO (DRY_RUN): nenhuma ordem real é enviada' : 'Autobot ligado em MODO REAL') : 'Autobot desligado' };
}
app.get('/api/autobot', wrap(async (req, res) => res.json(autobotStatus())));
app.post('/api/autobot', wrap(async (req, res) => {
  const was = autobot.enabled;
  autobot = sanitizeAutobot(req.body || {});
  if (autobot.enabled && !was) { autoState.startedAt = new Date().toISOString(); autoState.trades = 0; autoState.simulated = 0; autoState.profitUsdt = 0; }
  await saveAutobot(); scheduleAutobot();
  res.json(autobotStatus());
}));
(async () => { await loadAutobotFromGist(); if (autobot.enabled) { autoState.startedAt = new Date().toISOString(); console.log('Autobot a correr no servidor (24h)'); } scheduleAutobot(); })();

app.post('/api/stop', wrap(async (req, res) => { setStopped(true); res.json({ ok: true, stopped: true }); }));
app.post('/api/resume', wrap(async (req, res) => { setStopped(false); res.json({ ok: true, stopped: false }); }));
app.get('/api/history', wrap(async (req, res) => res.json({ ok: true, trades: readJSON(HIST_FILE, []).slice(0, 200) })));

app.get('/', (req, res) => res.type('text').send('JET7 server ' + VERSION));
app.listen(PORT, () => console.log(`JET7 server ${VERSION} na porta ${PORT} — DRY_RUN=${DRY_RUN}`));
// manter acordado no Render Free (adormece após 15 min sem visitas): ping ao próprio endereço público a cada 10 min
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) setInterval(() => fetch(SELF_URL + '/').catch(() => {}), 10 * 60000);

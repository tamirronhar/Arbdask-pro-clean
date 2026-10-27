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

const VERSION = '1.15.1';
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
  // 1.9.5: TODAS as corretoras só spot (a OKX carregava futuros+opções = milhares de mercados)
  const o = { defaultType: 'spot', fetchMarkets: { types: ['spot'] }, fetchMargins: false };
  if (id === 'binance') o.fetchCurrencies = false; // a lista completa de moedas da Binance (dezenas de MB) só é lida em networksOf, uma vez
  return o;
}
function buildClient(id) {
  const store = readJSON(KEYS_FILE, {});
  const creds = store[id] ? dec(store[id]) : envCreds(id);
  const ex = new ccxt[id]({ enableRateLimit: true, timeout: 15000, options: spotOpts(id), ...creds });
  // 1.9.5: qualquer chamada interna do ccxt (fetchBalance, fetchOrderBook...) passa pelo carregamento leve e em fila,
  // em vez de descarregar todos os mercados e moedas da corretora em paralelo (era isto que passava os 512 MB)
  ex.loadMarkets = async (reload = false) => { if (ex.markets && !reload) return ex.markets; if (reload) ex.markets = undefined; return ensureMarkets(ex); };
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

// carrega mercados UMA corretora de cada vez e guarda só os pares do JET7 (poupa centenas de MB no Render Free)
let marketLock = Promise.resolve();
const KEEP_COINS = () => new Set(SYMBOLS.flatMap(x => x.split('/')).concat(['BNB', 'KCS', 'MX', 'GT', 'BGB']));
async function ensureMarkets(ex) {
  if (ex.markets) return ex.markets;
  const run = marketLock.then(async () => {
    if (ex.markets) return;
    if (global.gc) global.gc();
    // só a lista de mercados spot, sem a lista de moedas; na Binance sem os 'permissionSets' (a maior parte dos ~20 MB)
    let list;
    if (ex.id === 'binance') { try { list = await ex.fetchMarkets({ showPermissionSets: false, symbolStatus: 'TRADING' }); } catch (e) { list = await ex.fetchMarkets({ showPermissionSets: false }); } }
    else list = await ex.fetchMarkets();
    const keep = KEEP_COINS(), mk = [];
    for (const m of list) if (m && (SYMBOLS.includes(m.symbol) || (m.spot && keep.has(m.base) && m.quote === 'USDT'))) mk.push(m);
    list = null;
    ex.setMarkets(mk);
    if (global.gc) global.gc();
  });
  marketLock = run.catch(() => {});
  await run; return ex.markets;
}

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

// livro partilhado: cada corretora+par é lido uma vez a cada 3 s, mesmo que entre em várias rotas (menos memória e pedidos)
const bookCache = new Map();
function bookOf(id, symbol) {
  const k = id + '|' + symbol, c = bookCache.get(k);
  if (c && Date.now() - c.at < 3000) return c.p;
  const p = client(id).fetchOrderBook(symbol, 20).then(ob => ({ bids: ob.bids.slice(0, 20), asks: ob.asks.slice(0, 20), timestamp: ob.timestamp }));
  bookCache.set(k, { at: Date.now(), p }); p.catch(() => bookCache.delete(k));
  if (bookCache.size > 300) for (const [kk, v] of bookCache) if (Date.now() - v.at > 10000) bookCache.delete(kk);
  return p;
}
async function quote(buyId, sellId, symbol, amount) {
  const bx = client(buyId), sx = client(sellId);
  await Promise.all([ensureMarkets(bx), ensureMarkets(sx)]);
  await Promise.all([refreshFees(buyId), refreshFees(sellId)]);
  const [bb, sb] = await Promise.all([bookOf(buyId, symbol), bookOf(sellId, symbol)]);
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
    memory: { rssMb: memState.rssMb, peakMb: memState.peakMb, cleanups: memState.cleanups, recycles: memState.recycles },
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
// ---------- 1.11.0: ROTAS TRIANGULARES NA MESMA CORRETORA ----------
// USDT → X → USDC → USDT (ou o inverso), tudo dentro de uma corretora: sem transferências e sem precisar de saldo
// noutras corretoras. Com stablecoins de taxa 0% (Binance, MEXC, Bitget) pequenas diferenças de preço viram lucro.
const TRI_ENABLED = String(process.env.TRI_ENABLED ?? 'true').toLowerCase() !== 'false';
async function triQuote(id, X, amount) {
  const ex = client(id), sXT = X + '/USDT', sXC = X + '/USDC', sCT = 'USDC/USDT';
  const [bXT, bXC, bCT] = await Promise.all([bookOf(id, sXT), bookOf(id, sXC), bookOf(id, sCT)]);
  const f = s => takerFee(ex, s), out = [];
  // A: compra X com USDT → vende X por USDC → vende USDC por USDT
  if (bXT.asks[0] && bXC.bids[0] && bCT.bids[0]) {
    const qx = amount / bXT.asks[0][0], w1 = walk(bXT.asks, qx), w2 = walk(bXC.bids, qx * (1 - f(sXT)));
    if (w1 && w2) { const usdc = qx * (1 - f(sXT)) * w2.avg * (1 - f(sXC)), w3 = walk(bCT.bids, usdc);
      if (w3) { const cost = qx * w1.avg, back = usdc * w3.avg * (1 - f(sCT));
        out.push({ dir: 'A', path: `USDT→${X}→USDC→USDT`, legs: [{ symbol: sXT, side: 'buy', amount: qx, limit: w1.worst }, { symbol: sXC, side: 'sell', amount: qx * (1 - f(sXT)), limit: w2.worst }, { symbol: sCT, side: 'sell', amount: usdc, limit: w3.worst }], cost, back }); } }
  }
  // B: compra USDC com USDT → compra X com USDC → vende X por USDT
  if (bCT.asks[0] && bXC.asks[0] && bXT.bids[0]) {
    const qu = amount / bCT.asks[0][0], w1 = walk(bCT.asks, qu);
    if (w1) { const usdc = qu * (1 - f(sCT)), qx0 = usdc / bXC.asks[0][0], w2 = walk(bXC.asks, qx0);
      if (w2) { const qx = usdc / w2.avg * (1 - f(sXC)), w3 = walk(bXT.bids, qx);
        if (w3) { const cost = qu * w1.avg, back = qx * w3.avg * (1 - f(sXT));
          out.push({ dir: 'B', path: `USDT→USDC→${X}→USDT`, legs: [{ symbol: sCT, side: 'buy', amount: qu, limit: w1.worst }, { symbol: sXC, side: 'buy', amount: usdc / w2.avg, limit: w2.worst }, { symbol: sXT, side: 'sell', amount: qx, limit: w3.worst }], cost, back }); } } }
  }
  return out.map(o => ({ type: 'triangular', id: `TRI:${id}:${o.path}`, exchange: id, symbol: o.path, path: o.path, dir: o.dir, legs: o.legs, invest: o.cost, netProfit: o.back - o.cost, netPct: (o.back / o.cost - 1) * 100, meetsMin: (o.back / o.cost - 1) * 100 >= MIN_PROFIT_PCT }));
}
let triCache = { at: 0, list: [] };
async function scanTriangles(amount) {
  if (!TRI_ENABLED) return { ok: true, opportunities: [] };
  if (Date.now() - triCache.at < 20000 && triCache.amount === amount) return { ok: true, opportunities: triCache.list };
  const list = [];
  for (const id of EXCHANGES) {                       // uma corretora de cada vez (memória)
    if (!(await supports(id, 'USDC/USDT'))) continue;
    for (const X of COINS) {
      if (X === 'USDT' || X === 'USDC') continue;
      if (!(await supports(id, X + '/USDT')) || !(await supports(id, X + '/USDC'))) continue;
      try { list.push(...await triQuote(id, X, amount)); } catch (e) {}
    }
  }
  list.sort((a, b) => b.netProfit - a.netProfit);
  triCache = { at: Date.now(), amount, list: list.slice(0, 20) };
  return { ok: true, minProfitPct: MIN_PROFIT_PCT, opportunities: triCache.list };
}
async function executeTriangle(input) {
  const send = (code, body) => ({ code, body }), source = input.source || 'manual';
  if (STOPPED) return send(423, { ok: false, status: 'aborted', message: 'Bot parado pelo botão de emergência' });
  const { exchange, path: wanted } = input, amount = Math.min(Number(input.amount) || DEFAULT_AMOUNT, MAX_ORDER_QUOTE);
  if (!EXCHANGES.includes(exchange)) return send(400, { ok: false, error: 'Corretora inválida' });
  const X = (String(wanted).split('→').find(c => c && c !== 'USDT' && c !== 'USDC')) || '';
  if (!COINS.includes(X)) return send(400, { ok: false, error: 'Rota inválida' });
  // recalcula com os livros de agora
  const q = (await triQuote(exchange, X, amount)).find(o => o.path === wanted);
  if (!q || !q.meetsMin) { const t = { type: 'triangular', status: 'held', exchange, symbol: wanted, amount, netProfit: 0, lastNetPct: q?.netPct ?? null }; record({ source, ...t }); return send(200, { ok: true, ...t, message: 'Triangular abaixo do mínimo após recálculo — nada enviado' }); }
  if (DRY_RUN) { const t = { type: 'triangular', status: 'dry_run', exchange, symbol: wanted, amount, netProfit: q.netProfit, netPct: q.netPct }; record({ source, ...t }); return send(200, { ok: true, ...t, message: `Simulação triangular ${wanted} na ${exchange}: lucro ${q.netProfit.toFixed(4)} USDT (${q.netPct.toFixed(3)}%) — nenhuma ordem enviada` }); }
  if (!hasKeys(exchange)) return send(400, { ok: false, error: 'Falta a chave API desta corretora' });
  // real: 3 ordens IOC em sequência, cada uma com o que a anterior realmente rendeu; se uma falhar, fica em stablecoin (sem perda relevante)
  const ex = client(exchange), orders = []; let carry = null;
  for (const [i, L] of q.legs.entries()) {
    try {
      let amt = L.amount;
      if (carry != null) amt = L.side === 'sell' ? carry : Math.min(L.amount, carry / L.limit);
      const o = await ex.createOrder(L.symbol, 'limit', L.side, Number(ex.amountToPrecision(L.symbol, amt)), Number(ex.priceToPrecision(L.symbol, L.limit)), { timeInForce: 'IOC' });
      orders.push({ leg: i + 1, symbol: L.symbol, side: L.side, filled: o.filled, price: o.average ?? o.price });
      if (!(o.filled > 0)) break;
      carry = L.side === 'buy' ? o.filled : (o.cost ?? o.filled * (o.average ?? L.limit));
    } catch (e) { orders.push({ leg: i + 1, symbol: L.symbol, error: e.message }); break; }
  }
  const done = orders.length === 3 && orders.every(o => o.filled > 0);
  const t = { type: 'triangular', status: done ? 'executed' : orders.some(o => o.filled > 0) ? 'partial' : 'aborted', exchange, symbol: wanted, amount, netProfit: done ? q.netProfit : 0, netPct: q.netPct, orders };
  record({ source, ...t });
  return send(200, { ok: true, ...t, message: done ? `Triangular executada: lucro estimado ${q.netProfit.toFixed(4)} USDT` : 'Triangular incompleta: o saldo ficou noutra stablecoin, sem perda relevante' });
}
app.get('/api/triangles', wrap(async (req, res) => res.json(await scanTriangles(Number(req.query.amount) || DEFAULT_AMOUNT))));
app.post('/api/execute-triangle', wrap(async (req, res) => { const r = await executeTriangle({ ...(req.body || {}), source: 'manual' }); res.status(r.code).json(r.body); }));

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
  // 1.10.0: contexto por cliente (chaves, limites e histórico próprios); sem contexto = conta do dono
  const gx = input.getEx || client, hk = input.hasKeys || hasKeys, rec = input.record || record, dry = DRY_RUN || !!input.forceDry;
  const maxQ = input.maxOrder ?? MAX_ORDER_QUOTE;
  if (STOPPED || (input.isStopped && input.isStopped())) return send(423, { ok: false, status: 'aborted', message: 'Bot parado pelo botão de emergência' });
  const { buyExchange, sellExchange, symbol } = input;
  const amount = Number(input.amount);
  if (!EXCHANGES.includes(buyExchange) || !EXCHANGES.includes(sellExchange) || buyExchange === sellExchange)
    return send(400, { ok: false, error: 'Corretoras inválidas' });
  if (!SYMBOLS.includes(symbol)) return send(400, { ok: false, error: 'Par não permitido' });
  if (!(amount > 0)) return send(400, { ok: false, error: 'Quantidade inválida' });
  if (!dry && (!hk(buyExchange) || !hk(sellExchange)))
    return send(400, { ok: false, error: 'Faltam chaves API nas duas corretoras' });

  const [base, quoteCur] = symbol.split('/');
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (STOPPED) break;
    // RECALCULAR ROTA com livros de ofertas atuais
    let q = await quote(buyExchange, sellExchange, symbol, amount);
    last = q;
    if (!q) { await sleep(1500); continue; }
    if (q.amount * q.buyPrice > maxQ)
      return send(400, { ok: false, status: 'aborted', message: `Acima do limite por operação (${maxQ} ${quoteCur})` });

    // PROTEÇÃO ANTI-PERDA: só avança com lucro líquido acima do mínimo
    if (q.netPct < MIN_PROFIT_PCT) { await sleep(1500 * attempt); continue; }

    if (dry) {
      const t = { status: 'dry_run', symbol, buyExchange, sellExchange, amount, netProfit: q.netProfit, netPct: q.netPct, attempts: attempt, preview: q.preview };
      rec({ source, ...t });
      return send(200, { ok: true, ...t, message: `Simulação: lucro líquido ${q.netProfit.toFixed(4)} ${quoteCur} (${q.netPct.toFixed(3)}%) — nenhuma ordem enviada (DRY_RUN)`, orders: [] });
    }

    // saldo suficiente nos dois lados (o dinheiro já está em cada corretora)
    const bx = gx(buyExchange), sx = gx(sellExchange);
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
    if (!ok && (fb > 0 || fsl > 0)) { if (input.onImbalance) input.onImbalance(); else setStopped(true); } // continua desequilibrada: pára tudo até o utilizador verificar
    const t = { status: ok ? 'executed' : (fb > 0 || fsl > 0) ? 'partial' : 'aborted', symbol, buyExchange, sellExchange, amount: amt, netProfit: ok ? q.netProfit : 0, netPct: q.netPct, attempts: attempt, preview: q.preview, orders };
    rec({ source, ...t });
    return send(200, { ok: true, ...t, message: ok
      ? `Executado: lucro estimado ${q.netProfit.toFixed(4)} ${quoteCur}`
      : (fb > 0 || fsl > 0)
        ? `Desequilíbrio: comprou ${fb} e vendeu ${fsl} ${base}. Bot parado — reequilibre os saldos e volte a ligar o servidor.`
        : 'Nenhuma ordem executou (preço mudou antes) — sem perda' });
  }
  const t = { status: 'held', symbol, buyExchange, sellExchange, amount, netProfit: 0, attempts: MAX_ATTEMPTS, lastNetPct: last?.netPct ?? null };
  rec({ source, ...t });
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


// ---------- EXECUÇÃO MAKER NUMA PONTA ----------
// 1) põe uma ordem limitada (post-only, fica no livro) no melhor preço da ponta maker;
// 2) espera até MAKER_WAIT_SEC que alguém a execute, verificando sempre se a outra ponta ainda dá lucro (senão cancela);
// 3) o que for executado é logo fechado na outra corretora a mercado (IOC com preço-limite sem prejuízo).
// Em DRY_RUN não envia ordens: segue os negócios públicos e só conta como executada se houver negócios ao nosso preço.
const MAKER_WAIT_SEC = Number(process.env.MAKER_WAIT_SEC ?? 180);
async function executeMaker(input) {
  const send = (code, body) => ({ code, body });
  const source = input.source || 'manual';
  if (STOPPED) return send(423, { ok: false, status: 'aborted', message: 'Bot parado pelo botão de emergência' });
  const { buyExchange, sellExchange, symbol } = input, amount = Number(input.amount);
  if (!EXCHANGES.includes(buyExchange) || !EXCHANGES.includes(sellExchange) || buyExchange === sellExchange) return send(400, { ok: false, error: 'Corretoras inválidas' });
  if (!SYMBOLS.includes(symbol)) return send(400, { ok: false, error: 'Par não permitido' });
  if (!(amount > 0)) return send(400, { ok: false, error: 'Quantidade inválida' });
  if (!DRY_RUN && (!hasKeys(buyExchange) || !hasKeys(sellExchange))) return send(400, { ok: false, error: 'Faltam chaves API nas duas corretoras' });
  const q = await quote(buyExchange, sellExchange, symbol, amount);
  if (!q || !q.maker) return send(200, { ok: true, status: 'aborted', message: 'Livro sem profundidade suficiente' });
  if (amount * q.buyPrice > MAX_ORDER_QUOTE) return send(400, { ok: false, status: 'aborted', message: `Acima do limite por operação (${MAX_ORDER_QUOTE})` });
  const m = { ...q.maker }, [base, quoteCur] = symbol.split('/');
  // 1.11.0: pôr a ordem 1 tick À FRENTE do melhor preço (quando o spread deixa), para ficar primeiro na fila.
  // Antes ficava atrás de toda a quantidade já parada nesse preço e quase nunca era executada.
  let jumped = false;
  try {
    const mex = m.side === 'compra' ? client(buyExchange) : client(sellExchange);
    await ensureMarkets(mex);
    const pp = mex.markets?.[symbol]?.precision?.price; const tick = pp == null ? null : (pp >= 1 ? Math.pow(10, -pp) : pp);
    const mb = await bookOf(m.side === 'compra' ? buyExchange : sellExchange, symbol);
    const bb0 = mb.bids[0]?.[0], ba0 = mb.asks[0]?.[0];
    if (tick && bb0 && ba0 && ba0 - bb0 > tick * 1.5) {
      const np = m.side === 'compra' ? bb0 + tick : ba0 - tick;
      const fM0 = m.side === 'compra' ? q.fees.buyMaker : q.fees.sellMaker;
      const inv = m.side === 'compra' ? amount * np * (1 + fM0) : m.invest, rev = m.side === 'compra' ? m.revenue : amount * np * (1 - fM0);
      // só salta se ainda ficar acima do lucro mínimo; senão mantém o preço original
      if ((rev - inv) / inv * 100 >= MIN_PROFIT_PCT) { m.invest = inv; m.revenue = rev; m.limitPrice = np; m.netProfit = rev - inv; m.netPct = m.netProfit / inv * 100; jumped = true; }
    }
  } catch (e) {}
  if (!m.realistic || m.netPct < MIN_PROFIT_PCT) { const t = { type: 'maker', status: 'held', symbol, buyExchange, sellExchange, amount, netProfit: 0, lastNetPct: m.netPct }; record({ source, ...t }); return send(200, { ok: true, ...t, message: `Maker ${m.netPct.toFixed(3)}% abaixo do mínimo — nada enviado` }); }
  const bx = client(buyExchange), sx = client(sellExchange);
  const mx = m.side === 'compra' ? bx : sx, tx = m.side === 'compra' ? sx : bx;   // corretora maker / corretora taker
  const makerSide = m.side === 'compra' ? 'buy' : 'sell';
  const fM = m.side === 'compra' ? q.fees.buyMaker : q.fees.sellMaker, fT = m.side === 'compra' ? q.fees.sell : q.fees.buy;
  // preço-limite da ponta taker que ainda dá lucro mínimo face ao nosso preço maker
  const takerLimit = m.side === 'compra' ? m.limitPrice * (1 + fM) * (1 + MIN_PROFIT_PCT / 100) / (1 - fT) : m.limitPrice * (1 - fM) / ((1 + fT) * (1 + MIN_PROFIT_PCT / 100));
  const stillOk = async () => { const ob = await tx.fetchOrderBook(symbol, 20); const w = walk(m.side === 'compra' ? ob.bids : ob.asks, amount); return w && (m.side === 'compra' ? w.worst >= takerLimit : w.worst <= takerLimit); };
  const t0 = Date.now(), deadline = t0 + MAKER_WAIT_SEC * 1000;
  let filled = 0, order = null, cancelled = null;
  if (DRY_RUN) {
    // simulação: conta como executada a quantidade negociada publicamente ao nosso preço (ou melhor para quem nos vende/compra)
    let since = t0;
    // fila à nossa frente: quantidade que já estava nesse preço (essa é executada antes da nossa)
    let ahead = 0; if (!jumped) try { const ob0 = await mx.fetchOrderBook(symbol, 20); const lv = (makerSide === 'buy' ? ob0.bids : ob0.asks).find(([p]) => p === m.limitPrice); ahead = lv ? lv[1] : 0; } catch (e) {}
    while (Date.now() < deadline && filled < amount) {
      await sleep(5000);
      if (!(await stillOk().catch(() => false))) { cancelled = 'outra ponta deixou de dar lucro'; break; }
      try {
        const tr = await mx.fetchTrades(symbol, since);
        for (const x of tr) { if (x.timestamp < since) continue; const hit = makerSide === 'buy' ? (x.side === 'sell' && x.price <= m.limitPrice) : (x.side === 'buy' && x.price >= m.limitPrice); if (!hit) continue; const better = makerSide === 'buy' ? x.price < m.limitPrice : x.price > m.limitPrice; let a = x.amount; if (!better) { const use = Math.min(ahead, a); ahead -= use; a -= use; } filled += a; }
        if (tr.length) since = Math.max(since, ...tr.map(x => x.timestamp + 1));
      } catch (e) {}
    }
    filled = Math.min(filled, amount);
  } else {
    // saldo nos dois lados
    const [bBal, sBal] = await Promise.all([bx.fetchBalance(), sx.fetchBalance()]);
    if ((bBal.free[quoteCur] ?? 0) < amount * q.buyLimit * 1.002 || (sBal.free[base] ?? 0) < amount)
      return send(200, { ok: true, status: 'aborted', netProfit: 0, message: `Saldo insuficiente: precisa de ${quoteCur} na ${buyExchange} e ${base} na ${sellExchange}` });
    const amt = Number(mx.amountToPrecision(symbol, amount));
    order = await mx.createOrder(symbol, 'limit', makerSide, amt, Number(mx.priceToPrecision(symbol, m.limitPrice)), { postOnly: true });
    while (Date.now() < deadline) {
      await sleep(3000);
      const o = await mx.fetchOrder(order.id, symbol).catch(() => null); if (o) filled = o.filled || 0;
      if (filled >= amt * 0.999 || (o && o.status === 'closed')) break;
      if (o && o.status === 'canceled') { cancelled = 'corretora cancelou (post-only)'; break; }
      if (!(await stillOk().catch(() => false))) { cancelled = 'outra ponta deixou de dar lucro'; break; }
    }
    try { await mx.cancelOrder(order.id, symbol); } catch (e) {}
    const o = await mx.fetchOrder(order.id, symbol).catch(() => null); if (o) filled = o.filled || filled;
  }
  // fechar o que foi executado na outra corretora
  let closed = 0, closeOrder = null, profit = 0;
  if (filled > 0) {
    const ob = await tx.fetchOrderBook(symbol, 20), w = walk(m.side === 'compra' ? ob.bids : ob.asks, filled);
    const px = w ? w.avg : null;
    if (DRY_RUN) { if (w) closed = filled; }
    else if (w) {
      const lim = m.side === 'compra' ? Math.max(w.worst, m.limitPrice * (1 + fM) / (1 - fT)) : Math.min(w.worst, m.limitPrice * (1 - fM) / (1 + fT));
      closeOrder = await tx.createOrder(symbol, 'limit', m.side === 'compra' ? 'sell' : 'buy', Number(tx.amountToPrecision(symbol, filled)), Number(tx.priceToPrecision(symbol, lim)), { timeInForce: 'IOC' });
      closed = closeOrder.filled || 0;
    }
    if (px && closed > 0) profit = m.side === 'compra' ? closed * (px * (1 - fT) - m.limitPrice * (1 + fM)) : closed * (m.limitPrice * (1 - fM) - px * (1 + fT));
    if (!DRY_RUN && Math.abs(filled - closed) > filled * 0.01) setStopped(true);
  }
  const status = filled <= 0 ? 'not_filled' : Math.abs(filled - closed) > filled * 0.01 ? 'partial' : (DRY_RUN ? 'dry_run' : 'executed');
  const t = { type: 'maker', status, symbol, buyExchange, sellExchange, makerSide: m.side, limitPrice: m.limitPrice, frontOfQueue: jumped, amount, filled, closed, netProfit: profit, expectedNetProfit: m.netProfit, waitedSec: Math.round((Date.now() - t0) / 1000), cancelled };
  record({ source, ...t });
  const msg = status === 'not_filled' ? `Ordem maker não foi executada em ${t.waitedSec}s${cancelled ? ' (' + cancelled + ')' : ''} — sem perda` :
    status === 'partial' ? `Desequilíbrio: executou ${filled} e fechou ${closed} ${base}. Bot parado — verifique os saldos.` :
    `${DRY_RUN ? 'Simulação' : 'Executado'}: ${filled.toFixed(4)} ${base} com ordem maker na ${m.side} → lucro ${profit.toFixed(4)} ${quoteCur}${filled < amount ? ' (execução parcial)' : ''}`;
  return send(200, { ok: true, ...t, message: msg });
}
app.post('/api/execute-maker', wrap(async (req, res) => { const r = await executeMaker({ ...(req.body || {}), source: 'manual' }); res.status(r.code).json(r.body); }));

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
// 1.9.5: um pedido por corretora de cada vez (antes, cada par de rotas pedia a lista completa de moedas em paralelo:
// dezenas de cópias de vários MB ao mesmo tempo = falta de memória no Render)
const netInflight = {}; let netLock = Promise.resolve();
function networksOf(id) {
  const c = netCache[id];
  if (c && Date.now() - c.at < (c.error ? 300000 : NET_TTL)) return Promise.resolve(c.cur);
  if (!netInflight[id]) { const run = netLock.then(() => _networksOf(id)); netLock = run.catch(() => {}); netInflight[id] = run.finally(() => { delete netInflight[id]; }); }
  return netInflight[id];
}
async function _networksOf(id) {
  const c = netCache[id];
  if (c && Date.now() - c.at < (c.error ? 300000 : NET_TTL)) return c.cur;
  if (memNow() > MEM_SOFT_MB) { if (global.gc) global.gc(); if (memNow() > MEM_SOFT_MB) return c?.cur || {}; }
  const ex = client(id); let cur = {};
  try {
    { if (id === 'binance') ex.options.fetchCurrencies = true;
      let all; try { all = await ex.fetchCurrencies() || {}; } finally { if (id === 'binance') ex.options.fetchCurrencies = false; }
      const keep = KEEP_COINS(); cur = {}; for (const k of Object.keys(all)) if (keep.has(k)) { const v = all[k]; delete v.info; for (const n of Object.values(v.networks || {})) delete n.info; cur[k] = v; }
      all = null; if (global.gc) global.gc(); }
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
// 1.15.1: taxas reais de levantamento por moeda/rede/corretora (só leitura) — base para calcular o custo de reequilíbrio
app.get('/api/withdraw-fees', wrap(async (req, res) => {
  const coins = String(req.query.coins || 'USDT,USDS').toUpperCase().split(',').map(x => x.trim()).filter(Boolean).slice(0, 6);
  const ids = EXCHANGES.filter(hasKeys), out = {};
  for (const id of ids) {
    let cur = {}; try { cur = await _networksOf(id); } catch (e) { out[id] = { error: e.message.slice(0, 120) }; continue; }
    out[id] = {};
    for (const c of coins) out[id][c] = Object.entries(cur[c]?.networks || {}).map(([k, v]) => ({ network: normNet(k), fee: typeof v.fee === 'number' ? v.fee : null, withdraw: v.withdraw !== false && v.active !== false, deposit: v.deposit !== false && v.active !== false, min: v.limits?.withdraw?.min ?? null }))
      .sort((a, b) => (a.fee ?? 1e9) - (b.fee ?? 1e9));
    if (global.gc) global.gc();
  }
  res.json({ ok: true, coins, fees: out });
}));
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
  const [bb, sb] = await Promise.all([bookOf(buyId, symbol), bookOf(sellId, symbol)]);
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
const AUTOBOT_DEFAULT = { enabled: false, useMaker: false, routeTypes: ['simultanea', 'transferencia'], amount: DEFAULT_AMOUNT, minProfitUsdt: 0, intervalSec: 45, cooldownSec: 120, symbols: [], exchanges: [] };
let autobot = { ...AUTOBOT_DEFAULT, ...readJSON(AUTOBOT_FILE, {}) };
const autoState = { running: false, lastScanAt: null, lastScanMs: null, lastBest: null, lastAction: null, lastError: null, trades: 0, simulated: 0, profitUsdt: 0, startedAt: null };
const routeCooldown = new Map();
let lastSharedScan = { at: 0, amount: 0, list: [] }; // última pesquisa do Autobot do dono, reutilizada pelos Autobots dos clientes
let autoTimer = null;

function sanitizeAutobot(c) {
  const o = { ...autobot };
  if (typeof c.enabled === 'boolean') o.enabled = c.enabled;
  if (typeof c.useMaker === 'boolean') o.useMaker = c.useMaker;
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


// ---------- 1.12.0: o Autobot aprende com o histórico ----------
// Para cada rota maker (moeda + compra → venda) conta tentativas e preenchimentos das últimas LEARN_HOURS horas.
// Rotas que falham sempre ficam em pausa; as que já preencheram ganham prioridade (lucro esperado = lucro × taxa de preenchimento).
const LEARN_HOURS = Number(process.env.LEARN_HOURS ?? 48), DEAD_MIN_TRIES = Number(process.env.DEAD_MIN_TRIES ?? 15), DEAD_PAUSE_H = Number(process.env.DEAD_PAUSE_H ?? 6);
const LOW_FILL_TRIES = Number(process.env.LOW_FILL_TRIES ?? 30), LOW_FILL_RATE = Number(process.env.LOW_FILL_RATE ?? 0.05);
const routeKey = (sym, b, s) => `${sym}|${b}|${s}`;
let learnCache = { at: 0, map: new Map() };
function routeLearning() {
  if (Date.now() - learnCache.at < 60000) return learnCache.map;
  const since = new Date(Date.now() - LEARN_HOURS * 3600000).toISOString(), map = new Map();
  for (const t of readJSON(HIST_FILE, [])) {
    if (t.at < since || t.type !== 'maker' || t.status === 'held') continue;
    const k = routeKey(t.symbol, t.buyExchange, t.sellExchange), r = map.get(k) || { tries: 0, fills: 0, profit: 0, lastFill: null, lastTry: null };
    r.tries++; if ((t.filled || 0) > 0) { r.fills++; r.profit += t.netProfit || 0; if (!r.lastFill || t.at > r.lastFill) r.lastFill = t.at; }
    if (!r.lastTry || t.at > r.lastTry) r.lastTry = t.at;
    map.set(k, r);
  }
  for (const r of map.values()) { r.fillRate = (r.fills + 1) / (r.tries + 2); r.dead = (r.tries >= DEAD_MIN_TRIES && r.fills === 0) || (r.tries >= LOW_FILL_TRIES && r.fills / r.tries < LOW_FILL_RATE); r.pausedUntil = r.dead ? new Date(Date.parse(r.lastTry) + DEAD_PAUSE_H * 3600000).toISOString() : null; if (r.dead && Date.now() > Date.parse(r.pausedUntil)) r.dead = false; }
  learnCache = { at: Date.now(), map };
  return map;
}
function stats24h() {
  const since = new Date(Date.now() - 86400000).toISOString(), st = { since, maker: { tries: 0, fills: 0, profit: 0 }, taker: { sims: 0, executed: 0, profit: 0 }, triangular: { sims: 0, profit: 0 }, transfer: { started: 0 }, held: 0, rebalance: { count: 0, cost: 0 }, ignoredNoKeys: 0 };
  for (const t of readJSON(HIST_FILE, [])) {
    if (t.at < since || t.source === 'client') continue;
    if (t.status === 'held') { st.held++; continue; }
    if (t.type === 'rebalance') { st.rebalance.count++; st.rebalance.cost += -(t.netProfit || 0); continue; }
    if ((t.buyExchange && !hasKeys(t.buyExchange)) || (t.sellExchange && !hasKeys(t.sellExchange))) { st.ignoredNoKeys++; continue; }
    if (t.type === 'maker') { st.maker.tries++; if ((t.filled || 0) > 0) { st.maker.fills++; st.maker.profit += t.netProfit || 0; } }
    else if (t.type === 'triangular') { if (t.status === 'dry_run' || t.status === 'executed') { st.triangular.sims++; st.triangular.profit += t.netProfit || 0; } }
    else if (t.type === 'transfer') st.transfer.started++;
    else if (t.status === 'dry_run') { st.taker.sims++; st.taker.profit += t.netProfit || 0; }
    else if (t.status === 'executed') { st.taker.executed++; st.taker.profit += t.netProfit || 0; }
  }
  for (const k of ['maker', 'taker', 'triangular']) st[k].profit = Math.round(st[k].profit * 10000) / 10000;
  st.rebalance.cost = Math.round(st.rebalance.cost * 10000) / 10000;
  st.totalProfit = Math.round((st.maker.profit + st.taker.profit + st.triangular.profit - st.rebalance.cost) * 10000) / 10000;
  return st;
}
function learningSummary() {
  return [...routeLearning().entries()].map(([k, r]) => ({ route: k.replace(/\|/g, ' '), tries: r.tries, fills: r.fills, fillRatePct: Math.round(r.fillRate * 1000) / 10, profit: Math.round(r.profit * 10000) / 10000, paused: r.dead, pausedUntil: r.dead ? r.pausedUntil : null }))
    .sort((a, b) => b.fills - a.fills || b.tries - a.tries).slice(0, 15);
}
// ---------- 1.14.0: simulação realista do Autobot do dono ----------
// 1) só corretoras com chaves (a Bybit sem chaves não conta); 2) a mesma rota repete quando há liquidez nova
// (1.15.0: repete quando o livro mostra liquidez nova); 3) inventário virtual: compra gasta USDT na corretora de compra e venda gasta a moeda
// na de venda; quando um lado acaba, simula o reequilíbrio com custo SIM_REBAL_FEE USDT por transferência.
const SIM_REFILL_SEC = Number(process.env.SIM_REFILL_SEC ?? 45), SIM_INV_OPS = Number(process.env.SIM_INV_OPS ?? 4), SIM_REBAL_FEE = Number(process.env.SIM_REBAL_FEE ?? 0.5);
const SIM_INV_FILE = path.join(DATA_DIR, 'sim-inventory.json');
let simInv = readJSON(SIM_INV_FILE, {});
const simRepeat = new Map(); // id -> { sig, at }: assinatura do livro na última simulação
// 1.15.0: sem pausa fixa — repete a rota logo que o livro mostrar liquidez nova (preço/quantidade mudou)
// ou, com o mesmo livro, depois de SIM_REFILL_SEC (tempo típico de reposição pelos market makers)
const bookSig = o => [o.buyPrice, o.sellPrice, o.buyLimit, o.sellLimit, o.preview?.maxAmount].map(x => Number(x || 0).toFixed(6)).join('|');
const simBlocked = (o, now) => { const r = simRepeat.get(o.id); return !!r && r.sig === bookSig(o) && now - r.at < SIM_REFILL_SEC * 1000; };
function simBal(ex, coin) { simInv[ex] = simInv[ex] || {}; if (simInv[ex][coin] == null) simInv[ex][coin] = SIM_INV_OPS * (autobot.amount || DEFAULT_AMOUNT); return simInv[ex][coin]; }
// devolve null se cabe; se não cabe, simula o reequilíbrio (custo) e devolve o registo
function simReserve(o, amt) {
  const [base, q] = o.symbol.split('/'), price = (o.preview.invest || amt) / Math.max(o.amount || amt, 1e-9), cost = amt * price;
  const need = [];
  if (simBal(o.buyExchange, q) < cost * 1.002) need.push({ coin: q, to: o.buyExchange, from: o.sellExchange });
  if (simBal(o.sellExchange, base) < amt) need.push({ coin: base, to: o.sellExchange, from: o.buyExchange });
  let fee = 0;
  for (const n of need) { const full = SIM_INV_OPS * autobot.amount; const moved = Math.max(full - simBal(n.to, n.coin), 0); simInv[n.from][n.coin] = Math.max(simBal(n.from, n.coin) - moved, 0); simInv[n.to][n.coin] = full; fee += SIM_REBAL_FEE; }
  return { fee, need };
}
function simApply(o, amt, netProfit) {
  const [base, q] = o.symbol.split('/'), price = (o.preview.invest || amt) / Math.max(o.amount || amt, 1e-9), cost = amt * price;
  simInv[o.buyExchange][q] = simBal(o.buyExchange, q) - cost; simInv[o.buyExchange][base] = simBal(o.buyExchange, base) + amt;
  simInv[o.sellExchange][base] = simBal(o.sellExchange, base) - amt; simInv[o.sellExchange][q] = simBal(o.sellExchange, q) + cost + (netProfit || 0);
  writeJSON(SIM_INV_FILE, simInv);
}
const TRANSFER_SCAN_MIN = Number(process.env.TRANSFER_SCAN_MIN ?? 15); let lastTransferScan = 0;
async function autobotTick() {
  if (!autobot.enabled || autoState.running) return;
  if (STOPPED) { autoState.lastAction = { at: new Date().toISOString(), status: 'paused', message: 'Botão de emergência ativo' }; return; }
  autoState.running = true; const t0 = Date.now();
  try {
    const types = autobot.routeTypes && autobot.routeTypes.length ? autobot.routeTypes : ['simultanea'];
    // em sequência (não em paralelo) e transferências só a cada TRANSFER_SCAN_MIN minutos — o Render Free tem 512 MB
    const p0 = types.includes('simultanea') ? await scanOpps(autobot.amount, false) : { opportunities: [] };
    if (global.gc) global.gc();
    const doT = types.includes('transferencia') && !memHigh() && Date.now() - lastTransferScan > TRANSFER_SCAN_MIN * 60000 && ![...transferJobs.values()].some(j => j.status === 'running');
    if (doT) lastTransferScan = Date.now();
    const p1 = doT ? await scanTransfers(autobot.amount, false) : { opportunities: [] };
    const p2 = TRI_ENABLED && autobot.triangular !== false && !memHigh() ? await scanTriangles(autobot.amount) : { opportunities: [] };
    const parts = [p0, p1];
    const score = o => Math.max(o.preview.maxNetProfit, autobot.useMaker && o.maker?.realistic ? o.maker.netProfit : 0);
    const data = { opportunities: parts[0].opportunities.concat(parts[1].opportunities).sort((x, y) => (score(y) - score(x)) || (y.netProfit - x.netProfit)) };
    autoState.lastScanAt = new Date().toISOString(); autoState.lastScanMs = Date.now() - t0;
    if (types.includes('simultanea')) lastSharedScan = { at: Date.now(), amount: autobot.amount, list: p0.opportunities };
    const now = Date.now();
    const cands = data.opportunities.filter(o =>
      (o.preview.meetsMin || (autobot.useMaker && o.type !== 'transfer' && o.maker?.realistic && o.maker.netPct >= MIN_PROFIT_PCT) || (o.preview.maxNetProfit > 0 && o.preview.maxAmount <= autobot.amount)) && Math.max(o.netProfit, o.preview.maxNetProfit) >= autobot.minProfitUsdt &&
      (!autobot.symbols.length || autobot.symbols.includes(o.symbol)) &&
      (!autobot.exchanges.length || (autobot.exchanges.includes(o.buyExchange) && autobot.exchanges.includes(o.sellExchange))) &&
      hasKeys(o.buyExchange) && hasKeys(o.sellExchange) &&
      !((routeCooldown.get(o.id) || 0) > now) && !simBlocked(o, now));
    autoState.lastBestTriangle = p2.opportunities[0] ? { id: p2.opportunities[0].id, netPct: p2.opportunities[0].netPct, netProfit: p2.opportunities[0].netProfit } : null;
    autoState.lastBest = data.opportunities[0] ? { id: data.opportunities[0].id, netPct: data.opportunities[0].netPct, netProfit: data.opportunities[0].netProfit, maxNetProfit: data.opportunities[0].preview.maxNetProfit } : null;
    // triangulares (mesma corretora): executa a melhor se passar o mínimo e for melhor do que a melhor rota entre corretoras
    const tri = p2.opportunities.find(o => o.meetsMin && o.netProfit >= autobot.minProfitUsdt && !((routeCooldown.get(o.id) || 0) > now) && !simBlocked(o, now) && hasKeys(o.exchange) && (!autobot.exchanges.length || autobot.exchanges.includes(o.exchange)));
    if (tri && (!cands.length || tri.netProfit >= Math.max(cands[0].netProfit, cands[0].preview.maxNetProfit))) {
      const r = await executeTriangle({ exchange: tri.exchange, path: tri.path, amount: autobot.amount, source: 'autobot' }); const b = r.body || {};
      routeCooldown.set(tri.id, Date.now() + autobot.cooldownSec * 1000);
      if (DRY_RUN) simRepeat.set(tri.id, { sig: bookSig(tri), at: Date.now() });
      autoState.lastAction = { at: new Date().toISOString(), route: tri.id, status: b.status, netProfit: b.netProfit ?? 0, message: b.message || b.error };
      if (b.status === 'dry_run') { autoState.simulated++; autoState.profitUsdt += b.netProfit || 0; }
      if (b.status === 'executed') { autoState.trades++; autoState.profitUsdt += b.netProfit || 0; }
      return;
    }
    if (!cands.length) { autoState.lastAction = { at: autoState.lastScanAt, status: 'waiting', message: 'Nenhuma rota acima do mínimo' }; return; }
    // 1.12.0: ordenar por lucro esperado real (maker × taxa de preenchimento aprendida) e saltar rotas maker mortas
    const learn = routeLearning();
    const isMk = o => autobot.useMaker && o.type !== 'transfer' && o.maker?.realistic && o.maker.netProfit > o.netProfit && o.maker.netPct >= MIN_PROFIT_PCT;
    const ev = o => { if (!isMk(o) || learn.get(routeKey(o.symbol, o.buyExchange, o.sellExchange))?.dead) return Math.max(o.netProfit, o.preview.maxNetProfit); const r = learn.get(routeKey(o.symbol, o.buyExchange, o.sellExchange)); return o.maker.netProfit * (r ? r.fillRate : 0.5); };
    const live = cands.filter(o => !(isMk(o) && !o.preview.meetsMin && learn.get(routeKey(o.symbol, o.buyExchange, o.sellExchange))?.dead)).sort((a, b) => ev(b) - ev(a));
    autoState.skippedDead = cands.length - live.length;
    if (!live.length) { autoState.lastAction = { at: autoState.lastScanAt, status: 'waiting', message: `Só rotas maker em pausa (falharam ${DEAD_MIN_TRIES}+ vezes sem preencher)` }; return; }
    for (const o of live.slice(0, 3)) {
      const args = { buyExchange: o.buyExchange, sellExchange: o.sellExchange, symbol: o.symbol, amount: o.preview.maxAmount > 0 ? Math.min(o.preview.maxAmount, autobot.amount) : autobot.amount, source: 'autobot' };
      // 1.13.0: se a rota normal (taker) já dá lucro garantido, só usa maker quando o lucro ESPERADO do maker (× taxa de preenchimento) for maior
      const lr = learn.get(routeKey(o.symbol, o.buyExchange, o.sellExchange));
      const takerOk = o.preview.meetsMin && Math.max(o.netProfit, o.preview.maxNetProfit) > 0;
      const useMk = isMk(o) && !(lr && lr.dead) && (!takerOk || o.maker.netProfit * (lr ? lr.fillRate : 0.5) > Math.max(o.netProfit, o.preview.maxNetProfit));
      if (!useMk && !takerOk) continue;   // nem maker viável nem taker com lucro: não gasta tentativa
      if (useMk) args.amount = autobot.amount;
      let rebal = null;
      if (DRY_RUN && !useMk && o.type !== 'transfer') { rebal = simReserve({ ...o, amount: o.amount || args.amount }, args.amount); }
      const r = o.type === 'transfer' ? await executeTransfer(args) : useMk ? await executeMaker(args) : await executeRoute(args);
      const b = r.body || {};
      autoState.lastAction = { at: new Date().toISOString(), route: o.id, status: b.status || (b.ok ? 'ok' : 'error'), netProfit: b.netProfit ?? 0, message: b.message || b.error };
      if (b.status === 'aborted' && /Saldo insuficiente/.test(b.message || '')) { routeCooldown.set(o.id, Date.now() + 10 * 60000); continue; }
      routeCooldown.set(o.id, Date.now() + autobot.cooldownSec * 1000);
      if (b.status === 'running') { autoState.trades++; break; }
      if (b.status === 'executed') { autoState.trades++; autoState.profitUsdt += b.netProfit || 0; }
      if (b.status === 'not_filled') { autoState.lastAction.message = b.message; break; }
      if (b.status === 'dry_run') {
        autoState.simulated++; autoState.profitUsdt += b.netProfit || 0;
        if (!useMk && o.type !== 'transfer') {
          simRepeat.set(o.id, { sig: bookSig(o), at: Date.now() });
          if (rebal && rebal.fee > 0) { record({ source: 'autobot', type: 'rebalance', status: 'dry_run', symbol: o.symbol, buyExchange: o.buyExchange, sellExchange: o.sellExchange, netProfit: -rebal.fee, moves: rebal.need, message: `Reequilíbrio simulado (${rebal.need.map(n => n.coin + '→' + n.to).join(', ')}) — custo ${rebal.fee} USDT` }); autoState.profitUsdt -= rebal.fee; }
          simApply({ ...o, amount: o.amount || args.amount }, b.amount || args.amount, b.netProfit);
        }
      }
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
  return { ok: true, dryRun: DRY_RUN, stopped: STOPPED, config: autobot, state: autoState, last24h: stats24h(), learning: learningSummary(),
    simulation: { repeatRule: 'repete quando o livro tem liquidez nova', refillSec: SIM_REFILL_SEC, inventoryOps: SIM_INV_OPS, rebalanceFeeUsdt: SIM_REBAL_FEE, inventory: simInv },
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


// ---------- VIGILANTE DE MEMÓRIA (1.9.4) ----------
// O Render Free mata a instância acima de 512 MB. A cada 20 s mede a memória:
//  > MEM_SOFT_MB: limpa caches e força GC; o Autobot salta o scan de transferências.
//  > MEM_HARD_MB: recria os clientes ccxt (liberta o que ficou preso dentro deles), fora de operações em curso.
//  > MEM_EXIT_MB: reinício controlado (melhor que ser morto a meio de um scan).
const MEM_SOFT_MB = Number(process.env.MEM_SOFT_MB ?? 330), MEM_HARD_MB = Number(process.env.MEM_HARD_MB ?? 400), MEM_EXIT_MB = Number(process.env.MEM_EXIT_MB ?? 470);
const memState = { rssMb: 0, heapMb: 0, peakMb: 0, cleanups: 0, recycles: 0, lastCleanupAt: null, lastRecycleAt: null };
const mb = n => Math.round(n / 1048576);
function memNow() { const m = process.memoryUsage(); memState.rssMb = mb(m.rss); memState.heapMb = mb(m.heapUsed); memState.peakMb = Math.max(memState.peakMb, memState.rssMb); return memState.rssMb; }
const memHigh = () => memNow() > MEM_SOFT_MB;
function busy() { return autoState.running || [...transferJobs.values()].some(j => j.status === 'running'); }
function memCleanup() {
  bookCache.clear();
  for (const [k, v] of routeCooldown) if (v < Date.now()) routeCooldown.delete(k);
  for (const [k, j] of transferJobs) if (j.status !== 'running' && transferJobs.size > 20) transferJobs.delete(k);
  if (global.gc) { global.gc(); global.gc(); }
  memState.cleanups++; memState.lastCleanupAt = new Date().toISOString();
}
function memRecycle() {
  for (const id of Object.keys(clients)) delete clients[id];
  for (const id of Object.keys(marketFail)) delete marketFail[id];
  memCleanup(); memState.recycles++; memState.lastRecycleAt = new Date().toISOString();
}
let memLastLog = 0;
setInterval(() => {
  let r = memNow();
  if (Date.now() - memLastLog > 5 * 60000) { memLastLog = Date.now(); console.log(`[mem] rss=${r}MB heap=${memState.heapMb}MB pico=${memState.peakMb}MB limpezas=${memState.cleanups} reciclagens=${memState.recycles}`); }
  if (r <= MEM_SOFT_MB) return;
  memCleanup(); r = memNow();
  if (r > MEM_HARD_MB && !busy()) { memRecycle(); r = memNow(); console.warn(`[mem] clientes ccxt recriados, rss=${r}MB`); }
  if (r > MEM_EXIT_MB && !busy()) { console.warn(`[mem] rss=${r}MB acima de ${MEM_EXIT_MB}MB — reinício controlado`); setTimeout(() => process.exit(0), 200); }
}, 5000).unref();
app.get('/api/memory', (req, res) => { memNow(); res.json({ ok: true, ...memState, softMb: MEM_SOFT_MB, hardMb: MEM_HARD_MB, exitMb: MEM_EXIT_MB }); });


// ---------- 1.9.7: pagamentos de planos em USDT (endereço de depósito da Binance) ----------
// Cada pedido recebe um valor único (ex.: 19,0347 USDT). O servidor lê o histórico de depósitos da Binance
// (só leitura, pela chave já ligada) e, quando chega um depósito com esse valor exato, ativa o plano e emite a licença.
// Pedidos e licenças ficam no Gist privado (jet7-payments.json): sobrevivem a reinícios e deploys.
const PAY_EXCHANGE = 'binance';
const PAY_COIN = 'USDT';
const PAY_NETWORK = (process.env.PAY_NETWORK || 'TRX').toUpperCase();          // TRX = TRC20
const PAY_NET_LABEL = { TRX: 'TRC20 (Tron)', BSC: 'BEP20 (BNB Smart Chain)', ETH: 'ERC20 (Ethereum)' }[PAY_NETWORK] || PAY_NETWORK;
const PAY_ORDER_MIN = Number(process.env.PAY_ORDER_MIN ?? 60);                   // minutos para pagar
const PAY_LATE_HOURS = 24;                                                       // ainda aceita depósito atrasado até 24 h
const PLANS = {
  teste:    { name: 'Teste',     price: 0,   days: 7 },
  manual:   { name: 'Manual',    price: Number(process.env.PRICE_MANUAL ?? 19),  days: 30 },
  pro:      { name: 'Pro',       price: Number(process.env.PRICE_PRO ?? 49),     days: 30 },
  proanual: { name: 'Pro Anual', price: Number(process.env.PRICE_PROANUAL ?? 399), days: 365 },
};
const GIST_PAY = 'jet7-payments.json';
let pay = { orders: [], licenses: [] }, payAddr = null, payState = { lastCheck: null, lastError: null, addressError: null }, paySaveTimer = null;
const r4 = x => Math.round(x * 10000) / 10000;
const nowIso = () => new Date().toISOString();
function savePay() {
  clearTimeout(paySaveTimer);
  paySaveTimer = setTimeout(async () => {
    if (!GH_TOKEN) return;
    try { await gh('/gists/' + await findOrCreateGist(), { method: 'PATCH', body: JSON.stringify({ files: { [GIST_PAY]: { content: JSON.stringify(pay) } } }) }); }
    catch (e) { console.warn('Gist pagamentos: ' + e.message); }
  }, 2000);
}
async function loadPay() {
  if (!GH_TOKEN) return;
  try {
    const g = await gh('/gists/' + await findOrCreateGist());
    const f = g.files && g.files[GIST_PAY];
    if (f && f.content) { const d = JSON.parse(f.content); pay = { orders: d.orders || [], licenses: d.licenses || [] }; console.log(`Pagamentos carregados: ${pay.orders.length} pedidos, ${pay.licenses.length} licenças`); }
  } catch (e) { console.warn('Gist pagamentos: ' + e.message); }
}
setTimeout(loadPay, 4000);
async function getPayAddress() {
  if (payAddr) return payAddr;
  if (process.env.PAY_ADDRESS) return (payAddr = { address: process.env.PAY_ADDRESS.trim(), tag: process.env.PAY_TAG || '' });
  if (!hasKeys(PAY_EXCHANGE)) throw new Error('Chave da Binance não ligada');
  try {
    const r = await client(PAY_EXCHANGE).sapiGetCapitalDepositAddress({ coin: PAY_COIN, network: PAY_NETWORK });
    if (!r || !r.address) throw new Error('A Binance não devolveu endereço');
    payAddr = { address: r.address, tag: r.tag || '' }; payState.addressError = null; return payAddr;
  } catch (e) { payState.addressError = e.message; throw e; }
}
function licKey() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.randomBytes(12);
  let s = ''; for (let i = 0; i < 12; i++) s += A[b[i] % A.length];
  return `J7-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
function issueLicense(order, info = {}) {
  // renova: se o mesmo email já tem licença ativa do mesmo plano, prolonga a partir do fim
  const now = Date.now();
  const active = pay.licenses.filter(l => l.email === order.email && new Date(l.expiresAt).getTime() > now && l.plan === order.plan).sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0];
  const start = active ? new Date(active.expiresAt).getTime() : now;
  const lic = { key: licKey(), plan: order.plan, planName: PLANS[order.plan].name, email: order.email, orderId: order.id, issuedAt: nowIso(), expiresAt: new Date(start + PLANS[order.plan].days * 86400000).toISOString(), ...info };
  pay.licenses.unshift(lic); order.license = lic.key; return lic;
}
const pubOrder = o => ({ id: o.id, plan: o.plan, planName: PLANS[o.plan]?.name, email: o.email, amount: o.amount, coin: PAY_COIN, network: PAY_NETWORK, networkLabel: PAY_NET_LABEL, address: o.address, tag: o.tag || '', status: o.status, createdAt: o.createdAt, expiresAt: o.expiresAt, paidAt: o.paidAt || null, txId: o.txId || null, license: o.status === 'paid' ? (pay.licenses.find(l => l.key === o.license) || null) : null });
function expireOrders() {
  const now = Date.now(); let ch = false;
  for (const o of pay.orders) if (o.status === 'pending' && now - new Date(o.createdAt).getTime() > PAY_LATE_HOURS * 3600000) { o.status = 'expired'; ch = true; }
  if (ch) savePay();
}
let payChecking = false;
async function checkPayments() {
  expireOrders();
  const pend = pay.orders.filter(o => o.status === 'pending');
  if (!pend.length || payChecking || !hasKeys(PAY_EXCHANGE)) return;
  payChecking = true;
  try {
    const since = Math.min(...pend.map(o => new Date(o.createdAt).getTime())) - 5 * 60000;
    const deps = await client(PAY_EXCHANGE).sapiGetCapitalDepositHisrec({ coin: PAY_COIN, startTime: since, limit: 1000 });
    const used = new Set(pay.orders.filter(o => o.txId).map(o => o.txId));
    for (const d of deps || []) {
      if (String(d.status) !== '1' && String(d.status) !== '6') continue;      // 1 = creditado, 6 = creditado mas sem levantamento ainda
      if (String(d.network || '').toUpperCase() !== PAY_NETWORK) continue;
      if (used.has(d.txId)) continue;
      const amt = r4(Number(d.amount)), t = Number(d.insertTime);
      const o = pend.find(x => x.status === 'pending' && x.amount === amt && t >= new Date(x.createdAt).getTime() - 2 * 60000);
      if (!o) continue;
      o.status = 'paid'; o.paidAt = new Date(t).toISOString(); o.txId = d.txId; used.add(d.txId);
      const lic = issueLicense(o);
      console.log(`PAGAMENTO recebido: ${o.amount} USDT, plano ${o.plan}, licença ${lic.key}`);
    }
    payState.lastCheck = nowIso(); payState.lastError = null; savePay();
  } catch (e) { payState.lastError = e.message; console.warn('Pagamentos: ' + e.message); }
  finally { payChecking = false; }
}
setInterval(checkPayments, 45000);

const okEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
app.get('/public/plans', (req, res) => res.json({ ok: true, coin: PAY_COIN, network: PAY_NETWORK, networkLabel: PAY_NET_LABEL, plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })) }));
app.post('/public/pay/create', async (req, res) => {
  try {
    const plan = String(req.body?.plan || '').toLowerCase(), email = String(req.body?.email || '').trim().toLowerCase();
    if (!PLANS[plan]) return res.status(400).json({ ok: false, error: 'Plano inválido' });
    if (!okEmail(email)) return res.status(400).json({ ok: false, error: 'Email inválido' });
    if (plan === 'teste') {
      if (pay.licenses.some(l => l.email === email && l.plan === 'teste')) return res.status(400).json({ ok: false, error: 'Este email já usou o teste grátis' });
      const o = { id: crypto.randomBytes(8).toString('hex'), plan, email, amount: 0, status: 'paid', createdAt: nowIso(), expiresAt: nowIso(), paidAt: nowIso() };
      pay.orders.unshift(o); issueLicense(o, { trial: true }); savePay();
      return res.json({ ok: true, order: pubOrder(o) });
    }
    expireOrders();
    const pend = pay.orders.filter(o => o.status === 'pending');
    const mine = pend.find(o => o.email === email && o.plan === plan && Date.now() < new Date(o.expiresAt).getTime());
    if (mine) return res.json({ ok: true, order: pubOrder(mine) });
    if (pend.length >= 200) return res.status(429).json({ ok: false, error: 'Demasiados pedidos em aberto. Tente mais tarde.' });
    const a = await getPayAddress();
    const taken = new Set(pend.map(o => o.amount));
    let amount = 0;
    for (let i = 0; i < 500 && (!amount || taken.has(amount)); i++) amount = r4(PLANS[plan].price + (1 + crypto.randomInt(998)) / 10000);
    const o = { id: crypto.randomBytes(8).toString('hex'), plan, email, amount, address: a.address, tag: a.tag, status: 'pending', createdAt: nowIso(), expiresAt: new Date(Date.now() + PAY_ORDER_MIN * 60000).toISOString() };
    pay.orders.unshift(o); pay.orders = pay.orders.slice(0, 2000); savePay();
    res.json({ ok: true, order: pubOrder(o) });
  } catch (e) { res.status(500).json({ ok: false, error: 'Pagamentos indisponíveis: ' + e.message }); }
});
let lastPokeAt = 0;
app.get('/public/pay/:id', async (req, res) => {
  const o = pay.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ ok: false, error: 'Pedido não encontrado' });
  if (o.status === 'pending' && Date.now() - lastPokeAt > 15000) { lastPokeAt = Date.now(); await checkPayments(); }
  res.json({ ok: true, order: pubOrder(o) });
});
app.get('/public/license/:key', (req, res) => {
  const l = pay.licenses.find(x => x.key === String(req.params.key).trim().toUpperCase());
  if (!l) return res.status(404).json({ ok: false, valid: false, error: 'Licença não encontrada' });
  const valid = !l.revoked && new Date(l.expiresAt).getTime() > Date.now();
  res.json({ ok: true, valid, key: l.key, plan: l.plan, planName: l.planName, expiresAt: l.expiresAt, revoked: !!l.revoked });
});
app.get('/api/payments', wrap(async (req, res) => {
  let address = payAddr?.address || null;
  if (!address) { try { address = (await getPayAddress()).address; } catch (e) {} }
  const paid = pay.orders.filter(o => o.status === 'paid' && o.amount > 0);
  res.json({ ok: true, address, network: PAY_NETWORK, ...payState, totals: { paidOrders: paid.length, usdt: r4(paid.reduce((s, o) => s + o.amount, 0)), activeLicenses: pay.licenses.filter(l => !l.revoked && new Date(l.expiresAt) > new Date()).length }, orders: pay.orders.slice(0, 100).map(pubOrder), licenses: pay.licenses.slice(0, 200) });
}));
// confirmação manual pelo admin (ex.: cliente enviou valor ligeiramente diferente)
app.post('/api/payments/:id/confirm', wrap(async (req, res) => {
  const o = pay.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ ok: false, error: 'Pedido não encontrado' });
  if (o.status === 'paid') return res.json({ ok: true, order: pubOrder(o) });
  o.status = 'paid'; o.paidAt = nowIso(); o.txId = req.body?.txId || 'manual'; issueLicense(o, { manual: true }); savePay();
  res.json({ ok: true, order: pubOrder(o) });
}));
app.post('/api/licenses/:key/revoke', wrap(async (req, res) => {
  const l = pay.licenses.find(x => x.key === req.params.key);
  if (!l) return res.status(404).json({ ok: false, error: 'Licença não encontrada' });
  l.revoked = true; savePay(); res.json({ ok: true });
}));

// ---------- 1.10.0: contas de cliente (multi-cliente) ----------
// Cada cliente cria conta (email + palavra-passe), guarda as SUAS chaves API (encriptadas com AES-256-GCM)
// e usa o mesmo motor do dono. O plano da licença decide o que pode fazer:
//   Teste: só simulação manual · Manual: execução manual · Pro/Pro Anual: execução manual + Autobot 24h.
// Enquanto DRY_RUN=true no servidor, tudo é simulação para toda a gente.
const GIST_USERS = 'jet7-users.json';
const FEATURES = {
  teste:    { manual: true, autobot: false, forceDry: true,  opsPerDay: 20,   maxOrder: 100 },
  manual:   { manual: true, autobot: false, forceDry: false, opsPerDay: 50,   maxOrder: 2000 },
  pro:      { manual: true, autobot: true,  forceDry: false, opsPerDay: 1e9,  maxOrder: 10000 },
  proanual: { manual: true, autobot: true,  forceDry: false, opsPerDay: 1e9,  maxOrder: 10000 },
};
const PLAN_RANK = { teste: 1, manual: 2, pro: 3, proanual: 4 };
const CLI_AUTOBOT_DEFAULT = { enabled: false, amount: DEFAULT_AMOUNT, minProfitUsdt: 0, cooldownSec: 120, symbols: [], exchanges: [] };
let users = [], usersSaveTimer = null;
const SESSION_KEY = crypto.createHash('sha256').update(MASTER_KEY + ':jet7-session').digest();
function saveUsers() {
  clearTimeout(usersSaveTimer);
  usersSaveTimer = setTimeout(async () => {
    if (!GH_TOKEN) return;
    try { await gh('/gists/' + await findOrCreateGist(), { method: 'PATCH', body: JSON.stringify({ files: { [GIST_USERS]: { content: JSON.stringify({ users }) } } }) }); }
    catch (e) { console.warn('Gist utilizadores: ' + e.message); }
  }, 2000);
}
async function loadUsers() {
  if (!GH_TOKEN) return;
  try {
    const g = await gh('/gists/' + await findOrCreateGist());
    const f = g.files && g.files[GIST_USERS];
    if (f && f.content) { users = JSON.parse(f.content).users || []; console.log(`Contas de cliente carregadas: ${users.length}`); }
  } catch (e) { console.warn('Gist utilizadores: ' + e.message); }
}
setTimeout(loadUsers, 6000);
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) { return 'scrypt$' + salt + '$' + crypto.scryptSync(pw, salt, 32).toString('hex'); }
function checkPw(pw, stored) {
  const [, salt, h] = String(stored).split('$'); if (!salt || !h) return false;
  const a = crypto.scryptSync(pw, salt, 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const b64u = b => Buffer.from(b).toString('base64url');
function signSession(u) {
  const body = b64u(JSON.stringify({ u: u.id, v: u.tv || 0, exp: Date.now() + 30 * 86400000 }));
  return 'c1.' + body + '.' + crypto.createHmac('sha256', SESSION_KEY).update(body).digest('base64url');
}
function readSession(tok) {
  const [p, body, sig] = String(tok || '').split('.');
  if (p !== 'c1' || !body || !sig) return null;
  const good = crypto.createHmac('sha256', SESSION_KEY).update(body).digest('base64url');
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try { const d = JSON.parse(Buffer.from(body, 'base64url').toString()); if (d.exp < Date.now()) return null; const u = users.find(x => x.id === d.u); return u && (u.tv || 0) === d.v && !u.disabled ? u : null; } catch { return null; }
}
function bestLicense(email) {
  const now = Date.now();
  return pay.licenses.filter(l => l.email === email && !l.revoked && new Date(l.expiresAt).getTime() > now)
    .sort((a, b) => (PLAN_RANK[b.plan] - PLAN_RANK[a.plan]) || b.expiresAt.localeCompare(a.expiresAt))[0] || null;
}
const featuresOf = u => { const l = bestLicense(u.email); return l ? { plan: l.plan, planName: l.planName, expiresAt: l.expiresAt, licenseKey: l.key, ...FEATURES[l.plan] } : null; };
const userKeys = u => Object.keys(u.keys || {});
const pubUser = u => { const f = featuresOf(u); return { id: u.id, email: u.email, createdAt: u.createdAt, exchanges: userKeys(u), license: f ? { plan: f.plan, planName: f.planName, expiresAt: f.expiresAt, key: f.licenseKey } : null, features: f ? { manual: f.manual, autobot: f.autobot, simulationOnly: f.forceDry || DRY_RUN, opsPerDay: f.opsPerDay >= 1e9 ? null : f.opsPerDay, maxOrder: f.maxOrder } : null, autobot: { enabled: !!u.autobot?.enabled } }; };

// limite de tentativas de login/registo por IP (10 em 10 min)
const loginHits = new Map();
function tooMany(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), now = Date.now();
  const h = (loginHits.get(ip) || []).filter(t => now - t < 600000); h.push(now); loginHits.set(ip, h);
  if (loginHits.size > 5000) loginHits.clear();
  return h.length > 10;
}
app.post('/public/account/register', (req, res) => {
  if (tooMany(req)) return res.status(429).json({ ok: false, error: 'Demasiadas tentativas. Espere 10 minutos.' });
  const email = String(req.body?.email || '').trim().toLowerCase(), pw = String(req.body?.password || '');
  if (!okEmail(email)) return res.status(400).json({ ok: false, error: 'Email inválido' });
  if (pw.length < 8) return res.status(400).json({ ok: false, error: 'A palavra-passe precisa de pelo menos 8 caracteres' });
  if (users.some(u => u.email === email)) return res.status(400).json({ ok: false, error: 'Já existe uma conta com este email. Entre com a palavra-passe.' });
  if (users.length >= 1000) return res.status(429).json({ ok: false, error: 'Limite de contas atingido' });
  const u = { id: crypto.randomBytes(8).toString('hex'), email, pass: hashPw(pw), createdAt: nowIso(), lastLoginAt: nowIso(), keys: {}, autobot: { ...CLI_AUTOBOT_DEFAULT }, hist: [] };
  users.push(u); saveUsers();
  res.json({ ok: true, token: signSession(u), account: pubUser(u) });
});
app.post('/public/account/login', (req, res) => {
  if (tooMany(req)) return res.status(429).json({ ok: false, error: 'Demasiadas tentativas. Espere 10 minutos.' });
  const email = String(req.body?.email || '').trim().toLowerCase(), pw = String(req.body?.password || '');
  const u = users.find(x => x.email === email);
  if (!u || !checkPw(pw, u.pass)) return res.status(401).json({ ok: false, error: 'Email ou palavra-passe errados' });
  if (u.disabled) return res.status(403).json({ ok: false, error: 'Conta suspensa. Contacte o suporte.' });
  u.lastLoginAt = nowIso(); saveUsers();
  res.json({ ok: true, token: signSession(u), account: pubUser(u) });
});

// tudo em /client exige sessão de cliente válida
app.use('/client', (req, res, next) => {
  const h = req.headers.authorization || '';
  const u = readSession(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!u) return res.status(401).json({ ok: false, error: 'Sessão inválida. Entre de novo.' });
  req.user = u; req.feat = featuresOf(u); next();
});
const needPlan = (req, res, what) => {
  if (!req.feat) { res.status(402).json({ ok: false, error: 'Precisa de um plano ativo. Escolha um plano na secção Planos.' }); return false; }
  if (what && !req.feat[what]) { res.status(403).json({ ok: false, error: what === 'autobot' ? 'O Autobot está incluído nos planos Pro e Pro Anual.' : 'O seu plano não inclui esta função.' }); return false; }
  return true;
};
app.get('/client/me', (req, res) => res.json({ ok: true, account: pubUser(req.user) }));
app.post('/client/password', (req, res) => {
  const { current, password } = req.body || {};
  if (!checkPw(String(current || ''), req.user.pass)) return res.status(400).json({ ok: false, error: 'Palavra-passe atual errada' });
  if (String(password || '').length < 8) return res.status(400).json({ ok: false, error: 'Mínimo 8 caracteres' });
  req.user.pass = hashPw(String(password)); req.user.tv = (req.user.tv || 0) + 1; saveUsers();
  res.json({ ok: true, token: signSession(req.user) });
});
// associar uma licença comprada com outro email
app.post('/client/link-license', (req, res) => {
  const l = pay.licenses.find(x => x.key === String(req.body?.key || '').trim().toUpperCase());
  if (!l) return res.status(404).json({ ok: false, error: 'Licença não encontrada' });
  if (l.email !== req.user.email && users.some(u => u.email === l.email)) return res.status(400).json({ ok: false, error: 'Esta licença pertence a outra conta' });
  l.email = req.user.email; savePay();
  res.json({ ok: true, account: pubUser(req.user) });
});

// clientes ccxt por cliente: poucos em memória ao mesmo tempo (Render Free) e com os mercados partilhados do dono
const userEx = new Map(); const USER_EX_MAX = 8;
function userClient(u, id) {
  const k = u.id + ':' + id; let ex = userEx.get(k);
  if (ex) { userEx.delete(k); userEx.set(k, ex); return ex; }
  if (!u.keys?.[id]) throw new Error('Sem chave da ' + id);
  ex = new ccxt[id]({ enableRateLimit: true, timeout: 15000, options: spotOpts(id), ...dec(u.keys[id]) });
  ex.loadMarkets = async () => { if (!ex.markets) ex.setMarkets(Object.values(await ensureMarkets(client(id)))); return ex.markets; };
  userEx.set(k, ex);
  while (userEx.size > USER_EX_MAX) userEx.delete(userEx.keys().next().value);
  return ex;
}
const dropUserEx = u => { for (const k of [...userEx.keys()]) if (k.startsWith(u.id + ':')) userEx.delete(k); };
function userRecord(u) { return t => { u.hist = [{ at: nowIso(), ...t }, ...(u.hist || [])].slice(0, 200); saveUsers(); }; }
const opsToday = u => { const d = new Date().toISOString().slice(0, 10); return (u.hist || []).filter(t => String(t.at).startsWith(d) && ['dry_run', 'executed', 'partial'].includes(t.status)).length; };
function userCtx(u, f) {
  return { getEx: id => userClient(u, id), hasKeys: id => !!u.keys?.[id], record: userRecord(u), forceDry: !!f.forceDry, maxOrder: Math.min(f.maxOrder, MAX_ORDER_QUOTE * 50),
    isStopped: () => !!u.stopped, onImbalance: () => { u.stopped = true; u.autobot.enabled = false; saveUsers(); } };
}

app.get('/client/health', (req, res) => {
  const u = req.user, f = req.feat;
  res.json({ ok: true, client: true, version: VERSION, dryRun: DRY_RUN || !!f?.forceDry, stopped: !!u.stopped, symbols: SYMBOLS, minProfitPct: MIN_PROFIT_PCT,
    maxOrderQuote: f ? f.maxOrder : 0, account: pubUser(u), autobot: { enabled: !!u.autobot?.enabled }, exchanges: EXCHANGES.map(id => ({ id, keys: !!u.keys?.[id] })) });
});
app.post('/client/keys', wrap(async (req, res) => {
  if (!needPlan(req, res)) return;
  const { exchange, apiKey, secret, password } = req.body || {};
  if (!EXCHANGES.includes(exchange)) return res.status(400).json({ ok: false, error: 'Corretora não suportada' });
  if (!apiKey || !secret) return res.status(400).json({ ok: false, error: 'API Key e Secret são obrigatórios' });
  const creds = { apiKey: String(apiKey).trim(), secret: String(secret).trim() }; if (password) creds.password = String(password).trim();
  const test = new ccxt[exchange]({ enableRateLimit: true, timeout: 15000, options: spotOpts(exchange), ...creds });
  test.loadMarkets = async () => { if (!test.markets) test.setMarkets(Object.values(await ensureMarkets(client(exchange)))); return test.markets; };
  try { await test.fetchBalance(); } catch (e) { return res.status(400).json({ ok: false, error: 'Chave recusada pela corretora: ' + e.message }); }
  req.user.keys = req.user.keys || {}; req.user.keys[exchange] = enc(creds); dropUserEx(req.user); saveUsers();
  res.json({ ok: true });
}));
app.delete('/client/keys/:exchange', (req, res) => { if (req.user.keys) delete req.user.keys[req.params.exchange]; dropUserEx(req.user); saveUsers(); res.json({ ok: true }); });
app.get('/client/balances', wrap(async (req, res) => {
  if (!needPlan(req, res)) return;
  const out = [];
  for (const id of userKeys(req.user)) {   // uma de cada vez: poupa memória
    try { const b = await userClient(req.user, id).fetchBalance(); const o = { exchange: id }; for (const c of COINS) o[c] = b.total[c] ?? 0; out.push(o); }
    catch (e) { out.push({ exchange: id, error: e.message }); }
  }
  res.json({ ok: true, balances: out });
}));
// oportunidades e previsões usam só dados públicos de mercado (partilhados com o dono)
app.get('/client/opportunities', wrap(async (req, res) => {
  if (!needPlan(req, res)) return;
  const amount = Math.min(Number(req.query.amount) || DEFAULT_AMOUNT, req.feat.maxOrder);
  const key = amount + '|';
  if (oppCache.key === key && oppCache.data && Date.now() - oppCache.at < 8000) return res.json(oppCache.data);
  if (oppCache.pending) return res.json(await oppCache.pending);
  oppCache.key = key; oppCache.pending = scanOpps(amount, false);
  try { oppCache.data = await oppCache.pending; oppCache.at = Date.now(); } finally { oppCache.pending = null; }
  res.json(oppCache.data);
}));
app.get('/client/preview', wrap(async (req, res) => {
  if (!needPlan(req, res)) return;
  const { buy, sell, symbol } = req.query; const amount = Math.min(Number(req.query.amount) || DEFAULT_AMOUNT, req.feat.maxOrder);
  if (!EXCHANGES.includes(buy) || !EXCHANGES.includes(sell) || buy === sell) return res.status(400).json({ ok: false, error: 'Corretoras inválidas' });
  if (!SYMBOLS.includes(symbol)) return res.status(400).json({ ok: false, error: 'Par não permitido' });
  const q = await quote(buy, sell, symbol, amount);
  if (!q) return res.json({ ok: true, available: false, message: 'Livro sem profundidade suficiente para esta quantidade' });
  const p = q.preview, c = q.quote;
  res.json({ ok: true, available: true, ...q, dryRun: DRY_RUN || req.feat.forceDry,
    message: `Previsão: investe ${p.invest.toFixed(4)} ${c}, recebe ${p.revenue.toFixed(4)} ${c}, taxas ${p.feesTotal.toFixed(4)} ${c} → lucro líquido ${p.netProfit.toFixed(4)} ${c} (${p.netPct.toFixed(3)}%). ` + (p.meetsMin ? 'Passa o mínimo.' : `Abaixo do mínimo de ${MIN_PROFIT_PCT}% — não executaria.`) });
}));
app.post('/client/execute', wrap(async (req, res) => {
  if (!needPlan(req, res, 'manual')) return;
  if (opsToday(req.user) >= req.feat.opsPerDay) return res.status(429).json({ ok: false, error: `Limite do plano: ${req.feat.opsPerDay} operações por dia` });
  const r = await executeRoute({ ...(req.body || {}), source: 'manual', ...userCtx(req.user, req.feat) });
  res.status(r.code).json(r.body);
}));
app.get('/client/history', (req, res) => res.json({ ok: true, trades: (req.user.hist || []).slice(0, 200) }));
app.post('/client/stop', (req, res) => { req.user.stopped = true; req.user.autobot.enabled = false; saveUsers(); res.json({ ok: true, stopped: true }); });
app.post('/client/resume', (req, res) => { req.user.stopped = false; saveUsers(); res.json({ ok: true, stopped: false }); });

// Autobot por cliente: reutiliza a pesquisa de mercado mais recente (não multiplica o trabalho por cliente)
const cliState = new Map(); // id -> { lastAction, simulated, trades, profitUsdt, startedAt, cooldown: Map }
const stOf = u => { let s = cliState.get(u.id); if (!s) { s = { lastAction: null, lastScanAt: null, simulated: 0, trades: 0, profitUsdt: 0, startedAt: null, cooldown: new Map() }; cliState.set(u.id, s); } return s; };
function cliAutobotStatus(u) {
  const s = stOf(u), f = featuresOf(u);
  return { ok: true, dryRun: DRY_RUN || !!f?.forceDry, stopped: !!u.stopped, config: { ...CLI_AUTOBOT_DEFAULT, ...u.autobot, useMaker: false, routeTypes: ['simultanea'], intervalSec: 60 },
    state: { running: false, lastScanAt: s.lastScanAt, lastAction: s.lastAction, simulated: s.simulated, trades: s.trades, profitUsdt: s.profitUsdt, startedAt: s.startedAt },
    message: u.autobot?.enabled ? ((DRY_RUN || f?.forceDry) ? 'Autobot ligado em SIMULAÇÃO: nenhuma ordem real é enviada' : 'Autobot ligado em MODO REAL') : 'Autobot desligado' };
}
app.get('/client/autobot', (req, res) => res.json(cliAutobotStatus(req.user)));
app.post('/client/autobot', (req, res) => {
  const c = req.body || {}, u = req.user, a = { ...CLI_AUTOBOT_DEFAULT, ...u.autobot };
  if (c.enabled === true && !needPlan(req, res, 'autobot')) return;
  const max = req.feat ? req.feat.maxOrder : DEFAULT_AMOUNT;
  if (typeof c.enabled === 'boolean') { if (c.enabled && !a.enabled) Object.assign(stOf(u), { startedAt: nowIso(), simulated: 0, trades: 0, profitUsdt: 0 }); a.enabled = c.enabled; }
  if (c.amount != null) a.amount = Math.min(Math.max(Number(c.amount) || DEFAULT_AMOUNT, 1), max);
  if (c.minProfitUsdt != null) a.minProfitUsdt = Math.max(Number(c.minProfitUsdt) || 0, 0);
  if (c.cooldownSec != null) a.cooldownSec = Math.min(Math.max(Number(c.cooldownSec) || 0, 30), 86400);
  if (Array.isArray(c.symbols)) a.symbols = c.symbols.filter(x => SYMBOLS.includes(x));
  if (Array.isArray(c.exchanges)) a.exchanges = c.exchanges.filter(x => EXCHANGES.includes(x));
  u.autobot = a; saveUsers(); res.json(cliAutobotStatus(u));
});
let cliTickRunning = false;
async function clientAutobotTick() {
  const active = users.filter(u => u.autobot?.enabled && !u.disabled && !u.stopped);
  if (!active.length || cliTickRunning || STOPPED || memHigh()) return;
  cliTickRunning = true;
  try {
    // pesquisa partilhada: usa a do Autobot do dono se tiver menos de 2 min; senão faz uma
    if (Date.now() - lastSharedScan.at > 120000) { const r = await scanOpps(DEFAULT_AMOUNT, false); lastSharedScan = { at: Date.now(), amount: DEFAULT_AMOUNT, list: r.opportunities }; }
    const now = Date.now();
    for (const u of active) {
      const f = featuresOf(u), s = stOf(u), a = u.autobot;
      s.lastScanAt = new Date(lastSharedScan.at).toISOString();
      if (!f || !f.autobot) { a.enabled = false; s.lastAction = { at: nowIso(), status: 'paused', message: 'Plano sem Autobot ou expirado' }; saveUsers(); continue; }
      const dry = DRY_RUN || f.forceDry;
      const cands = lastSharedScan.list.filter(o => o.type !== 'transfer' && o.preview?.meetsMin && Math.max(o.netProfit, o.preview.maxNetProfit) >= a.minProfitUsdt &&
        (!a.symbols.length || a.symbols.includes(o.symbol)) && (!a.exchanges.length || (a.exchanges.includes(o.buyExchange) && a.exchanges.includes(o.sellExchange))) &&
        (dry || (u.keys?.[o.buyExchange] && u.keys?.[o.sellExchange])) && !((s.cooldown.get(o.id) || 0) > now));
      if (!cands.length) { s.lastAction = { at: nowIso(), status: 'waiting', message: 'Nenhuma rota acima do mínimo' }; continue; }
      const o = cands[0];
      const r = await executeRoute({ buyExchange: o.buyExchange, sellExchange: o.sellExchange, symbol: o.symbol, amount: Math.min(o.preview.maxAmount > 0 ? o.preview.maxAmount : a.amount, a.amount), source: 'autobot', ...userCtx(u, f) });
      const b = r.body || {};
      s.cooldown.set(o.id, Date.now() + (/Saldo insuficiente/.test(b.message || '') ? 600 : a.cooldownSec) * 1000);
      s.lastAction = { at: nowIso(), route: o.id, status: b.status || (b.ok ? 'ok' : 'error'), netProfit: b.netProfit ?? 0, message: b.message || b.error };
      if (b.status === 'dry_run') { s.simulated++; s.profitUsdt += b.netProfit || 0; }
      if (b.status === 'executed') { s.trades++; s.profitUsdt += b.netProfit || 0; }
    }
  } catch (e) { console.warn('Autobot clientes: ' + e.message); }
  finally { cliTickRunning = false; }
}
setInterval(clientAutobotTick, 60000);

// admin (dono): lista de clientes, sem chaves nem palavras-passe
app.get('/api/users', (req, res) => res.json({ ok: true, users: users.map(u => ({ ...pubUser(u), lastLoginAt: u.lastLoginAt, disabled: !!u.disabled, stopped: !!u.stopped, opsToday: opsToday(u), lastAction: stOf(u).lastAction, profitSimUsdt: (u.hist || []).filter(t => t.status === 'dry_run').reduce((x, t) => x + (t.netProfit || 0), 0) })) }));
app.post('/api/users/:id/disable', (req, res) => { const u = users.find(x => x.id === req.params.id); if (!u) return res.status(404).json({ ok: false, error: 'Não encontrado' }); u.disabled = req.body?.disabled !== false; if (u.disabled) { u.autobot.enabled = false; u.tv = (u.tv || 0) + 1; } saveUsers(); res.json({ ok: true, disabled: u.disabled }); });
app.get('/', (req, res) => res.type('text').send('JET7 server ' + VERSION));
app.listen(PORT, () => console.log(`JET7 server ${VERSION} na porta ${PORT} — DRY_RUN=${DRY_RUN}`));
// manter acordado no Render Free (adormece após 15 min sem visitas): ping ao próprio endereço público a cada 10 min
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) setInterval(() => fetch(SELF_URL + '/').catch(() => {}), 10 * 60000);

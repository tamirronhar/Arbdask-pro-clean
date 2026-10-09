"""ArbDask application package."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from datetime import datetime, timezone
import json, threading, uuid

APP_NAME = "ArbDask PRO"
MODE = "SIMULATION_ONLY"
LOCK = threading.Lock()
HISTORY = []
# Dados fictícios, nunca apresentados como preços reais.
DEMO_MARKETS = [
    {"asset":"USDT/USDC","buy_exchange":"Binance (demo)","sell_exchange":"OKX (demo)","buy_price":0.9992,"sell_price":1.0001,"fees_pct":0.12,"slippage_pct":0.03},
    {"asset":"USDC/USDT","buy_exchange":"Bitget (demo)","sell_exchange":"Bybit (demo)","buy_price":0.9996,"sell_price":1.0000,"fees_pct":0.12,"slippage_pct":0.03},
    {"asset":"USDT/BRL","buy_exchange":"Bybit (demo)","sell_exchange":"Binance (demo)","buy_price":5.4100,"sell_price":5.4380,"fees_pct":0.15,"slippage_pct":0.05},
]

def opportunities(capital=100.0, min_margin_pct=0.20):
    rows=[]
    for market in DEMO_MARKETS:
        gross=((market["sell_price"]-market["buy_price"])/market["buy_price"])*100
        net=gross-market["fees_pct"]-market["slippage_pct"]
        rows.append({**market,"gross_pct":round(gross,4),"net_pct":round(net,4),
                     "estimated_profit":round(float(capital)*net/100,4),
                     "passes_margin":net>=float(min_margin_pct),
                     "data_type":"DEMO — cotação fictícia"})
    return rows

def simulate(payload):
    capital=float(payload.get("capital",100))
    margin=float(payload.get("min_margin_pct",0.20))
    if not 1 <= capital <= 1_000_000:
        raise ValueError("O capital deve estar entre 1 e 1.000.000.")
    if not 0 <= margin <= 100:
        raise ValueError("A margem mínima deve estar entre 0 e 100%.")
    candidates=[row for row in opportunities(capital,margin) if row["passes_margin"]]
    selected=max(candidates,key=lambda row:row["net_pct"]) if candidates else None
    record={"id":str(uuid.uuid4())[:8],"created_at":datetime.now(timezone.utc).isoformat(timespec="seconds"),
      "mode":"SIMULAÇÃO","status":"SIMULATED" if selected else "NO_OPPORTUNITY","capital":capital,
      "min_margin_pct":margin,"asset":selected["asset"] if selected else None,
      "buy_exchange":selected["buy_exchange"] if selected else None,
      "sell_exchange":selected["sell_exchange"] if selected else None,
      "net_pct":selected["net_pct"] if selected else 0,
      "estimated_profit":selected["estimated_profit"] if selected else 0,
      "message":"Demonstração: nenhuma ordem, transferência ou levantamento foi executado."}
    with LOCK:
        HISTORY.insert(0,record)
        del HISTORY[100:]
    return record

DASHBOARD = r"""<!doctype html>
<html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ArbDask PRO — Monitorização e Simulação</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2e;--line:#25324e;--txt:#edf3ff;--muted:#9eacc7;--blue:#5b8cff;--green:#38d9a9;--amber:#ffc857}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px system-ui,Arial,sans-serif}
header{padding:22px clamp(16px,4vw,42px);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.brand{font-size:22px;font-weight:800}.brand span{color:var(--blue)}.sub,.small{color:var(--muted);font-size:12px;margin-top:4px}.pill{border:1px solid #5b8cff66;color:#b8ccff;background:#5b8cff18;padding:8px 12px;border-radius:30px;font-size:12px;font-weight:700}
main{max-width:1400px;margin:auto;padding:24px clamp(14px,3vw,32px) 48px}.warning{border:1px solid #ffc85766;background:#ffc85712;color:#ffe3a1;padding:13px 16px;border-radius:12px;margin-bottom:20px;line-height:1.5}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:22px}.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;min-width:0}
.label{font-size:12px;color:var(--muted)}.value{font-size:25px;font-weight:750;margin-top:8px;overflow-wrap:anywhere}.layout{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr);gap:18px}
h2{font-size:17px;margin:0 0 15px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:610px}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid var(--line);font-size:13px}th{color:var(--muted);font-weight:600}.good{color:var(--green)}.bad{color:var(--amber)}
form{display:grid;gap:13px}label{display:grid;gap:7px;font-size:13px;color:var(--muted)}input{width:100%;padding:12px;border-radius:9px;border:1px solid var(--line);background:#0b1223;color:var(--txt);font:inherit}
button{border:0;border-radius:10px;background:var(--blue);color:white;font-weight:750;padding:13px 16px;font:inherit;cursor:pointer}.secondary{background:#202c45;margin-top:8px}.notice{margin-top:12px;font-size:12px;color:var(--muted);line-height:1.5}
.history{margin-top:18px}.empty{color:var(--muted);padding:16px 0;font-size:13px}.histrow{padding:12px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:12px;font-size:13px}.histrow small{display:block;color:var(--muted);margin-top:4px}footer{text-align:center;color:var(--muted);font-size:12px;padding:20px}
@media(max-width:900px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.layout{grid-template-columns:1fr}}@media(max-width:420px){.value{font-size:21px}.card{padding:14px}}
</style></head><body>
<header><div><div class="brand">ArbDask <span>PRO</span></div><div class="sub">Inteligência de arbitragem · Painel de demonstração</div></div><div class="pill">● MODO SIMULAÇÃO</div></header>
<main><div class="warning"><strong>Ambiente de teste:</strong> os preços são fictícios, não são cotações em tempo real. Não são enviadas ordens nem transferências.</div>
<section class="stats">
<div class="card"><div class="label">Estado do sistema</div><div class="value good">Operacional</div><div class="small">Demonstração local</div></div>
<div class="card"><div class="label">Mercados demonstrativos</div><div class="value" id="market-count">—</div><div class="small">USDT · USDC · BRL</div></div>
<div class="card"><div class="label">Oportunidades elegíveis</div><div class="value" id="qualified">—</div><div class="small">Após custos estimados</div></div>
<div class="card"><div class="label">Simulações realizadas</div><div class="value" id="runs">0</div><div class="small">Histórico desta sessão</div></div></section>
<div class="layout"><section class="card"><h2>Oportunidades de demonstração</h2><div class="table-wrap"><table><thead><tr><th>Par</th><th>Comprar em</th><th>Vender em</th><th>Margem líquida</th><th>Estado</th></tr></thead><tbody id="opps"><tr><td colspan="5">A carregar…</td></tr></tbody></table></div><div class="notice">Taxas e slippage também são fictícios. Margem estimada não é lucro garantido.</div></section>
<aside class="card"><h2>Executar simulação</h2><form id="sim-form"><label>Capital de teste<input id="capital" type="number" min="1" max="1000000" step="1" value="100" required></label><label>Margem líquida mínima (%)<input id="margin" type="number" min="0" max="100" step="0.05" value="0.20" required></label><button type="submit">Simular melhor oportunidade</button></form><div id="sim-result" class="notice">A simulação não movimenta fundos.</div><button class="secondary" id="refresh" type="button">Atualizar painel</button></aside></div>
<section class="card history"><h2>Histórico de simulações</h2><div id="history" class="empty">Ainda não existem simulações.</div></section></main>
<footer>ArbDask PRO · Base limpa · Simulação apenas · Sem execução real</footer>
<script>
async function refresh(){const [o,h]=await Promise.all([fetch('/api/opportunities').then(r=>r.json()),fetch('/api/history').then(r=>r.json())]);document.getElementById('market-count').textContent=o.length;document.getElementById('qualified').textContent=o.filter(x=>x.net_pct>=Number(document.getElementById('margin').value||0)).length;document.getElementById('opps').innerHTML=o.map(x=>`<tr><td><strong>${x.asset}</strong><br><span class="small">${x.data_type}</span></td><td>${x.buy_exchange}<br>${x.buy_price}</td><td>${x.sell_exchange}<br>${x.sell_price}</td><td class="${x.net_pct>0?'good':'bad'}">${x.net_pct.toFixed(3)}%</td><td>${x.net_pct>=Number(document.getElementById('margin').value||0)?'<span class="good">Elegível*</span>':'<span class="bad">Abaixo da margem</span>'}</td></tr>`).join('');document.getElementById('runs').textContent=h.length;document.getElementById('history').innerHTML=h.length?h.map(x=>`<div class="histrow"><div><strong>${x.asset||'Sem oportunidade elegível'}</strong><small>${x.created_at} · ${x.status} · ${x.message}</small></div><div class="${x.estimated_profit>0?'good':'bad'}">${Number(x.estimated_profit).toFixed(4)}<small>${Number(x.net_pct).toFixed(3)}%</small></div></div>`).join(''):'Ainda não existem simulações.'}
document.getElementById('sim-form').addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/api/simulate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({capital:Number(document.getElementById('capital').value),min_margin_pct:Number(document.getElementById('margin').value)})});const d=await r.json();document.getElementById('sim-result').textContent=r.ok?`${d.status}: ${d.asset||'sem oportunidade elegível'} · lucro estimado ${Number(d.estimated_profit).toFixed(4)}. Nenhuma ordem foi executada.`:d.error;await refresh()});document.getElementById('refresh').addEventListener('click',refresh);document.getElementById('margin').addEventListener('change',refresh);refresh();
</script></body></html>"""

class Handler(BaseHTTPRequestHandler):
    def send_data(self,status,body,content_type="application/json; charset=utf-8"):
        data=body.encode("utf-8") if isinstance(body,str) else json.dumps(body,ensure_ascii=False).encode("utf-8")
        self.send_response(status); self.send_header("Content-Type",content_type); self.send_header("Content-Length",str(len(data)))
        self.send_header("X-Content-Type-Options","nosniff"); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        path=urlparse(self.path).path
        if path=="/": self.send_data(200,DASHBOARD,"text/html; charset=utf-8")
        elif path=="/api/status": self.send_data(200,{"app":APP_NAME,"mode":MODE,"execution_enabled":False})
        elif path=="/api/opportunities": self.send_data(200,opportunities())
        elif path=="/api/history":
            with LOCK: self.send_data(200,list(HISTORY))
        else: self.send_data(404,{"error":"Endpoint não encontrado."})
    def do_POST(self):
        if urlparse(self.path).path!="/api/simulate": self.send_data(404,{"error":"Endpoint não encontrado."}); return
        try:
            length=int(self.headers.get("Content-Length","0"))
            if length<1 or length>10000: raise ValueError("Pedido vazio ou demasiado grande.")
            payload=json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload,dict): raise ValueError("O corpo deve ser um objeto JSON.")
            self.send_data(200,simulate(payload))
        except (ValueError,TypeError,json.JSONDecodeError) as exc: self.send_data(400,{"error":str(exc)})
    def log_message(self,fmt,*args): print("%s - %s"%(self.address_string(),fmt%args))

def main():
    host,port="127.0.0.1",8000
    print(f"{APP_NAME} — simulação apenas — http://{host}:{port}")
    ThreadingHTTPServer((host,port),Handler).serve_forever()
if __name__=="__main__": main()

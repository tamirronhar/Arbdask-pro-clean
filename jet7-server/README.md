# Servidor JET7 — Modo Real

Este servidor liga o Modo Real da página JET7 às corretoras. As chaves API ficam encriptadas aqui, nunca no telemóvel.

Como funciona: o saldo fica em cada corretora (por exemplo, USDT na KuCoin e USDC na Gate). Só pares entre stablecoins, sem moeda local, por isso funciona a partir de Angola. Quando o preço difere, o servidor compra numa e vende na outra ao mesmo tempo. Não há saques entre corretoras.

## Proteção anti-perda
- Antes de cada ordem, recalcula com o livro de ofertas atual, incluindo taxas e slippage.
- Só envia ordens se o lucro líquido for ≥ MIN_PROFIT_PCT. Caso contrário, tenta 3 vezes e depois desiste sem operar.
- As ordens são LIMIT IOC no preço recalculado, por isso nunca executam a um preço pior.
- Limite por operação: MAX_ORDER_QUOTE. Botão de emergência: POST /api/stop.
- Risco que fica: se uma das duas ordens falhar, fica uma perna aberta e é preciso reequilibrar à mão. O servidor avisa quando isso acontece.

## Pôr a correr (Render, grátis para testar)
1. Crie uma conta no GitHub e envie esta pasta para um repositório privado.
2. Em render.com: New → Web Service → escolha o repositório. **Região: Frankfurt (EU)**, porque a Binance e a Bybit bloqueiam servidores nos EUA. Build: `npm install`. Start: `npm start`.
3. Localmente ou no Shell do Render, corra `npm run gerar-chaves` e copie ACCESS_TOKEN e MASTER_KEY para as Environment Variables. Copie também as restantes variáveis do `.env.example`.
4. Abra o JET7 → REAL → cole o URL do Render e o ACCESS_TOKEN → Testar ligação.
5. Guarde as chaves de cada corretora no painel.

Nota: no plano grátis do Render o disco não é permanente, por isso as chaves e o histórico perdem-se quando o servidor reinicia. Para uso a sério, use uma VPS ou adicione um disco persistente.

## Chaves API nas corretoras
- Ative apenas **Leitura + Trading Spot**. **Nunca ative saques.**
- Restrinja a chave ao IP do servidor, se a corretora permitir.
- KuCoin e Bitget pedem também a Passphrase.

## Passar a ordens reais
1. Deixe correr alguns dias com DRY_RUN=true e veja no Histórico se os lucros simulados se confirmam.
2. Mude DRY_RUN=false com MAX_ORDER_QUOTE baixo (ex.: 50).
3. Só depois aumente os valores.

## API (todas com cabeçalho `Authorization: Bearer ACCESS_TOKEN`)
GET /api/health · POST /api/keys · DELETE /api/keys/:exchange · GET /api/balances · GET /api/opportunities?amount=50 · POST /api/execute · POST /api/stop · POST /api/resume · GET /api/history

## Notas
- A página publicada em https (Netlify) só consegue falar com um servidor https. O Render já dá https.
- "Sem oportunidades no servidor agora" é normal: significa que nenhuma rota tem lucro líquido depois das taxas. A proteção está a fazer o seu trabalho.
- Depois da paragem de emergência, carregue em "Testar ligação" para retomar.
- Se uma ordem executar só de um lado, o servidor pára sozinho até reequilibrar os saldos.

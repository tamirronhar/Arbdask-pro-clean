# ArbDask PRO — Clean Starter

Base limpa para a primeira versão: **monitorização demonstrativa e simulação**, sem execução financeira real.

## Incluído
- Dashboard responsivo para telemóvel e computador.
- Mercados demonstrativos relacionados com USDT, USDC e BRL.
- Cálculo estimado de margem líquida após taxas e slippage demonstrativos.
- Capital e margem mínima configuráveis.
- Simulação e histórico da sessão.
- API: `/api/status`, `/api/opportunities`, `/api/history`, `POST /api/simulate`.
- Testes automáticos e GitHub Actions.
- Sem credenciais, assinatura de carteira, ordens, levantamentos ou transferências reais.

## Limitação importante
Os preços neste pacote são **fictícios e identificados como DEMO**. Ainda não existe ligação a cotações reais de Binance, Bitget, Bybit e OKX. Não use estes resultados para decisões financeiras. Esta é uma base limpa funcional, não uma plataforma pronta para clientes pagantes.

## Executar e testar
Requer Python 3.10+; sem dependências externas.

```bash
python app.py
```
Abra `http://127.0.0.1:8000`.

```bash
python -m unittest discover -s tests -v
```

## Colocar no GitHub pelo Android
1. Crie um repositório novo, por exemplo `ArbDask-PRO-Clean`.
2. Não copie os ficheiros do repositório antigo.
3. Extraia este ZIP e carregue os ficheiros e pastas para a raiz do repositório.
4. Confirme que `.github/workflows/tests.yml` está no caminho correto.
5. Abra **Actions** e consulte `ArbDask PRO clean tests`. Só considere a etapa concluída quando o workflow terminar a verde.

## Próximas etapas antes de lançar
1. Integrar feeds públicos de preços em modo leitura para Binance, Bitget, Bybit e OKX.
2. Adicionar timestamps, controlo de cotações desatualizadas, normalização dos pares e limites de API.
3. Aumentar os testes de integração e segurança.
4. Rever privacidade, termos, monitorização operacional e modelo de assinatura.

**Não ativar execução real** sem revisão independente e testes em ambientes de demonstração das exchanges.

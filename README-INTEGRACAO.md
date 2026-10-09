# ArbDask PRO — módulo de cotações públicas (fase de integração)

Este pacote acrescenta uma camada **somente de leitura** para obter bid/ask públicos de Binance, Bitget, Bybit e OKX, com timestamp, idade da cotação, isolamento de falhas e comparação estimada.

## Segurança
- Não usa chaves/API secrets.
- Não liga contas de utilizador.
- Não coloca ordens, não transfere ativos e não levanta fundos.
- O preço público de topo do livro não garante liquidez nem preço executável.
- Custos de taxas e slippage são parâmetros estimados; precisam de configuração por corretora/mercado antes de qualquer avaliação real.

## Conteúdo
- `market_data.py`: camada independente de leitura e comparação.
- `tests/test_market_data.py`: testes unitários offline, sem acesso à internet.

## Testar
Copie `market_data.py` para a raiz do repositório e `tests/test_market_data.py` para a pasta `tests/`. Execute:

```bash
python -m unittest discover -s tests -v
```

## Integração seguinte com `app.py`
Esta camada foi mantida separada para não substituir nem quebrar a dashboard já aprovada. Depois de os testes passarem, a integração deve adicionar um endpoint separado (por exemplo, `GET /api/market-data`) que chama `collect_quotes()` e `compare_quotes()`, com timeout, limite de chamadas e estado explícito `LIVE_READ_ONLY`. O endpoint não deve alterar o endpoint atual `/api/opportunities` até a interface estar preparada para distinguir dados DEMO de dados públicos.

## Limitações conhecidas
- Nem todos os pares existem em todas as corretoras; `UNAVAILABLE` é esperado para pares não listados.
- A implementação usa consultas REST sequenciais e é adequada para um MVP de baixa frequência, não para trading de alta frequência.
- Ainda não verifica profundidade de livro, tamanho mínimo de ordem, precisão/tick size, limites de API, custos de rede, depósitos/levantamentos, bloqueios regionais ou tempo de transferência.
- Não ativa execução financeira real.

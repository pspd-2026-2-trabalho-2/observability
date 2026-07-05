# Status, limitações e próximos passos

Este arquivo concentra o que já está pronto, o que falta e as limitações
conhecidas da stack de observabilidade. Para instruções de uso (subir,
validar, integrar seu serviço), veja o [README](README.md).

## Status e próximos passos

- ✅ Rede unificada + coleta (Prometheus vendo os 4 serviços) — feito.
- 🔜 Dashboards do Grafana (5+ métricas do requisito) — em andamento.
- 🔜 Testes de carga (k6/Locust, 10 a 1000 usuários) e correlação com o
  Prometheus/Grafana — planejado para depois do cluster Kubernetes estar de
  pé.

## Dashboards do Grafana

Ainda não há dashboards prontos — por enquanto o Grafana sobe só com o
datasource do Prometheus já configurado, pronto para explorar as métricas
manualmente (aba **Explore**) enquanto os dashboards não ficam prontos.
Quando forem criados, os arquivos JSON entram em
`grafana/provisioning/dashboards/json/` e aparecem automaticamente no Grafana
ao reiniciar o container (não precisa importar na mão).

## Limitações conhecidas (por serviço)

- **auth-service** usa a lib `go-grpc-prometheus`, que expõe a métrica
  `grpc_server_handled_total` com labels diferentes (`grpc_service`,
  `grpc_method`, `grpc_code`) dos outros dois serviços gRPC (`method`,
  `code`). Ao montar queries/dashboards, trate o auth-service separadamente.
- O histograma de latência (`grpc_server_handling_seconds`) **não está
  habilitado** no auth-service (precisaria de
  `grpc_prometheus.EnableHandlingTimeHistogram()` no código) — não aparece
  nas métricas até isso ser ligado no serviço.
- **api-gateway** só expõe métricas padrão do processo Go (`go_*`/`process_*`)
  — não há métricas HTTP de aplicação (req/s, latência, status por rota) na
  borda. Hoje dá para inferir isso pelos contadores gRPC dos serviços
  downstream; se quiser medir a borda diretamente, será necessário um
  middleware HTTP simples no gateway.

# observability

Stack de observabilidade do projeto PSPD (Trabalho 2 — Kubernetes e
monitoramento de microsserviços). Sobe, via Docker Compose, os 4 serviços de
backend (a partir do código dos repositórios irmãos) junto com Postgres,
Prometheus e Grafana, para coletar e visualizar as métricas que cada serviço
já expõe em `/metrics`.

Não tem código de aplicação — para rodar um serviço isolado, use o
`docker-compose.yml` do próprio repositório dele. Este aqui é para rodar
**tudo junto**.

```
Serviços (/metrics) ──▶ Prometheus (coleta) ──▶ Grafana (visualiza)
```

## Requisitos

- Docker + Docker Compose v2 (`docker compose version`)
- Repositórios clonados **lado a lado**, na mesma pasta pai (o build usa
  caminho relativo): `patient-data-service`, `data-transform-service`,
  `gateway-authorization-service`.
- [k6](https://k6.io) instalado, só se for gerar tráfego/rodar os testes
  de carga (`winget install GrafanaLabs.k6`, `choco install k6`, ou o
  binário oficial).

## Estrutura

```
docker-compose.observability.yml   orquestra os 4 serviços + db + keycloak + prometheus + grafana
prometheus/prometheus.yml           scrape config (4 jobs)
grafana/provisioning/
├── datasources/                    datasource Prometheus (uid fixo: prometheus)
└── dashboards/json/                dashboards carregados automaticamente (HU — Golden Signals)
keycloak/realm/hu-realm.json        realm importado automaticamente (login real via JWT)
loadtest/k6/smoke.js                script de teste de carga (local ou cluster remoto)
loadtest/README.md                  como rodar os testes, variáveis, limitações conhecidas
RESULTADOS-TESTES-DE-CARGA.md       resultados consolidados das campanhas de Fase 3 e 4
```

## Como executar

```bash
cd observability
cp .env.example .env   # opcional — só se quiser mudar algum valor padrão
docker compose -f docker-compose.observability.yml up -d --build
```

Reconstruir só um serviço, depois de mudar código nele:

```bash
docker compose -f docker-compose.observability.yml up -d --build patient-data-service
# ou: data-transform-service / auth-service / api-gateway
```

Parar:

```bash
docker compose -f docker-compose.observability.yml down       # mantém os dados
docker compose -f docker-compose.observability.yml down -v    # reseta tudo
```

## Endpoints

| Serviço | URL |
|---|---|
| API Gateway | http://localhost:8090 |
| Keycloak (login real, realm `hu`) | http://localhost:8081 (`admin`/`admin` no console) |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3000 (`admin`/`admin`) |
| Postgres | `localhost:5433` |
| patient-data-service (gRPC / métricas) | `localhost:50051` / http://localhost:9200/metrics |
| data-transform-service (gRPC / métricas) | `localhost:50053` / http://localhost:9201/metrics |
| auth-service (gRPC / métricas) | `localhost:50052` / http://localhost:9202/metrics |

> Gateway em `8090`, não `8080`: em alguns ambientes Windows com Docker
> Desktop, um processo de rede do próprio Docker (`wslrelay.exe`) pode ficar
> preso na porta `8080` do host. Internamente, na rede do compose, o serviço
> continua na porta `8080` normalmente.

## Variáveis de ambiente

Todas em `.env.example` — copiar para `.env` é opcional, os defaults abaixo
já funcionam sem nenhum arquivo:

| Variável | Padrão | Descrição |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `pspd` / `pspd` / `hospital` | banco usado pelo patient-data-service |
| `PSEUDONYM_SALT` | `pspd-troque-este-salt` | deve bater com o `.env` do data-transform-service |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | `admin` / `admin` | login do Grafana local |

> `KEYCLOAK_URL`/`KEYCLOAK_REALM` do gateway já vêm fixados no
> `docker-compose.observability.yml` (apontando para o Keycloak local
> deste repo) — não precisam de variável própria aqui.
>
> **`JWT_SECRET` não existe mais** — o gateway autentica via JWKS do
> Keycloak (`KEYCLOAK_URL`/`KEYCLOAK_REALM`), não lê mais essa variável.
> Se você ainda tiver um `.env` antigo com `JWT_SECRET`, pode remover.

## Validar

1. http://localhost:9090/targets — os 4 jobs devem estar **UP**.
2. `curl http://localhost:9200/metrics` (e as demais portas de métricas da
   tabela acima) deve responder em texto, formato Prometheus.
3. http://localhost:3000 (`admin`/`admin`) — datasource `Prometheus` e o
   dashboard **"HU — Golden Signals"** já vêm provisionados, sem passo manual.

## Painéis do dashboard

Dashboard **"HU — Golden Signals"** (uid `hu-golden-signals`):

| Painel | Métrica-base |
|---|---|
| Throughput gRPC por serviço | `grpc_server_handled_total` |
| Latência p95 gRPC (patient-data / data-transform) | `grpc_server_handling_seconds_bucket` |
| Taxa de erro gRPC | `grpc_server_handled_total{code!="OK"}` |
| Consultas ao banco (req/s + erros) | `db_queries_total` |
| Latência de consulta ao banco p95 | `db_query_duration_seconds_bucket` |
| Transformações FHIR por operação/nível | `fhir_transforms_total` |
| CPU por serviço | `process_cpu_seconds_total` |
| Memória residente por serviço | `process_resident_memory_bytes` |
| **Instâncias ativas por serviço** | **`sum by (job) (up)`** |

> **Instâncias ativas por serviço** usa `sum by (job) (up)` — nº de alvos UP por
> serviço. No Compose local vale `1` por serviço; no cluster K8s vale o nº de
> pods/réplicas em execução. No cluster, isso depende do Prometheus promover o
> label `app` do pod para `job` (relabel `__meta_kubernetes_pod_label_app` →
> `job`) — já aplicado e commitado no repo `k8s`
> (`manifests/monitoring/prometheus.yaml`). Sem esse relabel, o job único
> `pspd-pods` faria o painel virar um total agregado do namespace.

## Gerando tráfego

Sem tráfego, os painéis e contadores aparecem zerados. O gateway só aceita
JWT real emitido pelo Keycloak (JWKS) — não dá mais para fabricar um token
à mão. Duas formas de gerar tráfego real:

**1. Teste de carga com k6** (recomendado — já faz login de verdade e
exercita várias rotas):

```bash
k6 run --env VUS=10 --env DURATION=30s loadtest/k6/smoke.js
```

Detalhes completos (rodar contra o cluster remoto, variáveis, 5 níveis do
enunciado, limitações conhecidas): [loadtest/README.md](loadtest/README.md).
Resultados já coletados: [RESULTADOS-TESTES-DE-CARGA.md](RESULTADOS-TESTES-DE-CARGA.md).

**2. `curl` manual**, pegando um token real do Keycloak primeiro:

```bash
TOKEN=$(curl -s -X POST "http://localhost:8081/realms/hu/protocol/openid-connect/token" \
  -d "grant_type=password" -d "client_id=hu-frontend" \
  -d "username=med.cardoso" -d "password=pspd123" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -H "Authorization: Bearer $TOKEN" "http://localhost:8090/api/me/patients"
```

## Integrando outro serviço

- Mudou código em patient-data/data-transform/auth/gateway? Só reconstrua
  (`--build`) — este repositório sempre builda a partir do código atual dos
  repositórios irmãos.
- Métrica nova em `/metrics`? O Prometheus já está fazendo scrape, nada a
  mexer aqui.
- Serviço novo (ex.: frontend expondo métricas)? Adicione um bloco em
  `docker-compose.observability.yml` e um `job_name` em
  [`prometheus/prometheus.yml`](prometheus/prometheus.yml).
- Painel novo no dashboard? Edite o JSON em
  `grafana/provisioning/dashboards/json/`, referenciando o datasource pelo
  uid fixo `prometheus`.

## Status e limitações

Fases 0-4 do enunciado (rede unificada, coleta, dashboard, testes de
carga, autoscaling) concluídas — resultados completos em
[RESULTADOS-TESTES-DE-CARGA.md](RESULTADOS-TESTES-DE-CARGA.md). Painéis
do dashboard: ver seção acima.

Limitações conhecidas (por design ou por escopo — não são bugs deste
repositório):

- **auth-service** usa uma biblioteca de métricas diferente
  (`go-grpc-prometheus`), com labels próprios (`grpc_service`,
  `grpc_method`, `grpc_code`) em vez de (`service`, `method`, `code`) dos
  outros dois serviços gRPC. Tratado como query separada no painel de
  erro; não aparece no painel de latência (não habilita o histograma).
- **api-gateway** só expõe métricas padrão de processo Go — sem
  `http_requests_total`/`http_request_duration_seconds`. Throughput e
  latência da borda são inferidos pelos contadores gRPC downstream.
  (Mudança necessária no `gateway-authorization-service`, fora deste
  repo.)
- 3 RPCs de streaming do `patient-data-service`
  (`ListPatientsByDoctor`/`ListSupervisedPatients`/`ListCohortPatients`)
  não aparecem em `grpc_server_handled_total` — o interceptor de métricas
  só cobre chamadas unary. (Mudança necessária no `patient-data-service`.)

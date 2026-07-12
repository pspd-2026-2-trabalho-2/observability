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

## Estrutura

```
docker-compose.observability.yml   orquestra os 4 serviços + db + prometheus + grafana
prometheus/prometheus.yml           scrape config (4 jobs)
grafana/provisioning/
├── datasources/                    datasource Prometheus (uid fixo: prometheus)
└── dashboards/json/                dashboards carregados automaticamente
STATUS.md                           status, painéis existentes e limitações conhecidas
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
| `JWT_SECRET` | `secret-key` | deve bater com o `.env` do gateway-authorization-service |
| `PSEUDONYM_SALT` | `pspd-troque-este-salt` | deve bater com o `.env` do data-transform-service |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | `admin` / `admin` | login do Grafana local |

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
> pods/réplicas em execução. **No cluster** o painel só separa por serviço se o
> Prometheus do k8s promover o label `app` do pod para `job` — snippet pronto em
> [`k8s-handover/relabel-job-por-servico.md`](k8s-handover/relabel-job-por-servico.md)
> (aplicar é do colega do K8s). Sem o relabel, o job único `pspd-pods` faz o
> painel virar um total agregado do namespace.

## Gerando tráfego

Sem tráfego, os painéis e contadores aparecem zerados:

```bash
# Gera um token de teste em https://jwt.io (payload {"username":"med.cardoso","role":"MEDICO"}, secret "secret-key")
curl -H "Authorization: Bearer <TOKEN>" "http://localhost:8090/api/patients?patient_id=P000005"
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

O que já está pronto, os painéis existentes e as limitações conhecidas de
cada serviço ficam em [STATUS.md](STATUS.md).

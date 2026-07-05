# Observabilidade — HU (Prometheus + Grafana)

Este repositório é a parte de **observabilidade** do trabalho (Kubernetes +
monitoramento de microsserviços). Ele não tem código de aplicação — só sobe,
via Docker Compose, os **4 serviços de backend de vocês** (buscando o código
direto dos repositórios irmãos) junto com **Postgres, Prometheus e Grafana**,
tudo na mesma rede, para coletar e visualizar as métricas que cada serviço já
expõe em `/metrics`.

Serve para qualquer pessoa do grupo:
- **testar o backend inteiro rodando junto** (patient-data + data-transform +
  auth + gateway + banco), sem precisar subir cada `docker-compose.yml` na mão;
- **ver as métricas do próprio serviço** no Prometheus/Grafana antes de mexer
  em instrumentação;
- **validar que a instrumentação está correta** depois de alterar código.

Se você só quer rodar o seu serviço isolado, use o `docker-compose.yml` do
próprio repositório dele — este aqui é para rodar **tudo junto**.

## Pré-requisito: estrutura de pastas

Este compose builda as imagens a partir do **código-fonte dos outros
repositórios**, referenciando-os por caminho relativo (`../patient-data-service`
etc.). Por isso, os repositórios precisam estar clonados **lado a lado**, na
mesma pasta pai:

```
<uma-pasta-qualquer>/
├── observability/                    (este repositório)
├── patient-data-service/
├── data-transform-service/
├── gateway-authorization-service/
├── frontend/                         (não usado por este compose ainda)
└── keycloak/                         (não usado por este compose ainda)
```

Se algum desses repositórios estiver em outro lugar, ajuste os caminhos em
`docker-compose.observability.yml` (campo `build.context` de cada serviço).

## Pré-requisitos de ferramentas

- Docker + Docker Compose v2 (`docker compose version`)
- Nenhuma outra dependência local — Go, Postgres etc. rodam dentro dos
  containers.

## Subir a stack

```bash
cd observability
cp .env.example .env   # opcional — só se quiser mudar algum valor padrão
docker compose -f docker-compose.observability.yml up -d --build
```

Os valores em `.env.example` (senha do Postgres, `JWT_SECRET`,
`PSEUDONYM_SALT`, login do Grafana) são os mesmos defaults que os serviços já
usam nos próprios repositórios — copiar o `.env` só é necessário se você
quiser mudar algum deles. Se você alterou o `JWT_SECRET` ou o
`PSEUDONYM_SALT` no `.env` do gateway-authorization-service ou do
data-transform-service, replique o mesmo valor aqui para tudo continuar
compatível.

Isso builda a imagem de cada serviço a partir do código atual dos repositórios
irmãos, sobe o Postgres (aplicando `schema.sql` + `seed.sql` do
patient-data-service na primeira vez) e, só depois do banco ficar `healthy`,
sobe os demais serviços, o Prometheus e o Grafana.

**Atualizou o código do seu serviço?** Reconstrua só ele:

```bash
docker compose -f docker-compose.observability.yml up -d --build patient-data-service
# ou: data-transform-service / auth-service / api-gateway
```

**Ver logs de um serviço:**

```bash
docker compose -f docker-compose.observability.yml logs -f api-gateway
```

**Parar tudo** (mantém os dados dos volumes — banco, Prometheus, Grafana):

```bash
docker compose -f docker-compose.observability.yml down
```

**Parar e apagar os dados também** (reseta banco/histórico de métricas/dashboards do Grafana):

```bash
docker compose -f docker-compose.observability.yml down -v
```

## O que sobe

| Serviço | Endereço | Observação |
|---|---|---|
| API Gateway | http://localhost:8090 | ver nota sobre a porta abaixo |
| Prometheus | http://localhost:9090 | UI + `/targets` |
| Grafana | http://localhost:3000 | login `admin` / `admin` |
| Postgres | `localhost:5433` | mesmo banco/seed do patient-data-service |
| patient-data-service (gRPC) | `localhost:50051` | |
| patient-data-service `/metrics` | http://localhost:9200/metrics | |
| data-transform-service (gRPC) | `localhost:50053` | |
| data-transform-service `/metrics` | http://localhost:9201/metrics | |
| auth-service (gRPC) | `localhost:50052` | |
| auth-service `/metrics` | http://localhost:9202/metrics | |

As portas de host das métricas (9200/9201/9202) só existem para permitir
`curl` manual do seu computador — o Prometheus faz o scrape pela rede interna
do compose, usando as portas originais de cada serviço (9090/9091/9091), sem
esse deslocamento. Se quiser ver o `prometheus.yml`, é em
[`prometheus/prometheus.yml`](prometheus/prometheus.yml).

> **Por que o gateway está em `8090` e não `8080`?** Em alguns ambientes
> Windows com Docker Desktop, um processo de rede do próprio Docker
> (`wslrelay.exe`) pode ficar preso na porta `8080` do host e interceptar as
> requisições antes delas chegarem ao container. Por isso o host usa `8090`.
> Internamente, dentro da rede do compose, o serviço continua na porta `8080`
> normalmente — isso não afeta em nada a comunicação entre os serviços.

## Validar que está tudo funcionando

1. Abra http://localhost:9090/targets — os 4 jobs (`patient-data-service`,
   `data-transform-service`, `auth-service`, `api-gateway`) devem aparecer
   como **UP**. Se algum estiver `DOWN`, veja os logs do serviço
   correspondente.
2. `curl http://localhost:9200/metrics` (e as demais portas da tabela acima)
   deve responder com texto no formato Prometheus (`# HELP ...`, `# TYPE ...`).
3. Abra http://localhost:3000, logue com `admin`/`admin` e confirme em
   **Connections → Data sources** que o datasource `Prometheus` já existe —
   ele é provisionado automaticamente, sem nenhum passo manual.

## Gerando algum tráfego para ver métricas de verdade

Sem tráfego, os contadores de RPC e de consultas ao banco aparecem zerados.
Para ver algo se mexendo, gere algumas chamadas manuais, por exemplo:

```bash
# Gera um token de teste em https://jwt.io (payload {"username":"med.cardoso","role":"MEDICO"}, secret "secret-key")
curl -H "Authorization: Bearer <TOKEN>" "http://localhost:8090/api/patients?patient_id=P000005"
```

Depois, no Prometheus (http://localhost:9090/graph) ou no Grafana, consulte
métricas como `grpc_server_handled_total` ou `db_queries_total` — os valores
devem ter incrementado.

## Se você está mexendo em outro serviço

- **Não precisa copiar nada para cá.** Este repositório sempre builda a partir
  do código atual dos repositórios irmãos (ver estrutura de pastas acima). Só
  suba de novo com `--build`.
- **Adicionou uma métrica nova no seu serviço?** Ela aparece automaticamente
  no `/metrics` dele e o Prometheus já está fazendo scrape — não precisa mexer
  em nada aqui.
- **Criou um serviço novo (ex.: frontend expondo métricas)?** Adicione:
  1. um serviço no `docker-compose.observability.yml` (copie um bloco
     existente como referência);
  2. um `job_name` novo em [`prometheus/prometheus.yml`](prometheus/prometheus.yml)
     apontando para `<nome-do-serviço-no-compose>:<porta-interna>`.
- **Frontend:** hoje o frontend não expõe `/metrics` e não está no compose
  desta stack — quando isso for implementado, é só seguir o passo acima.

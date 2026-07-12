# Testes de carga (Fase 3) — k6

Script parametrizável por nº de usuários virtuais (VUs), com fluxo de
autenticação **real** (Keycloak → JWT → gateway → auth-service →
patient-data-service/data-transform-service).

## Estrutura

```
loadtest/
├── k6/smoke.js      # script parametrizado por VUs e duração
└── README.md        # este arquivo
```

## Pré-requisitos

- Stack local no ar: `docker compose -f ../docker-compose.observability.yml up -d --build`
  (inclui agora um serviço `keycloak` com o realm `hu` — ver seção abaixo).
- k6 instalado (`winget install GrafanaLabs.k6` no Windows, ou
  `choco install k6`, ou o binário oficial).

## Rodar um cenário

```bash
cd observability
"k6" run --env VUS=10 --env DURATION=30s loadtest/k6/smoke.js
```

Os 5 níveis do enunciado:

```bash
for vus in 10 50 100 500 1000; do
  k6 run --env VUS=$vus --env DURATION=1m loadtest/k6/smoke.js \
    | tee "loadtest/resultados/vus-${vus}.txt"
done
```

(criar `loadtest/resultados/` antes de rodar, se for salvar os outputs.)

## Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `BASE_URL` | `http://localhost:8090` | URL do api-gateway |
| `KEYCLOAK_URL` | `http://localhost:8081` | URL base do Keycloak |
| `KEYCLOAK_REALM` | `hu` | Realm |
| `KEYCLOAK_CLIENT` | `hu-frontend` | Client público, direct grant habilitado |
| `VUS` | `10` | Usuários virtuais simultâneos |
| `DURATION` | `30s` | Duração do teste |

## O que o script faz

Cada VU é associada a um dos 3 perfis do realm `hu` (round-robin por VU id) e
mantém essa identidade durante todo o teste:

| Perfil | Endpoints exercitados |
|---|---|
| MEDICO (`med.cardoso`) | `GET /api/patients/{id}`, `/summary`, `/api/me/patients` |
| ESTAGIARIO (`est.silva`) | `GET /api/patients/{id}/history`, `/api/me/supervised-patients` |
| PESQUISADOR (`pesq.souza`) | `GET /api/cohorts/{condition}/statistics`, `/exams`, `/api/me/projects` |

Login acontece **uma vez por VU** (token cacheado em memória, renovado perto
da expiração de 300s) — replica o comportamento real de um app (login →
navegação), não "login a cada request".

### Métricas coletadas (custom, além das nativas do k6)

- `auth_login_duration` — latência do login no Keycloak
- `gateway_req_duration` — latência das chamadas ao gateway
- `gateway_error_rate` — só erros reais de infra (5xx / falha de conexão)
- `gateway_rate_limited_rate` — respostas `429` (rate limiter do gateway)
- `gateway_denied_rate` — respostas `403` (DENY de autorização)
- `login_error_rate` — falhas de autenticação

---

## Limitações e comportamentos conhecidos (leia antes de interpretar resultados)

### 1. Rate limiter global do gateway — o teto real de throughput

`gateway/middleware.go` define `rate.NewLimiter(10, 20)`: **10 req/s
sustentados, burst de 20, compartilhado por todo o gateway** (não é por
usuário nem por IP). Em VUS mais altos, isso vira o gargalo dominante —
`gateway_rate_limited_rate` sobe rapidamente conforme VUs aumentam, mesmo
com o backend saudável. **Isso é esperado e é o próprio objetivo do teste
de carga**: mostrar onde o sistema começa a aplicar backpressure. Não tente
"corrigir" isso mudando o limiter — é comportamento intencional do gateway;
reportar como achado da Fase 3.

Só a título de referência: com `VUS=10` e ~3 chamadas de gateway por
iteração (sleep de 1s), a demanda agregada já é de ~25-30 req/s — bem acima
do limite sustentado de 10 req/s — por isso mesmo o cenário de 10 VUs já
mostra uma taxa relevante de 429.

### 2. `est.silva`/`pesq.souza` sem vínculo no seed local — DENY esperado

O `seed.sql` do `patient-data-service` só tem `user_patient_assignments`
para `med.cardoso` (paciente `P000001`..`P000008`, ATTENDING). Os usuários
locais `est.silva` e `pesq.souza` do realm `hu` não têm linhas
correspondentes em `user_patient_assignments`/`projects` — então endpoints
que dependem de vínculo específico (ex.: `/api/patients/{id}/history` para
`est.silva`) retornam `403` DENY, mesmo com token e role válidos. Isso ainda
é dado útil (exercita o fluxo real de auth+authz+DB), só não retorna
conteúdo. Se quiser cobertura mais completa, adicionar linhas de assignment
para esses usuários no `seed.sql` do `patient-data-service` (repo irmão).

### 3. Keycloak remoto (`grupo-3`) — bloqueado até correção externa

Testado nesta sessão: o `access_token` (e o `id_token`) emitido pelo
Keycloak remoto (`kiriland.unb.br/keycloak`, realm `grupo03`, client
`admin-cli`) **não carrega `realm_access.roles`** — nem pedindo o scope
`roles` explicitamente. O gateway extrai `role=""` desse token, resultando
em DENY sempre. **Um k6 apontado para o remoto hoje só mede erro, não carga
real.** Este é um bloqueio externo (configuração do Keycloak do professor),
já documentado no `todo.md` do repo `observability`. Script pronto pra
rodar contra o remoto assim que for corrigido — só sobrescrever `BASE_URL`,
`KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT`.

### 4. Keycloak local: brute-force protection desabilitado

O realm `hu` (`keycloak/realm/hu-realm.json`) tem `bruteForceProtected:
false`. Motivo: com poucos usuários de teste (3) compartilhados sob carga
concorrente, a proteção de força bruta do Keycloak disparava falsos
positivos (`user_temporarily_disabled`) mesmo com senha correta — confirmado
reproduzindo com `curl` concorrente fora do k6. Escopo: **só o realm `hu`
local**, usado exclusivamente para desenvolvimento/testes; não afeta o
Keycloak remoto nem produção alguma.

### 5. Keycloak local usa Postgres, não H2

O `docker-compose.observability.yml` configura `KC_DB=postgres` (banco
`keycloak` na mesma instância Postgres, criado por
`postgres-init/00-create-keycloak-db.sql`). O H2 embutido do modo
`start-dev` padrão não é adequado pra teste de carga (limitado a acesso
praticamente serial ao armazenamento).

---

## Troubleshooting

- **`login: status 200` falhando muito**: confira se o Keycloak está
  `healthy` (`docker ps`) e se `KC_HOSTNAME` bate com a porta usada
  (ver comentário no `docker-compose.observability.yml`, serviço `keycloak`
  — o `iss` do token precisa bater exatamente com `KEYCLOAK_URL` do gateway).
- **Erro `column "..." does not exist` no `auth-service`**: o volume
  `pgdata` está com schema desatualizado (persiste de um run anterior antes
  de alguma migração no `patient-data-service`). Recriar:
  `docker compose down && docker volume rm observability_pgdata && docker compose up -d --build`.

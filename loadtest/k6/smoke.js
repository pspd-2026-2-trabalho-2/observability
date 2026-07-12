// Teste de carga do API Gateway com fluxo de autenticação real (Keycloak).
//
// Uso:
//   k6 run --env VUS=50 --env DURATION=1m loadtest/k6/smoke.js
//
// Variáveis de ambiente (todas com default para rodar contra a stack local):
//   BASE_URL        URL do api-gateway               (default http://localhost:8090)
//   KEYCLOAK_URL     URL base do Keycloak              (default http://localhost:8081)
//   KEYCLOAK_REALM   Realm do Keycloak                 (default hu)
//   KEYCLOAK_CLIENT  Client ID (público, direct grant) (default hu-frontend)
//   VUS              Usuários virtuais simultâneos     (default 10)
//   DURATION         Duração do teste                  (default 30s)
//
// Para o cluster remoto (grupo-3), sobrescrever BASE_URL/KEYCLOAK_URL/
// KEYCLOAK_REALM/KEYCLOAK_CLIENT — mas ver loadtest/README.md: o Keycloak
// remoto hoje não emite `realm_access.roles`, então todo tráfego autenticado
// remoto resulta em DENY (bloqueio externo documentado no todo.md).
//
// Rate limit do gateway: middleware.go usa rate.NewLimiter(10, 20) — 10 req/s
// sustentados, burst de 20, GLOBAL (todo o gateway, não por usuário/IP). Em
// VUS mais altos isso vira o teto real de throughput — 429 é o gateway se
// protegendo sob carga, não um erro de infra. Ver loadtest/README.md.

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8090";
const KEYCLOAK_URL = __ENV.KEYCLOAK_URL || "http://localhost:8081";
const KEYCLOAK_REALM = __ENV.KEYCLOAK_REALM || "hu";
const KEYCLOAK_CLIENT = __ENV.KEYCLOAK_CLIENT || "hu-frontend";

// Usuários de teste do realm `hu` (ver keycloak/README.md). Only med.cardoso
// tem pacientes/atribuições reais no seed.sql local — est.silva e
// pesq.souza autenticam e exercitam o fluxo real (JWT + authz + DB), mas
// tendem a receber listas vazias ou DENY por não terem linhas em
// user_patient_assignments/projects. Ver loadtest/README.md.
const USERS = [
  { username: "med.cardoso", password: "pspd123", role: "MEDICO" },
  { username: "est.silva", password: "pspd123", role: "ESTAGIARIO" },
  { username: "pesq.souza", password: "pspd123", role: "PESQUISADOR" },
];

// Paciente real, atribuído a med.cardoso em ATTENDING (seed.sql).
const SAMPLE_PATIENT_ID = "P000001";
const SAMPLE_CONDITION = "DIABETES";

export const options = {
  vus: parseInt(__ENV.VUS || "10", 10),
  duration: __ENV.DURATION || "30s",
  thresholds: {
    // não falha o build de CI — thresholds servem só de referência no
    // resumo do k6; a análise real é feita comparando os 5 cenários.
    http_req_failed: ["rate<1.0"],
  },
};

const authLatency = new Trend("auth_login_duration", true);
const gatewayLatency = new Trend("gateway_req_duration", true);
const gatewayErrors = new Rate("gateway_error_rate");
const gatewayRateLimited = new Rate("gateway_rate_limited_rate");
const gatewayDenied = new Rate("gateway_denied_rate");
const gatewayRequests = new Counter("gateway_requests_total");
const loginErrors = new Rate("login_error_rate");

// Cache de token por VU (estado de módulo — cada VU roda sua própria
// instância do script em k6, então isto persiste entre iterações da mesma
// VU sem vazar para outras). Evita logar no Keycloak a cada iteração: um
// usuário real loga uma vez e reusa o token até perto da expiração —
// replicar "login a cada request" com poucos usuários compartilhados sob
// carga concorrente sobrecarrega o Keycloak e non-realisticamente aciona
// proteção de força bruta.
let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

function login(user) {
  const url = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
  const body = {
    grant_type: "password",
    client_id: KEYCLOAK_CLIENT,
    username: user.username,
    password: user.password,
  };
  const res = http.post(url, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    tags: { name: "keycloak_login" },
  });
  authLatency.add(res.timings.duration);
  const ok = check(res, {
    "login: status 200": (r) => r.status === 200,
    "login: access_token presente": (r) => {
      try {
        return !!JSON.parse(r.body).access_token;
      } catch (e) {
        return false;
      }
    },
  });
  loginErrors.add(!ok);
  if (!ok) return null;
  const data = JSON.parse(res.body);
  // renova 30s antes de expirar, com folga pra latência de rede
  cachedTokenExpiresAt = Date.now() + (data.expires_in - 30) * 1000;
  return data.access_token;
}

function getToken(user) {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }
  cachedToken = login(user);
  return cachedToken;
}

function callGateway(name, path, token) {
  const res = http.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name },
  });
  gatewayLatency.add(res.timings.duration);
  gatewayRequests.add(1);
  // três categorias de resultado, tratadas separadamente para a análise
  // comparativa entre os 5 níveis de VUs:
  //  - erro de infra (5xx / conexão): problema real
  //  - 429: rate limiter global do gateway (10 req/s, burst 20) agindo —
  //    esperado e cada vez mais frequente conforme VUS sobe
  //  - 403: DENY de autorização (esperado p/ est.silva/pesq.souza sem
  //    vínculo no seed local — ver loadtest/README.md)
  const isError = res.status >= 500 || res.status === 0;
  const isRateLimited = res.status === 429;
  const isDenied = res.status === 403;
  gatewayErrors.add(isError);
  gatewayRateLimited.add(isRateLimited);
  gatewayDenied.add(isDenied);
  check(res, {
    [`${name}: respondeu (2xx, 403 ou 429 são esperados)`]: (r) =>
      (r.status >= 200 && r.status < 300) || r.status === 403 || r.status === 429,
  });
  return res;
}

// Cada VU fica associada a um dos 3 perfis (round-robin por VU id) durante
// todo o teste. Login acontece só na primeira iteração da VU (ou quando o
// token cacheado está perto de expirar) — replica o comportamento real do
// frontend (login -> navegação com o mesmo token).
export default function () {
  const user = USERS[__VU % USERS.length];
  const token = getToken(user);
  if (!token) {
    sleep(1);
    return;
  }

  if (user.role === "MEDICO") {
    callGateway("get_patient", `/api/patients/${SAMPLE_PATIENT_ID}`, token);
    callGateway("get_patient_summary", `/api/patients/${SAMPLE_PATIENT_ID}/summary`, token);
    callGateway("get_my_patients", "/api/me/patients", token);
  } else if (user.role === "ESTAGIARIO") {
    callGateway("get_patient_history", `/api/patients/${SAMPLE_PATIENT_ID}/history`, token);
    callGateway("get_supervised_patients", "/api/me/supervised-patients", token);
  } else {
    callGateway("get_cohort_statistics", `/api/cohorts/${SAMPLE_CONDITION}/statistics`, token);
    callGateway("get_cohort_exams", `/api/cohorts/${SAMPLE_CONDITION}/exams`, token);
    callGateway("get_my_projects", "/api/me/projects", token);
  }

  sleep(1);
}

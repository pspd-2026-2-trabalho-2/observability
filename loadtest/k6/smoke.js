// Teste de carga do API Gateway com fluxo de autenticação real (Keycloak).
//
// Uso (local):
//   k6 run --env VUS=50 --env DURATION=1m loadtest/k6/smoke.js
//
// Uso (cluster remoto grupo-3):
//   k6 run --env TARGET=remote --env VUS=50 --env DURATION=1m \
//     --env BASE_URL=https://kiriland.unb.br/grupo3 \
//     --env KEYCLOAK_URL=https://kiriland.unb.br/keycloak \
//     --env KEYCLOAK_REALM=grupo03 \
//     --env KEYCLOAK_CLIENT=pseudopep-frontend \
//     loadtest/k6/smoke.js
//
// Variáveis de ambiente:
//   TARGET           "local" (default) ou "remote" — escolhe o conjunto de
//                    usuários de teste (ver USER_PROFILES abaixo)
//   BASE_URL         URL do api-gateway               (default http://localhost:8090)
//   KEYCLOAK_URL     URL base do Keycloak              (default http://localhost:8081)
//   KEYCLOAK_REALM   Realm do Keycloak                 (default hu)
//   KEYCLOAK_CLIENT  Client ID (público, direct grant) (default hu-frontend)
//   SAMPLE_CONDITION Código de condição pro cohort     (default DIABETES)
//   VUS              Usuários virtuais simultâneos     (default 10)
//   DURATION         Duração do teste                  (default 30s)
//
// client_id importa: `admin-cli` NÃO emite realm_access.roles nem
// preferred_username no access_token (confirmado em ambos os Keycloaks,
// local e remoto) — é só para a API administrativa do Keycloak, não para
// login de aplicação. Usar sempre o client "de aplicação" (hu-frontend
// local, pseudopep-frontend remoto).
//
// O paciente de teste NÃO é mais hardcoded: setup() loga como MEDICO e
// descobre um paciente real via GET /api/me/patients, funciona igual em
// qualquer ambiente/seed (local ou remoto), sem precisar saber IDs
// específicos de antemão.
//
// Rate limit do gateway: middleware.go usa rate.NewLimiter(10, 20) — 10 req/s
// sustentados, burst de 20, GLOBAL (todo o gateway, não por usuário/IP). Em
// VUS mais altos isso vira o teto real de throughput — 429 é o gateway se
// protegendo sob carga, não um erro de infra. Ver loadtest/README.md.

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";

const TARGET = __ENV.TARGET || "local";
const BASE_URL = __ENV.BASE_URL || "http://localhost:8090";
const KEYCLOAK_URL = __ENV.KEYCLOAK_URL || "http://localhost:8081";
const KEYCLOAK_REALM = __ENV.KEYCLOAK_REALM || "hu";
const KEYCLOAK_CLIENT = __ENV.KEYCLOAK_CLIENT || "hu-frontend";
const SAMPLE_CONDITION = __ENV.SAMPLE_CONDITION || "DIABETES";

// Usuários de teste por ambiente. "local": realm `hu` (ver
// keycloak/README.md) — só med.cardoso tem pacientes/atribuições reais no
// seed.sql local; est.silva/pesq.souza autenticam e exercitam o fluxo real
// (JWT + authz + DB), mas tendem a receber DENY/lista vazia por não terem
// linhas em user_patient_assignments/projects (ver loadtest/README.md).
// "remote": usuários reais do PDF de orientações do professor (realm
// `grupo03`, client pseudopep-frontend — NÃO admin-cli).
const USER_PROFILES = {
  local: [
    { username: "med.cardoso", password: "pspd123", role: "MEDICO" },
    { username: "est.silva", password: "pspd123", role: "ESTAGIARIO" },
    { username: "pesq.souza", password: "pspd123", role: "PESQUISADOR" },
  ],
  remote: [
    { username: "med.cardoso", password: "PseudoPEP2026!", role: "MEDICO" },
    { username: "est.ferreira", password: "PseudoPEP2026!", role: "ESTAGIARIO" },
    { username: "pes.mendes", password: "PseudoPEP2026!", role: "PESQUISADOR" },
  ],
};
const USERS = USER_PROFILES[TARGET] || USER_PROFILES.local;

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
  //  - 403: DENY de autorização (esperado p/ usuários sem vínculo real de
  //    paciente/projeto — ver loadtest/README.md)
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

// setup() roda uma vez, fora do contexto das VUs, antes do teste começar.
// Loga como MEDICO e descobre um paciente real via /api/me/patients — evita
// hardcodar um patient_id que só existe num ambiente específico (local ou
// remoto têm datasets diferentes). Fallback pra um ID fixo só se a
// descoberta falhar (ex.: gateway fora do ar já no setup).
export function setup() {
  const medico = USERS.find((u) => u.role === "MEDICO") || USERS[0];
  const token = login(medico);
  let patientId = null;

  if (token) {
    const res = http.get(`${BASE_URL}/api/me/patients`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body);
        const entries = body.entry || [];
        if (entries.length > 0) {
          patientId = entries[0].resource.id;
        }
      } catch (e) {
        // ignora — cai no fallback abaixo
      }
    }
  }

  if (!patientId) {
    patientId = "P000001";
    console.warn(
      `setup(): não conseguiu descobrir um patient_id real via /api/me/patients — usando fallback "${patientId}". Verifique se o gateway/Keycloak estão acessíveis com TARGET=${TARGET}.`
    );
  }

  return { patientId };
}

// Cada VU fica associada a um dos 3 perfis (round-robin por VU id) durante
// todo o teste. Login acontece só na primeira iteração da VU (ou quando o
// token cacheado está perto de expirar) — replica o comportamento real do
// frontend (login -> navegação com o mesmo token).
export default function (data) {
  const user = USERS[__VU % USERS.length];
  const token = getToken(user);
  if (!token) {
    sleep(1);
    return;
  }

  const patientId = data.patientId;

  if (user.role === "MEDICO") {
    callGateway("get_patient", `/api/patients/${patientId}`, token);
    callGateway("get_patient_summary", `/api/patients/${patientId}/summary`, token);
    callGateway("get_my_patients", "/api/me/patients", token);
  } else if (user.role === "ESTAGIARIO") {
    callGateway("get_patient_history", `/api/patients/${patientId}/history`, token);
    callGateway("get_supervised_patients", "/api/me/supervised-patients", token);
  } else {
    callGateway("get_cohort_statistics", `/api/cohorts/${SAMPLE_CONDITION}/statistics`, token);
    callGateway("get_cohort_exams", `/api/cohorts/${SAMPLE_CONDITION}/exams`, token);
    callGateway("get_my_projects", "/api/me/projects", token);
  }

  sleep(1);
}

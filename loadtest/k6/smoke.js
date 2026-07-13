import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";

const TARGET = __ENV.TARGET || "local";
const BASE_URL = __ENV.BASE_URL || "http://localhost:8090";
const KEYCLOAK_URL = __ENV.KEYCLOAK_URL || "http://localhost:8081";
const KEYCLOAK_REALM = __ENV.KEYCLOAK_REALM || "hu";
const KEYCLOAK_CLIENT = __ENV.KEYCLOAK_CLIENT || "hu-frontend";
const SAMPLE_CONDITION = __ENV.SAMPLE_CONDITION || "DIABETES";


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

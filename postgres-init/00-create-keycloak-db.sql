-- Cria um banco separado para o Keycloak dentro da mesma instância Postgres
-- do compose. Executa antes de 01-schema.sql/02-seed.sql (prefixo "00-"),
-- que seguem populando o banco default (${POSTGRES_DB}, ex. "hospital").
--
-- Necessário porque o Keycloak em modo `start-dev` usa H2 embutido por
-- padrão, que não suporta grants de senha concorrentes para o mesmo
-- usuário (gera falso "invalid_grant" sob carga — descoberto durante os
-- testes de carga da Fase 3). Apontar para Postgres real resolve isso.
CREATE DATABASE keycloak;

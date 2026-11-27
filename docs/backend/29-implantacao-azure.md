# 29 — Implantação de produção no Azure

Produção publicada em **https://prazoai.online** em 26/11/2026, seguindo o doc 27 (requisitos de ambiente hospedado) e o doc 28 (PDF das intimações). Este documento registra **o que foi criado, como está configurado e como atualizar**. Nenhum segredo aparece aqui: todos ficam nos segredos do Azure Container Apps e no gerenciador de senhas do responsável.

## 1. Recursos

Assinatura Azure for Students, grupo `rg-prazoai-prod`, região **Brazil South**.

| Recurso | Nome | Configuração |
| --- | --- | --- |
| Container App (público) | `ca-prazoai-frontend` | imagem `ghcr.io/lufoanx/prazoai-frontend:<sha>` (build `NEXT_PUBLIC_PRAZOAI_MODE=integrated`), porta 3000, ingress externo, 0,25 vCPU / 0,5 GiB, 1 réplica, domínio `prazoai.online` com certificado gerenciado gratuito |
| Container App (interno) | `ca-prazoai-backend` | imagem `ghcr.io/lufoanx/prazoai-backend:<sha>`, porta 8000, **ingress interno**, 0,25 vCPU / 0,5 GiB, **mín. = máx. = 1 réplica** (doc 27 §9.1) |
| Ambiente Container Apps | `cae-prazoai-std` | modo **ConsumptionOnly** (o modo *express* não aceita domínio personalizado nem descoberta de serviço) |
| Log Analytics | `log-prazoai` | retenção 30 dias, limite diário 0,15 GB |
| PostgreSQL Flexible Server | `pg-prazoai-lucas2026` | PostgreSQL 18, B1ms, banco `prazoai_prod`; firewall: IP do administrador + regra `PermitirServicosAzure` (0.0.0.0) |
| Storage Account | `stprazoailucas2026` | contêiner **privado** `intimacoes`, HTTPS obrigatório, TLS 1.2, exclusão reversível de 30 dias |

Fora do Azure: **Resend** (SMTP), **Hostinger** (domínio e DNS), **GitHub** (código, CI, imagens no GHCR — pacotes públicos, sem segredos). A demonstração na Vercel continua separada.

## 2. DNS (Hostinger)

| Tipo | Nome | Para quê |
| --- | --- | --- |
| A | `@` | IP do ambiente `cae-prazoai-std` |
| TXT | `asuid` | verificação do domínio no Container Apps |
| TXT | `resend._domainkey` | DKIM do Resend |
| CNAME | `rsend`, `send` | SPF/retorno do Resend |
| TXT | `_dmarc` | `v=DMARC1; p=none;` |

SPF, DKIM e DMARC conferidos como `PASS` num e-mail real. Não há `www` (um CNAME encadeado impede o certificado gerenciado).

## 3. Banco de dados (doc 27 §6)

Três papéis: `prazoai_owner` (dono; só migrations), `prazoai_api` (backend) e `prazoai_bff_app` (sessões do BFF).

1. Migrations do backend com o dono: `alembic upgrade head` → revisão `0004` (`python -m app.db check`).
2. Esquema das sessões com o dono: `npm run bff:sessions -- migrate` → versão 1.
3. `backend/deploy/privilegios-minimos.sql` aplicado com os nomes reais; conferido que a API não lê `prazoai_bff` e o BFF não lê `prazoai`.

TLS verificado: `sslmode=verify-full&sslrootcert=/etc/ssl/certs/ca-certificates.crt`. O `psycopg[binary]` traz um OpenSSL próprio que não encontra os certificados do sistema com `sslrootcert=system`, por isso o caminho explícito (presente nas imagens `python:3.12-slim` e `node:22-alpine`).

## 4. Variáveis de execução

Valores marcados como **segredo** ficam em `secrets` do app e entram por `secretref:`.

**Backend:** `ENVIRONMENT=production`, `STORAGE=postgres`, `DATABASE_URL` (segredo, papel `prazoai_api`), `AUTH_JWT_SECRET` (segredo), `TRUSTED_PROXY_SECRET` (segredo), `PUBLIC_APP_ORIGIN=https://prazoai.online`, `CORS_ORIGINS=https://prazoai.online`, `EMAIL_TRANSPORT=smtp`, `EMAIL_FROM=PrazoAI <nao-responda@prazoai.online>`, `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=587`, `SMTP_SECURITY=starttls`, `SMTP_USERNAME=resend`, `SMTP_PASSWORD` (segredo: API key do Resend só de envio), `LOG_LEVEL=INFO`, `WEB_CONCURRENCY=1`, `FILE_STORAGE=azure_blob`, `AZURE_STORAGE_CONNECTION_STRING` (segredo), `AZURE_STORAGE_CONTAINER=intimacoes`, `GOOGLE_CLIENT_ID` (ID do cliente OAuth; não é segredo — doc 30).

**Frontend/BFF:** `PRAZOAI_APP_ENV=production`, `PRAZOAI_APP_ORIGIN=https://prazoai.online`, `PRAZOAI_BACKEND_URL=http://ca-prazoai-backend`, `PRAZOAI_BACKEND_PRIVATE_NETWORK=true`, `PRAZOAI_PROXY_SECRET` (segredo, igual ao `TRUSTED_PROXY_SECRET`), `PRAZOAI_TRUSTED_CLIENT_IP_SOURCE=x-forwarded-for-rightmost`, `PRAZOAI_BFF_SESSION_STORE=postgres`, `PRAZOAI_BFF_DATABASE_URL` (segredo, papel `prazoai_bff_app`), `PRAZOAI_BFF_SESSION_KEY` (segredo), `PRAZOAI_GOOGLE_CLIENT_ID` (o mesmo ID), `PRAZOAI_GOOGLE_CLIENT_SECRET` (segredo `google-secret`; doc 30).

**IP do cliente:** o Container Apps não tem cabeçalho de IP sobrescrito; ele acrescenta o IP real ao **fim** do `X-Forwarded-For`. O modo `x-forwarded-for-rightmost` (PR #37) lê só esse último item.

## 5. Como atualizar

1. PR → CI (`ci.yml`) verde → merge no `main`.
2. O workflow **Publicar imagens** gera as duas imagens com a tag do SHA do commit.
3. No Cloud Shell do portal (a conta institucional bloqueia o Azure CLI local e credenciais do Azure no GitHub):

```bash
RG=rg-prazoai-prod; TAG=<sha do commit no main>
az containerapp update -g $RG -n ca-prazoai-frontend --image ghcr.io/lufoanx/prazoai-frontend:$TAG
az containerapp update -g $RG -n ca-prazoai-backend --image ghcr.io/lufoanx/prazoai-backend:$TAG
```

Mudança de esquema: rodar a migration com o papel dono **antes** de atualizar o backend, e reaplicar `privilegios-minimos.sql` após migration do esquema `prazoai_bff`.

## 6. Verificações feitas em produção

- `/bff/health` → `{"status":"ok","sessionStore":"postgres"}`; frontend → backend pela rede interna (`/bff/public/password/status` → `{"available":true}`).
- Backend sem acesso público (`external=false`), 1 réplica `Healthy`.
- Cadastro, login, logout, recuperação de senha (e-mail entregue na caixa de entrada; link de uso único), upload e download de PDF, recusa de arquivo inválido, prazo manual, calendário e dashboard.
- Entrar com Google: conta nova, mesma conta para e-mail já cadastrado e cancelamento (doc 30).

## 7. Custos e limites

- Container Apps (Consumption): franquia mensal gratuita de vCPU-s, GiB-s e requisições; o backend sempre ligado excede a franquia em poucos dólares por mês, pagos pelos créditos do Azure for Students.
- PostgreSQL B1ms: dentro da oferta gratuita de 12 meses para novos clientes (conferir no Cost Management).
- Resend: plano gratuito (limites diários e mensais de envio).
- Limitações aceitas (doc 27 §9): limites de tentativa e fila de e-mail em memória no backend; um reinício zera os contadores.

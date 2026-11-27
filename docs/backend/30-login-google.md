# 30 — Entrar com Google

O PrazoAI permite criar conta e entrar com uma conta Google, **além** do e-mail e senha. Nenhum dado do Google
além de nome e e-mail é usado, e o PrazoAI nunca vê a senha do Google.

## 1. Fluxo

1. Na tela de login ou cadastro, o botão **Entrar com Google** leva a `GET /bff/auth/google/start`.
2. O BFF gera `state`, `nonce` e um verificador PKCE (S256), guarda os três num cookie **cifrado** (AES-256-GCM),
   `HttpOnly`, `SameSite=Lax`, de 10 minutos e uso único, e redireciona ao Google
   (`scope=openid email profile`, `prompt=select_account`).
3. O Google devolve a pessoa a `GET /bff/auth/google/callback?code=…&state=…`. O BFF confere o `state` contra o
   cookie (comparação em tempo constante) e troca o código no endpoint de token do Google com o segredo do
   cliente e o verificador PKCE.
4. O BFF envia ao backend **só** o `id_token` e o `nonce` (`POST /api/v1/auth/google`). O backend confere:
   assinatura RS256 pelas chaves públicas do Google (JWKS, com cache de 1 h), emissor
   (`accounts.google.com`), público (= `GOOGLE_CLIENT_ID`), `exp`/`iat`, o `nonce` e `email_verified=true`.
5. Conta: se o e-mail (normalizado) já existe, entra na **mesma conta**; senão cria uma conta nova com o nome do
   Google e uma senha aleatória inutilizável (a pessoa pode definir senha depois por "Esqueci minha senha").
6. A sessão é criada pelo mesmo núcleo do login por senha (cookie `SameSite=Strict`, sessão no PostgreSQL).
   Como o cookie `Strict` não acompanha um redirecionamento iniciado no Google, o retorno é uma página curta que
   recarrega em `/app` já no mesmo site.

Falhas voltam a `/login?google=<motivo>` com uma mensagem simples: `cancelado`, `expirado`, `falhou`, `limite`,
`conta`, `indisponivel`. Os logs não contêm token, código, e-mail nem segredo.

## 2. Configuração

| Onde | Variável | Valor |
| --- | --- | --- |
| Backend | `GOOGLE_CLIENT_ID` | ID do cliente OAuth (termina em `.apps.googleusercontent.com`; não é segredo) |
| Frontend/BFF | `PRAZOAI_GOOGLE_CLIENT_ID` | o mesmo ID |
| Frontend/BFF | `PRAZOAI_GOOGLE_CLIENT_SECRET` | **segredo** (`secretref:google-secret` no Container Apps) |

Sem essas variáveis o botão aparece como indisponível e o resto do sistema funciona igual.
`GOOGLE_JWKS_URL`, `GOOGLE_ISSUER`, `PRAZOAI_GOOGLE_AUTHORIZE_URL` e `PRAZOAI_GOOGLE_TOKEN_URL` existem só para os
testes e são **recusados** em produção.

No Google Cloud (projeto próprio do PrazoAI): tela de consentimento **Externo**, publicada; cliente OAuth do tipo
**Aplicativo da Web** com a URI de redirecionamento autorizada `https://prazoai.online/bff/auth/google/callback`.
Os escopos `openid`, `email` e `profile` não exigem verificação do Google.

## 3. Testes

- Backend: `tests/test_auth_google.py` (19 testes, memória e PostgreSQL) — conta nova, vínculo com e-mail
  existente, assinatura de outra chave, `alg` HS256/none, público/emissor/validade/nonce/e-mail não verificado,
  limite de tentativas e ausência de dados pessoais nos logs.
- BFF: `frontend/tests/bff-google.test.mjs` — PKCE, cookie cifrado de uso único, expiração, cancelamento,
  adulteração, falhas do Google e do backend.
- E2E: `frontend/e2e/auth-google.spec.ts` com um provedor OpenID **de teste** (`e2e/google-mock.mjs`, chave RSA
  gerada por execução): conta nova, mesma conta para e-mail já cadastrado e cancelamento.

## 4. Arquivos

| Arquivo | Papel |
| --- | --- |
| `frontend/src/integrated/GoogleButton.tsx` | botão e mensagens de erro nas telas de login e cadastro |
| `frontend/src/app/bff/auth/google/{start,callback,status}/route.ts` | rotas do BFF |
| `frontend/src/server/bff/google-login.mjs` | state/nonce/PKCE, cookie cifrado, troca do código |
| `backend/app/security/google_id_token.py` | verificação do ID token |
| `backend/app/services/auth_service.py` (`login_with_google`) | vínculo/criação da conta e sessão |
| `backend/app/api/auth.py` (`POST /auth/google`) | rota da API |

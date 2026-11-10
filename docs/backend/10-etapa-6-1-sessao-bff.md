# 10 — Etapa 6.1: Integração de autenticação e sessão (BFF no Next.js)

> **Estado:** integrados cadastro, login, sessão após recarregar, logout, proteção de rotas e
> perfil (`/users/me`). Os demais módulos aparecem como **"ainda não integrados"**, sem dados
> demonstrativos. Validação em **desenvolvimento/teste**; nada aqui é implantação de produção.

## 1. Arquitetura
```
Navegador ──(cookie HttpOnly com ID opaco)──▶ Next.js (BFF /bff/*) ──(Bearer)──▶ FastAPI
```
- O navegador recebe **apenas** um identificador aleatório (32 bytes, base64url) no cookie
  `prazoai_sid` (local) ou `__Host-prazoai_sid` (HTTPS). **Access e refresh tokens ficam só no
  armazenamento de sessões do BFF** — nunca em JSON, `localStorage`, `sessionStorage`, cookies
  legíveis por JavaScript ou logs.
- Rotas do BFF: `POST /bff/auth/register`, `POST /bff/auth/login`, `POST /bff/auth/logout`,
  `GET /bff/session` e o proxy restrito `/bff/api/{rota}`.
- Núcleo testável em `frontend/src/server/bff/*.mjs`; as rotas do Next são finas
  (`src/app/bff/**/route.ts`, runtime Node, `force-dynamic`, sem cache).

## 2. Armazenamento de sessões do BFF
- **Em memória, um processo Node** (`session-store.mjs`), com interface substituível.
- Expiração por inatividade (`PRAZOAI_BFF_SESSION_IDLE_SECONDS`, 8 h) e idade máxima
  (`PRAZOAI_BFF_SESSION_MAX_AGE_SECONDS`, 7 dias, igual à vida da sessão no backend); limpeza
  periódica; capacidade (`PRAZOAI_BFF_MAX_SESSIONS`): ao atingir, novos logins recebem 503
  `session_capacity_reached` (ninguém é derrubado) e os tokens recém-emitidos são revogados.
- Ao terminar, os tokens são apagados do objeto antes da remoção. Um único `Map`; a renovação em
  andamento fica na própria sessão (sem mapas auxiliares).
- **Limitações:** perde todas as sessões ao reiniciar; **incompatível com várias instâncias,
  implantação distribuída ou serverless** nesta fase. Afinidade de instância não substitui um
  armazenamento compartilhado. **Não publicar na Vercel.** Os bloqueios de produção do backend
  continuam ativos.

## 3. Renovação e concorrência
- Renovação **antes** do envio quando o access token está a menos de
  `PRAZOAI_ACCESS_REFRESH_SKEW_SECONDS` (30 s) de expirar.
- **Serializada pela sessão**: requisições concorrentes (inclusive de várias abas) aguardam a
  mesma promessa e usam o estado atualizado. A detecção de reutilização do backend fica intacta.
- Troca condicional por geração: uma renovação que termine depois de logout, novo login ou troca
  de usuário **não recria** a sessão (os tokens novos são descartados).
- Resultados da renovação:

| Resultado | Comportamento |
|---|---|
| 200 | tokens trocados; requisição segue |
| 401 do backend | sessão local removida; 401 `session_expired` + cookie limpo |
| Conexão recusada (requisição não saiu) / 5xx / 429 | 503 `backend_unavailable`; **sessão mantida** (o backend reverte a transação em 5xx) |
| Timeout, erro de rede após envio, redirecionamento | **resultado incerto**: sessão local invalidada, 401 `session_refresh_uncertain`; o refresh antigo **não** é repetido |
| 200 com corpo interrompido, JSON inválido, vazio, grande demais ou par de tokens inválido | **resultado incerto** (a rotação pode ter ocorrido): igual à linha anterior |

- O par de tokens só é aceito se `accessToken` e `refreshToken` forem textos com tamanho
  plausível e `expiresIn` for inteiro entre 1 e 86.400.
- O corpo das respostas do backend é lido **em fluxo**, com teto de bytes (1 MB) conferido a cada
  bloco e o **mesmo prazo** da requisição (timer explícito, que também interrompe a leitura).
  Uma resposta só é considerada válida se o corpo inteiro chegou e, havendo conteúdo, é JSON
  válido. Em erros HTTP (4xx/5xx), um corpo ilegível não torna o resultado incerto.

- Após 401 do backend numa chamada do proxy não há nova tentativa (sessão revogada em outro lugar).
- **Mutações nunca são repetidas.** Timeout numa mutação → 504 `upstream_timeout` com
  `outcome: "unknown"`.

## 4. Login, logout e troca de usuário
- **Protocolo de cookies e login (auditoria 6.1, v3)** — várias abas compartilham o mesmo pote de
  cookies e o navegador aplica `Set-Cookie` mesmo de respostas que o React descarta; por isso a
  coordenação é feita no servidor:
  1. **Cookie com nome exclusivo por sessão** (`prazoai_sid_<slot>` / `__Host-prazoai_sid_<slot>`,
     slot aleatório de 10 caracteres). Toda resposta só apaga cookies que a própria requisição
     trouxe, pelo nome. Uma tentativa obsoleta **nunca** apaga nem sobrescreve o cookie de uma
     tentativa mais nova, que sempre tem outro nome.
  2. **Cookie sem sessão viva nunca é reabilitado.** Login com cookie(s) de sessão, mas nenhum vivo,
     recebe 409 `session_resync_required`, sem chamar o backend. `GET /bff/session` apaga os cookies
     mortos (ressincronização, feita ao carregar a página) e o usuário tenta de novo explicitamente.
     Não existe registro de logouts: nada depende de TTL, capacidade ou expulsão, e logouts com IDs
     arbitrários não afetam outras sessões.
  3. **Bilhete de login pendente** na sessão viva atual (um único campo). Logout dessa sessão ou um
     novo login com o mesmo cookie cancelam o bilhete.
  4. **Finalização atômica.** Depois da resposta do backend, validar (bilhete não cancelado e sessão
     anterior ainda viva) e publicar (criar a sessão nova e encerrar a anterior) acontece numa
     sequência **síncrona, sem espera de rede entre os passos**. A revogação no backend (da sessão
     anterior, ou do par recém-emitido quando a tentativa perde) acontece **depois** da decisão e
     não reabre a janela. Se a sessão nova for encerrada durante essa revogação, o login responde
     409 sem instalar cookie.
  5. **Identificador do navegador** (`prazoai_bid`, `HttpOnly`, estável, criado no primeiro login).
     Não é credencial. O logout encerra **todas** as sessões vivas desse navegador (varredura das
     próprias sessões, sem índice extra), inclusive a que um login concorrente acabou de publicar.
     Assim, um **logout concluído nunca é revertido** por um login iniciado antes dele.
  6. **Primeiro login** (sem cookie de sessão): não há o que encerrar nem coordenar; conclui
     normalmente. Dois primeiros logins concorrentes: vale a sessão mais nova; a outra é encerrada
     na próxima ressincronização.
  7. Falha de login preserva a sessão anterior (o cliente ressincroniza). Login explícito depois do
     logout funciona normalmente.
  8. Só login emite cookies novos; logout, sessão encerrada e ressincronização só apagam cookies
     observados; respostas comuns do proxy não mexem em cookies.
- **Aviso entre abas:** ao receber "logout" de outra aba, o cliente limpa os dados locais e
  ressincroniza com o servidor (a sessão pode já ter sido substituída por um login mais novo). O
  aviso não é autoridade.
- **Logout:** encerra **primeiro**, de forma síncrona, as sessões vivas do navegador (as dos
  cookies enviados e as do identificador do navegador), cancelando logins pendentes associados.
  Depois tenta revogar no backend. Responde sempre 204 (idempotente), mesmo com o backend fora do
  ar, e apaga só os cookies observados.
- **No navegador** (`auth-controller.mjs`): login, cadastro, restauração e logout são
  serializados — um logout pedido durante um login espera e encerra, então uma resposta atrasada
  de login não ressuscita a sessão. Cada transição incrementa a **época** do cliente: respostas
  de épocas anteriores são descartadas e requisições pendentes, abortadas.
- `BroadcastChannel("prazoai-auth")` avisa outras abas (logout/login). **Não é autorização.**

## 5. Erros distintos
`session_expired`/`session_refresh_uncertain` (401: pedir login) · `backend_unavailable` (503:
tela de indisponibilidade, **sem logout e sem dados demonstrativos**) · `rate_limited` (429 com
`Retry-After` preservado) · `upstream_timeout` (504, resultado desconhecido) · `login_cancelled` (409: logout ou login mais novo venceu) · `session_resync_required` (409: cookie sem sessão viva; ressincronizar e tentar de novo) · `csrf_rejected`
(403) · `payload_too_large` (413) · `not_found`/`method_not_allowed` (proxy).

## 6. Proxy restrito
- Destino fixo (`PRAZOAI_BACKEND_URL`, só servidor); nenhuma URL vem do cliente.
- Lista explícita (`allowlist.mjs`): `GET /auth/me`, `GET /users/me`, `PATCH /users/me` (6.1),
  ampliada na 6.2 com as rotas de escritório/equipe/convites/solicitações (ver doc 11) e na 6.3
  com prazos/calendário e query strings controladas por rota (ver doc 12). Login,
  cadastro, refresh e logout **não** passam pelo proxy (têm rotas próprias; refresh nunca é exposto).
- Segmentos validados (`[A-Za-z0-9_-]`, até 8): nada de `..`, codificações, query ou URL absoluta.
- Cabeçalhos para o backend são **montados do zero**: `Authorization`, cookies, `Host`,
  `X-Forwarded-*` e cabeçalhos internos enviados pelo navegador nunca são repassados.
- `redirect: "manual"` (redirecionamento = resposta inválida); timeout
  (`PRAZOAI_BFF_TIMEOUT_MS`); corpo até `PRAZOAI_BFF_MAX_BODY_BYTES` (413 acima) e só objeto
  JSON; respostas até 1 MB; repassa apenas `Retry-After` e `X-Current-Version`.
- Todas as respostas: `Cache-Control: no-store, private`.

## 7. Cookies e CSRF
- `HttpOnly; Path=/; SameSite=Strict`; `Secure` + prefixo `__Host-` (sem `Domain`) em HTTPS.
- HTTP sem `Secure` **só** com `PRAZOAI_COOKIE_INSECURE_LOCAL=true`, `PRAZOAI_APP_ENV` =
  development/test e origem loopback. A decisão vem da configuração (`PRAZOAI_APP_ENV` +
  `PRAZOAI_APP_ORIGIN`), nunca de `Host` ou `X-Forwarded-Proto`, e independe de `NODE_ENV`
  (`next start` em teste não exige enfraquecer produção).
- Todas as chamadas do cliente exigem `X-PrazoAI-CSRF: 1`; mutações (inclusive login e logout)
  exigem `Origin` igual a `PRAZOAI_APP_ORIGIN`. SameSite não é a única defesa.

## 8. IP do cliente
- Backend: `TRUSTED_PROXY_SECRET` (desativado por padrão, mín. 32 bytes). Aceita
  `X-PrazoAI-Client-IP` (um único IPv4/IPv6 válido) **só** com `X-PrazoAI-Proxy-Secret` correto
  (comparação em tempo constante); senão usa o IP observado. `X-Forwarded-For` é ignorado.
- **Achado desta etapa:** o uvicorn, por padrão, reescreve o IP do cliente a partir de
  `X-Forwarded-For` quando a conexão vem de 127.0.0.1. Isso permitia a um cliente local forjar o
  IP. Os comandos de execução passaram a usar `--no-proxy-headers` (Makefile, READMEs e testes).
- BFF: só encaminha um IP lido de `PRAZOAI_TRUSTED_CLIENT_IP_HEADER`, que deve ser um cabeçalho
  **sobrescrito por infraestrutura confiável** (proibidos `X-Forwarded-For`/`Forwarded`), e
  exige `PRAZOAI_PROXY_SECRET`. Os route handlers do Next 15 não expõem um IP de origem
  verificável; por isso o padrão é **não encaminhar**: o backend vê o IP do BFF e **os limites por
  IP (ex.: cadastro) ficam compartilhados** entre todos os usuários do BFF. Para homologação, os
  limites são configuráveis no backend.

## 9. Modos demo × integrado
- `NEXT_PUBLIC_PRAZOAI_MODE` (fixado no build): `demo` (padrão quando vazio, preserva o protótipo)
  ou `integrated`. Nunca alternado por falha da API; sem migração de dados antigos.
- Integrado: o layout raiz usa só o `AuthProvider` (nenhuma chave `prazoai:demo-*` é lida; as
  antigas são ignoradas, não apagadas); `/app` usa uma casca própria; módulos não integrados são
  reescritos (middleware) para "Módulo ainda não integrado" e os fluxos públicos pendentes
  (onboarding, convite, solicitação) e indisponíveis (recuperação de senha) têm layouts que nunca
  renderizam as telas demonstrativas. Google, recuperação por e-mail e troca de senha pelo perfil
  aparecem desabilitados com explicação.

## 10. Execução local
```bash
# backend
cd backend && make dev            # uvicorn ... --no-proxy-headers
# frontend (modo integrado)
cd frontend && cp .env.example .env.local && npm run build && npm run start
```

## 11. Testes
| Tipo | Onde | Executa |
|---|---|---|
| Unitários com **dublês** | `frontend/tests/bff-core.test.mjs`, `tests/bff-audit-fixes.test.mjs`, `tests/integration-client.test.mjs` | `npm test` |
| **Integração real** BFF ↔ FastAPI (uvicorn iniciado pelo teste) | `frontend/tests/integration/bff-backend.test.mjs` | `PRAZOAI_TEST_PYTHON=… npm run test:integration` |
| **E2E** navegador + Next (build integrado) + FastAPI | `frontend/e2e/auth.spec.ts` | `PRAZOAI_TEST_PYTHON=… npm run test:e2e` |
| Backend (IP confiável) | `backend/tests/test_trusted_client_ip.py` | `pytest` |

No E2E, o BFF fala com um **proxy HTTP de teste** (porta do backend + 1) que só repassa ao
FastAPI real; ele pode segurar o próximo login para reproduzir de forma determinística o cenário
"login pendente numa aba + logout na outra". As rotas de controle `/__e2e/*` existem apenas nesse
proxy de teste. O proxy segura uma única chamada do caminho pedido (`/__e2e/hold?path=…`) e libera
tudo em `/__e2e/release`. O E2E usa access token de 60 s e margem de 59 s, de modo que praticamente toda requisição
renova — exercitando a rotação real com duas abas. No CI, o job `integration` instala o Chromium
do Playwright; localmente, `PLAYWRIGHT_CHROMIUM_EXECUTABLE` permite usar outro binário.

## 12. Fora desta entrega
Onboarding/escritório (6.2), prazos (6.3), intimações e notificações (6.4), CSP completa e
limpeza opcional dos dados demonstrativos (6.5).

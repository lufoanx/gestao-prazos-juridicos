# 13 — Ambiente E2E: identidade de rede por cliente e IP compartilhado

> Correção da 6.3 (falha no CI do PR #16). Afeta **só a infraestrutura de teste E2E**; nenhum
> padrão da aplicação, do BFF ou do backend foi alterado.

## 1. O problema
- Os limites de convite do backend são **por IP**: `ORG_INVITE_ACCEPT_MAX=10` e
  `ORG_INVITE_LOOKUP_MAX=30`, a cada 15 minutos.
- Sem fonte de IP confiável, todas as requisições chegam ao backend com o IP do BFF. No E2E, todos
  os usuários de teste viravam um único cliente.
- Numa execução única da suíte (como no CI), `deadlines.spec` + `org.spec` passavam de 10 aceites
  em 15 minutos, e um teste recebia 429 ("Muitas tentativas").
- As execuções locais anteriores, divididas em duas por causa do limite de tempo da ferramenta,
  subiam um backend novo cada uma e por isso escondiam o problema.
- Os limites **não** foram aumentados.

## 2. Solução: cada BrowserContext é um cliente com IP próprio
```
Navegador (contexto N) ──cookie HttpOnly e2e_client_ip=203.0.113.N──▶ PROXY DE BORDA (E2E)
     :3100                                                      │ remove o cookie e cabeçalhos forjados
                                                                │ define x-prazoai-e2e-client-ip
                                                                ▼
                                                          Next/BFF :3101 ──(segredo)──▶ proxy de teste ──▶ FastAPI
                                                          lê SÓ esse cabeçalho          X-PrazoAI-Client-IP + Proxy-Secret
```
- **Atribuição:** `e2e/fixtures.ts`. Cada contexto criado pelos testes recebe, na ordem de criação, um
  IP estável e distinto em faixas reservadas para documentação (RFC 5737): `203.0.113.1–254` e
  depois `198.51.100.1–254`. É determinístico e sem colisões (contador único por worker; a suíte
  usa um worker).
  - Abas do mesmo contexto compartilham o IP.
  - Trocar de usuário no mesmo contexto **não** troca o IP.
- **Onde a identidade é colocada:** o harness grava o cookie `e2e_client_ip` no contexto
  (`context.addCookies`, `HttpOnly`, `SameSite=Strict`). O código da página não lê nem altera.
- **Onde o cabeçalho confiável é definido/sobrescrito:** exclusivamente em `e2e/edge-proxy.mjs`, o
  proxy de borda simulado diante do Next, iniciado em `e2e/global-setup.mjs`. Ele:
  1. aceita como identidade apenas endereços das faixas de documentação;
  2. **remove** o cookie de identidade antes de repassar (o Next/BFF nunca o vê);
  3. **descarta** qualquer `x-prazoai-e2e-client-ip`, `X-Forwarded-For`, `X-Real-IP`, `Forwarded`,
     `X-PrazoAI-Client-IP` ou `X-PrazoAI-Proxy-Secret` vindos do navegador;
  4. define `x-prazoai-e2e-client-ip` com a identidade do contexto (ou nada, se não houver);
  5. repassa `Host: localhost:<porta interna>` para manter internas as reescritas do middleware do
     Next. Origin, cookies da aplicação, métodos e corpos passam intactos.

  Escuta só em loopback (127.0.0.1 e ::1) e não tem rotas de controle.
- **Mecanismo de IP confiável existente** (Etapa 6.1), habilitado **somente no E2E**:
  - BFF: `PRAZOAI_TRUSTED_CLIENT_IP_HEADER=x-prazoai-e2e-client-ip` e `PRAZOAI_PROXY_SECRET`;
  - backend: `TRUSTED_PROXY_SECRET`, com o mesmo valor.
- **Segredo:** gerado por execução em `playwright.config.ts` (`PRAZOAI_E2E_PROXY_SECRET`, 32 bytes
  aleatórios) e passado só ao processo do Next (webServer) e ao backend do E2E. Não é
  `NEXT_PUBLIC_*`, não chega ao navegador (o E2E confere cabeçalhos e conteúdo das páginas), e a
  saída do servidor Next não é registrada.
- **Padrões inalterados:** em desenvolvimento e produção, `PRAZOAI_TRUSTED_CLIENT_IP_HEADER`,
  `PRAZOAI_PROXY_SECRET` e `TRUSTED_PROXY_SECRET` continuam vazios (sem confiança em IP
  encaminhado). O proxy de teste do backend (`/__e2e/hold`, `/__e2e/release`, em 127.0.0.1)
  continua sendo o único com controles, e eles pertencem ao harness.

## 3. Os limites continuam testados
`e2e/network-identity.spec.ts`:
- **Consulta:** um contexto com **duas abas** faz 30 consultas, alternando entre elas (todas 200).
  A 31ª e a 32ª, de qualquer aba, recebem **429** (o contador é compartilhado). Uma consulta com
  `X-Forwarded-For`, `X-Real-IP` e o próprio cabeçalho confiável forjados pela página continua
  **429**. Outro contexto (outro IP) recebe **200**. O segredo não aparece em cabeçalhos, URLs nem
  conteúdo, e o cookie de identidade não é legível por JavaScript.
- **Aceite:** no mesmo contexto, a usuária 1 faz 6 tentativas, sai, e a usuária 2 faz mais 4 (10 no
  IP). A 11ª, já de uma conta com só 5 tentativas, recebe **429**: o limite por IP atravessa a troca
  de usuário. Outro contexto segue sem 429.
- **Comportamento padrão sem IP confiável** continua coberto: `backend/tests/test_trusted_client_ip.py`
  (desativado por padrão; `X-Forwarded-For` forjado ignorado; segredo ausente ou incorreto cai no
  IP observado) e `frontend/tests/integration/bff-backend.test.mjs` ("segredo incorreto direto no
  backend → IP forjado ignorado").
- Unitários do harness: `frontend/tests/e2e-harness.test.mjs`.

## 4. Execução
- `npm run test:e2e` roda **toda a suíte numa única execução**, com um único backend, `workers: 1`
  e `retries: 0` (nenhuma nova tentativa zera limitadores).
- Neste ambiente de desenvolvimento, o comando passa do limite de tempo de uma chamada de
  ferramenta; por isso foi executado em segundo plano e acompanhado até o fim.

## 5. Limitações de IP compartilhado (fora do E2E)
Sem infraestrutura que sobrescreva um cabeçalho de IP confiável, o BFF não encaminha IP de cliente
e **todos os usuários compartilham os limites por IP do backend** (cadastro, consulta e aceite de
convite, solicitações). Para homologação com várias pessoas atrás do mesmo BFF, isso pode gerar 429
precoces. A solução de implantação é a mesma desta correção: um proxy reverso confiável que
sobrescreva o cabeçalho, com segredo compartilhado entre BFF e backend (ver doc 10, §8).

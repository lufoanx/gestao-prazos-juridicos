# 23 — Atualização segura das dependências do frontend

> **Tipo de entrega:** manutenção de dependências do `frontend/` (só `package.json` e
> `package-lock.json`), isolada. Nenhuma funcionalidade nova, nenhuma mudança de código da aplicação,
> do backend, das migrations ou do CI. Produção continua bloqueada.
>
> **Base:** `main` `9cd95c3384d13c9e577fcee1defdd7eb03da3f50` (merge do PR #28; CI pós-merge
> `44213997371` verde nos quatro jobs). Branch `chore/frontend-deps-seguranca`.

## 1. Diagnóstico atual (antes)
`npm ci` com o lockfile da base, depois `npm audit` (npm 10.9.9, Node 22, registro público em
17/11/2026). As contagens antigas não foram usadas.

| Comando | Crítico | Alto | Moderado | Total de pacotes sinalizados |
|---|---|---|---|---|
| `npm audit` | 1 | 12 | 5 | 18 |
| `npm audit --omit=dev` | 1 | 3 | 0 | 4 |

Os 18 pacotes sinalizados vêm de **12 avisos** distintos. Os demais pacotes da lista só aparecem
porque dependem de um pacote vulnerável.

| Pacote (instalado) | Direta? | Uso | Aviso oficial | Corrigido em |
|---|---|---|---|---|
| `next` 15.5.25 | direta | produção | [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw) — RCE no Image Optimization com SVG (crítico; via `sharp`/librsvg em Linux glibc) | 15.5.28 |
| `next` 15.5.25 | direta | produção | [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) — DoS no App Router com Server Actions (alto) | 15.5.28 |
| `next` 15.5.25 | direta | produção | [GHSA-4jqv-mc3x-m676](https://github.com/advisories/GHSA-4jqv-mc3x-m676) e [GHSA-mcj8-r9mp-w47p](https://github.com/advisories/GHSA-mcj8-r9mp-w47p) — envenenamento de cache SSG/ISR (moderados) | 15.5.27 |
| `sharp` 0.35.4 | transitiva (`next`, opcional) | produção | [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) — librsvg, CVE-2026-96889 (alto) | 0.35.5 |
| `postcss` 8.4.31 | transitiva (`next`, versão **exata**) | produção (usada no build de CSS) | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) (XSS no stringify, <8.5.10), [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) (≤8.5.11), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) (≤8.5.17), [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) (≤8.5.22) — leitura de arquivos `.map` via `sourceMappingURL` em CSS controlado por atacante | 8.5.23 |
| `source-map-js` 1.2.1 | transitiva (`postcss`) | produção | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) — DoS por offsets de seções indexadas (alto) | 1.2.2 |
| `minimatch` 10.2.6 | transitiva (`eslint-config-next` → `@typescript-eslint/typescript-estree`) | desenvolvimento | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) — DoS por amplificação (moderado) | 11.0.1 |
| `picomatch` 2.3.2 e 4.0.7 | transitiva (`eslint-config-next` → `fast-glob`/`micromatch` e `tinyglobby`/`fdir`) | desenvolvimento | [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) (CVE-2026-112366) — ReDoS com extglobs repetidos de ramo único (alto) | **nenhuma versão publicada** (a última é 4.0.7, afetada) |

Fontes oficiais consultadas: base de avisos do npm (endpoint de auditoria, por versão), notas de
segurança do Next.js de [30/09/2026](https://nextjs.org/blog/september-2026-security-release) (15.5.27)
e de [14/10/2026](https://nextjs.org/blog/nextjs-security-update-october-14-2026) (15.5.28, com a
orientação de `sharp` ≥ 0.35.5), e a nota de 03/11/2026 que publicou 15.5.29 (Maintenance LTS) e
16.4.5. O aviso do `picomatch` (VulnCheck, 19/10/2026) não indica versão corrigida.

## 2. Decisão
- **Permanecer no Next.js 15** (linha 15.5, Maintenance LTS): 15.5.29 é a versão estável mais recente
  dessa linha e não tem aviso conhecido na base do npm. Uma migração para o 16 não é necessária para
  eliminar os avisos corrigíveis e não foi feita.
- **`npm audit fix --force` não foi usado**: ele propõe rebaixar `eslint-config-next` para 14.2.35
  (outra versão principal, incompatível com o Next 15) e mesmo assim não haveria `picomatch` corrigido.
- **Override restrito ao `postcss` do `next`**: o Next 15.5.29 ainda fixa `postcss` 8.4.31, afetado por
  quatro avisos corrigidos em 8.5.23. O override `{"next": {"postcss": "8.5.33"}}` troca **só** essa
  dependência, dentro da mesma versão principal (8.x, que segue semver), para a versão estável mais
  recente. O próprio Next 16 já usa `postcss` 8.5.x. Compatibilidade conferida no build: o CSS gerado
  ficou **idêntico byte a byte** ao da base (§4).

## 3. Versões
| Pacote | Antes | Depois | Como |
|---|---|---|---|
| `next` (direta, exata) | 15.5.25 | **15.5.29** | `package.json` |
| `eslint-config-next` (direta, dev) | ^15.5.25 (15.5.25) | **^15.5.29** (15.5.29) | `package.json` |
| `postcss` (de `next`) | 8.4.31 | **8.5.33** | `overrides` restrito a `next` |
| `sharp` (de `next`, opcional) | 0.35.4 | **0.35.5** | faixa do próprio `next` (`^0.34.3 \|\| ^0.35.5`); binários `@img/*` 0.35.5 e libvips 1.3.4 |
| `source-map-js` (de `postcss`) | 1.2.1 | **1.2.2** | faixa do `postcss` |
| `@typescript-eslint/*` (de `eslint-config-next`, dev) | 8.70.0 | **8.73.0** | faixa `^8` do `eslint-config-next` |
| `minimatch` (de `@typescript-eslint/typescript-estree`, dev) | 10.2.6 | **11.0.9** | faixa `^11.0.1` do 8.73.0 |
| `@next/env`, `@next/swc-*`, `@next/eslint-plugin-next` | 15.5.25 | 15.5.29 | acompanham o `next` |
| `nanoid` (de `postcss`) | 3.3.19 | 3.3.20 | faixa do `postcss` |
| `@isaacs/nonrecursive-glob-match` (de `minimatch` 11) | — | 1.1.0 | nova dependência transitiva |

Inalterados: `react`/`react-dom` 19.3.0, `typescript`, `eslint` 9.39.5, `lucide-react` e
**`@playwright/test` 1.64.1**: não estava afetado, então a imagem oficial do CI
(`mcr.microsoft.com/playwright:v1.64.1-noble`) continua alinhada e o navegador oficial não foi trocado.

## 4. Depois
| Comando | Crítico | Alto | Moderado | Total |
|---|---|---|---|---|
| `npm audit` | 0 | 13 | 0 | 13 |
| `npm audit --omit=dev` | **0** | **0** | **0** | **0** |

Dos 12 avisos, **11 foram eliminados**. Restam 13 pacotes sinalizados, todos pelo **mesmo** aviso do
`picomatch`, só em dependências de desenvolvimento. Os pacotes `@typescript-eslint/*` passaram de
"moderado" para "alto" porque, sem o `minimatch` vulnerável, a cadeia mais grave que sobra para eles é
a do `picomatch` via `tinyglobby`.

### Risco residual (não resolvido)
- **Aviso:** GHSA-fc5q-39xc-vjpf (CVE-2026-112366), `picomatch` ≤ 4.0.7, ReDoS quando um padrão glob
  **fornecido por um atacante** usa extglobs repetidos de ramo único (ex.: `+(*)`).
- **Cadeias:**
  - `eslint-config-next` → `@next/eslint-plugin-next` (`fast-glob` **3.3.1 exato**, também no Next 16) →
    `micromatch` 4.0.8 → `picomatch` 2.3.2;
  - `eslint-config-next` → `eslint-import-resolver-typescript` e `@typescript-eslint/typescript-estree` →
    `tinyglobby` → `fdir`/`picomatch` 4.0.7.
- **Exposição:** só no `npm run lint` (ESLint), com padrões definidos pelo próprio projeto e pelas
  bibliotecas. Nada disso entra no build de produção nem roda no servidor (`--omit=dev` = 0). Não há
  entrada de usuário que vire padrão glob.
- **Correção:** não existe versão corrigida publicada do `picomatch`. O caminho sugerido pelo npm é um
  rebaixamento para `eslint-config-next` 14.2.35 (incompatível) e não remove a cadeia via `tinyglobby`.
  Um override para outra versão não é possível, porque não há versão segura.
- **Ação futura:** quando o `picomatch` publicar a correção, atualizar o lockfile (as faixas `^2.3.1` do
  `micromatch` e `^4.0.4` do `tinyglobby` devem aceitá-la sem override) e repetir `npm audit`.

## 5. Compatibilidade e resultados
Conferido no build:
- `next build` (demo e integrado) com Next 15.5.29 e `postcss` 8.5.33;
- o CSS gerado (`.next/static/css`) teve o **mesmo SHA-256** com as dependências da base e com as novas.

Validação executada localmente na árvore final (sem alterações de código):
| Verificação | Resultado |
|---|---|
| `npm ci` + `npm audit` / `npm audit --omit=dev` | 13 (só o `picomatch`, dev) / **0** |
| `npm test` | 299/299 |
| `npm run typecheck`, `npm run lint` | sem erros |
| `next build` demo e integrado | ok (Next.js 15.5.29) |
| integração BFF × FastAPI, `memory` e `postgres`, Mailpit obrigatório | 45/45 e 45/45; dados persistidos; capturador vazio |
| E2E completo, uma execução, sem repetições | 59/59; dados persistidos; nenhum segredo no log; nenhum artefato em `test-results` |
| backend (como no CI): `pip check`, `pytest` completo com PostgreSQL e Mailpit, suítes HTTP em `postgres`, ciclo de migrations, manutenção 0/4/3, Ruff, MyPy, `compileall` | sem problemas; 1014 aprovados/1 pulado; 461 aprovados/24 pulados; ok |

Os cenários de autenticação, BFF, autorização, cookies, CSRF, captura de tokens, recuperação de senha e
modos demo/integrado foram cobertos pelas suítes existentes, sem remover testes nem aumentar timeouts.

## 6. Limitações
- Validação local, não confirmação do CI: Python 3.12.16 do setup-python relocado (imitando o contêiner
  do job `integration`), Node 22 (o CI instala Node 22 com `setup-node` nos jobs `frontend` e
  `integration`), Chromium
  local da revisão 1243 em vez do navegador da imagem oficial, Mailpit em 21025/28025.
- O comando `next lint` mostra o aviso de descontinuação já existente na base (migração para a CLI do
  ESLint fica fora desta entrega).
- Avisos do Next.js corrigidos **só** no 16.4.5 envolvem `use cache`, `unstable_cache` e o shell
  compartilhado de Cache Components, recursos que o projeto não usa; a base do npm não lista aviso
  para 15.5.29. A linha 15.5 recebe apenas correções de manutenção; migrar para o 16 é decisão futura.

## 7. Para a apresentação do TCC
"As bibliotecas de terceiros também têm falhas de segurança. Rodamos o `npm audit`, que comparou nossas
versões com os avisos oficiais: havia 12 avisos, 4 deles em código que vai para produção, incluindo um
crítico no Next.js. Atualizamos para versões corrigidas sem trocar a versão principal do framework e
conferimos que o resultado do build não mudou. Agora o que vai para produção não tem aviso conhecido.
Sobrou um aviso numa ferramenta de verificação de código usada só pelos desenvolvedores, que ainda não
tem correção publicada; ele está documentado com a sua exposição e o que fazer quando a correção sair."

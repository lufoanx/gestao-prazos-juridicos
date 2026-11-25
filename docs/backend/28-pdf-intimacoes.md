# 28 — PDF das intimações (upload, consulta e prazo por revisão manual)

> **Situação:** implementado e testado localmente com PostgreSQL descartável e **Azurite** (emulador
> local do Azure Blob Storage), só com PDFs sintéticos. **Não há recursos Azure criados** nem deploy.
> O que depende do Azure hospedado está na §9.

**Não há leitura automática.** O PDF é guardado e pode ser baixado depois; os dados do prazo são
preenchidos à mão e confirmados pela revisão humana já existente. Não há OCR, IA, extração nem cálculo
automático de vencimento, e a interface diz isso: *"Preencha os dados do documento. Leitura automática
ainda não disponível."*

## 1. Fluxo
1. **Registro** (`POST /intimations`, já existente): metadados (nome e tamanho do arquivo escolhido,
   data de recebimento). A intimação nasce `awaiting_review` (o processador continua indisponível; nada
   fica "em processamento").
2. **Envio do PDF** (`PUT /intimations/{id}/file`, novo): corpo binário `application/pdf` e nome de
   exibição em `X-PrazoAI-File-Name` (UTF-8 codificado em URL). No navegador, via BFF:
   `PUT /bff/files/intimations/{id}`.
3. **Consulta** (`GET /intimations/{id}/file`, novo): anexo com `Content-Disposition: attachment`,
   `Content-Type: application/pdf`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` e CSP
   `sandbox`. No navegador: `GET /bff/files/intimations/{id}` com o cabeçalho anti-CSRF (um link simples
   não baixa; a tela usa `fetch` e salva o Blob).
4. **Revisão manual e confirmação** (já existentes): a confirmação cria UM prazo vinculado; repetir não
   duplica (`created: false`, mesma regra de antes).
5. **Do prazo ao PDF** (`GET /deadlines/{id}/intimation`, novo): devolve a intimação de origem se o
   solicitante puder ler o prazo **e** a intimação (senão 404). A tela do prazo mostra "Intimação de
   origem" com "Baixar PDF".

Falha no envio depois do registro: a intimação fica **sem PDF** (a tela diz "PDF não enviado") e o envio
pode ser repetido pelo detalhe. Nunca há indicação de sucesso sem o arquivo armazenado.

## 2. Armazenamento
- **Bytes:** Azure Blob Storage, container **privado** (`AZURE_STORAGE_CONTAINER`). A aplicação nunca cria
  nem altera a política do container; o comando explícito `python -m app.files create-container` cria
  um container privado se faltar, e `python -m app.files check` confere que existe e não é público.
  A rota de prontidão (`/api/v1/health/ready`) também confere (`checks.files`); container público ou
  ausente → 503 sem detalhes.
- **Chave:** gerada no servidor (`intimations/<uuid4>.pdf`); o nome enviado nunca vira caminho. A chave
  não é exposta pela API.
- **Metadados e vínculo:** PostgreSQL (`prazoai.intimations`: `file_storage = stored`, `file_blob_key`,
  `file_sha256`, `file_stored_at`, tamanho e nome de exibição). Migration **0004**.
- **Sem disco efêmero nem localStorage:** nada do PDF é gravado no servidor web nem no navegador.
- **Acesso:** só pelo backend (credencial do servidor) e pelo BFF (sessão do usuário). Nenhuma URL SAS
  é emitida; nenhuma variável `NEXT_PUBLIC_*` participa.

## 3. Validação (servidor)
- Tamanho: 1 B a **10 MiB**, conferido pelo `Content-Length` e **durante a leitura** (BFF e backend);
  as demais rotas do BFF continuam com o limite JSON de 64 KiB.
- `Content-Type` declarado precisa ser `application/pdf`, mas **não basta**: o conteúdo precisa começar
  com `%PDF-x.y`, terminar com `%%EOF`, ter `startxref`, objetos indiretos e tabela/fluxo de referências.
- PDFs com `/Encrypt` (protegidos por senha) são recusados nesta entrega.
- O conteúdo **não é executado, renderizado nem registrado em logs**. A validação de formato **não é
  verificação de malware** (o produto não afirma que o arquivo é seguro). Por isso o download é sempre
  anexo, com `nosniff` e CSP `sandbox`.
- Um PDF por intimação; só intimações pendentes (antes da revisão) recebem arquivo.

## 4. Autorização
As mesmas regras da intimação (doc 09): enviar exige poder **escrever** a intimação
(`deadline.create` no escritório; dono no ambiente pessoal); baixar exige poder **ler**. Conta ou
escritório alheio recebe 404, mesmo conhecendo o identificador. O BFF mantém Origin/CSRF, sessão e
tokens do backend só no servidor; a sessão é conferida **antes** de ler o corpo.

## 5. Consistência entre o blob e o banco
`attach_file` (serviço de intimações):
1. valida o PDF;
2. transação: autoriza, confere estado e grava uma **reserva** (`prazoai.file_cleanup`, motivo
   `upload_pending`, vencendo em `FILE_UPLOAD_RESERVATION_SECONDS`, 1 h);
3. grava o blob (`overwrite=False`);
4. transação: autoriza de novo, consome a reserva e publica o arquivo na intimação (+ evento
   `file_stored`).

Falha em 3 ou 4: o blob é apagado na melhor tentativa e a resposta é erro (503/409). Se até isso falhar
(ou o processo cair), a reserva vence e a **limpeza** apaga o blob. Se a limpeza já consumiu a reserva,
a publicação é recusada — nunca há metadado apontando para blob removido.

## 6. Ciclo de vida
- Intimação **descartada** mantém o arquivo durante a retenção existente
  (`INTIMATIONS_DISCARD_RETENTION_SECONDS`, 30 dias). O expurgo apaga a linha; um **gatilho** no banco
  enfileira o blob (`intimation_deleted`) na mesma transação, e a limpeza o remove depois.
- Intimação **revisada** fica vinculada ao prazo e mantém o PDF (não há expurgo de revisadas).
- Limpeza: `python -m app.files cleanup` (agendável) e, de forma oportunista, depois do expurgo da
  manutenção do backend. Lotes com `FOR UPDATE SKIP LOCKED`; a entrada só sai depois do blob apagado.

## 7. Configuração (nomes; sem valores reais)
| Variável | Onde | Regra |
|---|---|---|
| `FILE_STORAGE` | backend | `disabled` (padrão: envio/consulta → 503) ou `azure_blob` (exige `STORAGE=postgres`); **obrigatório `azure_blob` em staging/production** |
| `AZURE_STORAGE_CONNECTION_STRING` | backend (segredo) | em ambiente hospedado: `DefaultEndpointsProtocol=https`, conta real (o emulador é recusado) |
| `AZURE_STORAGE_CONTAINER` | backend | nome do container privado (padrão `prazoai-intimacoes`) |
| `FILE_STORAGE_TIMEOUT_SECONDS` | backend | prazo por operação no Blob (20 s) |
| `FILE_UPLOAD_RESERVATION_SECONDS` | backend | vencimento da reserva de upload (3600 s) |
| `PRAZOAI_BFF_FILE_TIMEOUT_MS` | BFF | prazo total de envio/download pelo BFF (60 s) |

No Azure: conta de armazenamento com **acesso público a blobs desabilitado**, TLS mínimo 1.2, container
privado; recomendável restringir a rede da conta à aplicação (firewall/Private Endpoint) e, numa etapa
futura, trocar a chave da conta por identidade gerenciada (o código atual usa a cadeia de conexão).

## 8. Testes (comandos e resultados reais, locais)
Ambiente: WSL2, Python 3.12, Node 22.23.5, PostgreSQL 16 descartável, Azurite 3.37.0
(`--skipApiVersionCheck`, porque o SDK `azure-storage-blob==12.31.1` usa API mais nova que a do
emulador), Mailpit 1.31.6.

| Suíte | Resultado |
|---|---|
| `pytest tests/test_intimation_files.py` (PostgreSQL + Azurite obrigatórios) | 36 aprovados |
| `pytest` completo do backend (PostgreSQL, Azurite, Mailpit e PostgreSQL TLS obrigatórios) | 1128 aprovados, 1 pulado por projeto |
| `node --test tests/bff-files.test.mjs` | 5/5 |
| `tests/integration/intimation-files-backend.test.mjs` (BFF → FastAPI/PostgreSQL → Azurite) | 4/4 |
| `tests/integration/least-privilege-backend.test.mjs` (papéis separados; inclui `file_cleanup`) | 3/3 |
| `pytest` HTTP em `STORAGE=postgres` (`test_intimation_files.py` + `test_intimations_http.py`) | 75 aprovados |
| `npm test` (frontend, PostgreSQL obrigatório) | 335 aprovados, 0 pulados |
| `npm run test:integration` com backend em memória e em PostgreSQL (PDF, sessões compartilhadas e privilégios obrigatórios) | 58/58 em cada modo |
| E2E completo (Chromium; FastAPI/PostgreSQL; Azurite; Mailpit; sessões do BFF no PostgreSQL) | **72 aprovados, 0 pulados** (inclui os 2 cenários de `e2e/intimation-pdf.spec.ts`) |
| `npm run typecheck` · `npm run lint` · `npm run build` (demo e integrado) · ruff · mypy | sem erros; demo servindo páginas com `/bff/*` → 404 |

Cobertura: bytes iguais no download; recuperação após recriar app e clientes e após reiniciar o
processo do backend; tamanho excessivo (cabeçalho e fluxo), arquivo falso, PDF truncado, sem xref e
protegido por senha; sem autenticação (401), outra conta e outro escritório (404), membro sem
visibilidade (404) e leitor sem `deadline.create` (403); falha do Blob (503 sem falso sucesso),
upload gravado com resposta incerta e remoção falhando (limpeza posterior), intimação descartada durante
o upload (blob compensado); fluxo upload → rascunho → confirmação → prazo vinculado → download;
confirmação repetida sem duplicar; expurgo da descartada removendo o blob; prontidão com container
público → 503; CLI `check`/`create-container`; configuração hospedada exigindo `azure_blob` com HTTPS.

### 8.1 E2E
`e2e/intimation-pdf.spec.ts`: envio pela tela → aviso de preenchimento manual → download com bytes iguais
e nome do anexo → confirmação manual → repetição sem novo prazo → prazo vinculado → "Intimação de origem"
→ download com bytes iguais; outra conta recebe 404 e um link simples (sem o cabeçalho próprio) 403;
nada do PDF em localStorage/sessionStorage. Segundo cenário: arquivo falso recusado pela tela, intimação
fica "PDF não enviado" e o envio posterior pelo detalhe funciona (1 PDF por intimação).

Ajustes nos E2E existentes (comportamento novo, não afrouxamento): o registro agora envia um PDF
sintético; o primeiro rascunho parte da versão 2 (o envio do PDF incrementa a versão); o filtro das
requisições distingue a rota JSON da rota binária; a lista de textos proibidos ganhou "livre de
malware" e "Processando".

## 9. Depende do Azure hospedado (não validado)
- Criar conta de armazenamento e container privado (custos e região), definir a cadeia de conexão no
  gerenciador de segredos da plataforma e rodar `python -m app.files check`.
- Confirmar acesso público desabilitado na conta, TLS mínimo, regras de rede e logs de diagnóstico.
- Medir latência/tempo de upload de 10 MiB na topologia real (prazos do BFF e do backend).
- Backup do container (soft delete/versionamento de blobs) coerente com o backup do PostgreSQL.
- Agendar `python -m app.files cleanup` (ou confiar na limpeza oportunista) e monitorar
  `intimation_file_missing`, `intimation_file_store_failed`, `file_cleanup_storage_unavailable`.
- Verificação antimalware (ex.: Microsoft Defender for Storage) é decisão de produto e custo: **não
  existe** nesta entrega.

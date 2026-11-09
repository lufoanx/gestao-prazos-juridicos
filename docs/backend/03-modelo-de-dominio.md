# 03 — Modelo de Domínio (conceitual)

> **Atualização Etapa 3:** User, Office, Membership, Invitation e JoinRequest estão
> implementados em memória (`app/domain/org.py`); diferenças em relação a este texto
> conceitual estão marcadas abaixo e detalhadas em `07-etapa-3-escritorios-rbac.md`.

> Etapa 1. Conceitual, **sem ORM**, sem migrations. Deriva das regras já existentes no
> frontend (`src/lib/*.mjs`). Campos são conceituais; tipos finais virão com o banco.

Permissões referenciadas: `deadline.read`, `deadline.create`, `deadline.edit`,
`deadline.complete`, `deadline.transfer`, `team.manage`, `office.manage`.

---

## User
- **Responsabilidade:** pessoa autenticável (advogado/autônomo/membro).
- **Campos:** id, name, email (único; âncora de identidade), createdAt. (Senha → hash, fora do protótipo.)
- **Relacionamentos:** 0..1 `Membership` ativo; N `Deadline` pessoais; N `UserPreference`.
- **Regras:** e-mail imutável no perfil (evita mistura de dados); **escritório único** por vez.
- **Restrições:** e-mail único.
- **CRUD:** cria-se via cadastro; lê/edita o próprio perfil; exclusão fora do escopo.

## Office
- **Responsabilidade:** escritório (ambiente compartilhado).
- **Campos:** id, name, ownerId, createdAt. *(Implementado: `createdBy` informativo — não concede poderes — e `joinCode` aleatório para solicitações.)*
- **Relacionamentos:** N `Membership`; N `Deadline` de escritório; N `Invitation`; N `JoinRequest`.
- **Regras:** sempre ≥ 1 administrador (`office.manage`).
- **CRUD:** criar (onboarding); editar dados (requer `office.manage`); excluir fora do escopo.

## Membership
- **Responsabilidade:** vínculo User↔Office com cargo, permissões e visibilidade.
- **Campos:** userId, officeId, roleLabel, permissions[], visibility (`all`|`assigned`), practiceAreas[].
- **Relacionamentos:** pertence a 1 User e 1 Office.
- **Regras:** escritório único (um Membership ativo por User); sem **auto-escalada**; não remover/rebaixar o **último admin**. *(Implementado: também sem escalada indireta; `office.manage` exige `team.manage`; remoção bloqueada até a Etapa 4.)*
- **CRUD:** criar via convite/solicitação aprovada; editar (requer `team.manage`); remover (requer `team.manage` + reatribuição de prazos em aberto).

## Role / Permission
- **Responsabilidade:** conjunto nomeado de permissões (Role) e capacidade atômica (Permission).
- **Campos:** Role(label, permissions[]); Permission(key).
- **Regras:** conjunto canônico de permissões conhecido (admin ∪ membro). Permissão desconhecida é inválida.
- **CRUD:** gerido por `team.manage`/`office.manage`.

## Invitation
- **Responsabilidade:** convite por link único para ingressar em um Office.
- **Campos:** id, officeId, token, roleLabel, status (`pending`|`accepted`|`revoked`|`expired`), expiresAt, createdAt. *(Implementado: só `tokenHash`; `expired` é derivado da data.)*
- **Regras:** aceitar respeita escritório único; estados inválido/expirado/revogado/usado.
- **CRUD:** criar/revogar (requer `team.manage`); aceitar (usuário convidado).

## JoinRequest
- **Responsabilidade:** solicitação de ingresso via código do escritório.
- **Campos:** id, officeId, userId, name, email, status (`pending`|`approved`|`rejected`), createdAt. *(Implementado: sem cópia de name/email; estado adicional `cancelled`; `decidedAt`, `decidedBy`.)*
- **Regras:** solicitante não pode já ter escritório; aprovar respeita escritório único.
- **CRUD:** criar (solicitante); aprovar/rejeitar (requer `team.manage`).

## Deadline
> **Implementado na Etapa 4** (`app/domain/deadlines.py`): acrescenta `createdBy`, `createdAt`,
> `updatedAt` e `version` (controle otimista); `agendaTime` opcional; `duration` 1–3650;
> transições de status explícitas; comentários e histórico (`DeadlineHistory`) implementados.
> Detalhes em `08-etapa-4-prazos.md`.

- **Responsabilidade:** prazo jurídico (pessoal ou de escritório).
- **Campos:** id, scope(personal{ownerId}|office{officeId}), title, caseNumber, court, practiceArea,
  responsibleId, status(`open`|`completed`|`cancelled`), priority, startDate, dueDate,
  countingMode, duration, reviewed, agendaTime?.
- **Relacionamentos:** N `Comment`, N `Attachment`, N `DeadlineHistory`; 0..1 `Intimation` vinculada.
- **Regras:** isolamento por scope; urgência é **classificação visual** (não cálculo oficial);
  transferência pessoal→escritório preserva o mesmo registro (histórico/comentários/anexos) e não duplica.
- **CRUD:** criar/editar/concluir/cancelar conforme permissões (`deadline.*`), respeitando scope/visibilidade.

## DeadlineHistory (AuditLog do prazo)
- **Responsabilidade:** trilha de eventos do prazo.
- **Campos:** id, deadlineId, actorId, action, details, createdAt.
- **Regras:** somente leitura; registra criação/edição/conclusão/transferência/reatribuição/anexos/comentários.

## Intimation
> **Implementado na Etapa 5** (`app/domain/intimations.py`): só metadados declarados
> (`file.storage = "not_stored"`), sem processamento; estados `processing|awaiting_review|failed|
> reviewed|discarded`; rascunho, versão, vínculo único com o prazo e histórico próprio.
> Detalhes em `09-etapa-5-intimacoes-notificacoes.md`.

- **Responsabilidade:** documento (PDF) a revisar que pode gerar um prazo.
- **Campos:** id, scope, fileName, status(`sent`|`processing`|`awaiting_review`|`reviewed`|`failed`),
  receivedAt, createdBy, suggested*(title/caseNumber/court/area/responsible/dueDate)?, deadlineId?.
- **Regras:** extração **simulada** (não oficial, exige revisão humana); acesso por isolamento +
  permissão + visibilidade; **autor** acompanha item em processamento; confirmação cria **um único**
  prazo vinculado (proteção contra duplicação).
- **CRUD:** criar/processar/retry/remover (requer `deadline.create` + acesso); confirmar revisão cria Deadline.

## Notification
> **Implementado na Etapa 5:** destinatário individual, sem conteúdo armazenado, leitura
> individual com autorização atual. Ver `09-etapa-5-intimacoes-notificacoes.md`.

- **Responsabilidade:** aviso por ambiente.
- **Campos:** id, scope, title, read, deadlineId?, createdAt.
- **Regras:** isoladas por ambiente; marcar como lida (individual/todas).
- **CRUD:** geradas por eventos; marcadas como lidas pelo usuário do ambiente.

## Attachment
- **Responsabilidade:** anexo de um prazo (hoje demonstrativo).
- **Campos:** id, deadlineId, name, size, demoOnly.
- **Regras:** nenhum arquivo real é enviado no protótipo; no futuro, objeto em storage + metadados.
- **CRUD:** adicionar/remover conforme permissão sobre o prazo.

## UserPreference
- **Responsabilidade:** preferências por usuário.
- **Campos:** userId, density, reduceMotion, showCompleted, emailAlerts, digest, soonAlertDays.
- **Regras:** isoladas por usuário; alertas por e-mail/digest dependem de backend (hoje demonstrativos).
- **CRUD:** lidas/editadas pelo próprio usuário.

## AuditLog (global)
- **Responsabilidade:** trilha de auditoria geral (segurança/ações sensíveis) — futuro.
- **Campos:** id, actorId, action, entity, entityId, metadata, createdAt.
- **Regras:** somente leitura; sem dados sensíveis.

## AIAnalysis
- **Responsabilidade:** resultado de análise de intimação por IA/OCR — futuro.
- **Campos:** id, intimationId, suggestions, confidence?, createdAt.
- **Regras:** **não** substitui revisão humana; hoje inexistente (extração é simulada).
- **CRUD:** criada por serviço de IA; lida na revisão.

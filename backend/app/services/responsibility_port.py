"""Porta de responsabilidades (prazos) usada por remoção e saída de membros.

Etapa 4: a implementação padrão é `DeadlineResponsibilityPort`, ligada aos prazos
reais em memória. As chamadas acontecem DENTRO da unidade de trabalho composta
(escritórios + prazos), depois das verificações de autorização/invariantes e antes das
escritas de vínculo; as escritas da porta (reatribuição + histórico) são PREPARADAS e
só publicadas junto com a remoção/saída — ou descartadas em qualquer falha.

`UnavailableResponsibilityPort` permanece disponível (injeção explícita) para o modo
em que o módulo de prazos não estiver integrado: remoção/saída respondem 409
`responsibility_module_unavailable`, sem efeito.
"""
from __future__ import annotations

import uuid
from dataclasses import replace
from typing import Protocol

from app.domain.deadlines import Scope
from app.domain.intimations import Intimation, IntimationEvent
from app.repositories.deadlines import UnitTransaction
from app.services import deadline_ops as ops


class ResponsibilityModuleUnavailableError(Exception):
    """O módulo de responsabilidades (prazos) não está integrado."""


class ResponsibilityPort(Protocol):
    def count_open(self, tx: UnitTransaction, office_id: str, user_id: str) -> int:
        """Quantidade de prazos em aberto do usuário no escritório."""
        ...

    def reassign_open(
        self, tx: UnitTransaction, office_id: str, from_user_id: str, to_user_id: str, actor_id: str, reason: str
    ) -> int:
        """Reatribui (preparado, na mesma unidade) todos os prazos em aberto; retorna quantos."""
        ...


class UnavailableResponsibilityPort:
    """Bloqueia explicitamente os fluxos dependentes (sem efeito)."""

    def count_open(self, tx: UnitTransaction, office_id: str, user_id: str) -> int:
        raise ResponsibilityModuleUnavailableError()

    def reassign_open(
        self, tx: UnitTransaction, office_id: str, from_user_id: str, to_user_id: str, actor_id: str, reason: str
    ) -> int:
        raise ResponsibilityModuleUnavailableError()


class DeadlineResponsibilityPort:
    """Integração real (Etapas 4 e 5), dentro da unidade composta:

    - prazos EM ABERTO do escritório com o membro como responsável → reatribuídos
      (versão +1, evento `reassigned`, notificação ao novo responsável);
    - intimações PENDENTES (`processing`, `awaiting_review`, `failed`) do escritório cujo
      responsável operacional é o membro — responsável sugerido = membro, ou criadas por ele
      sem responsável sugerido ativo — recebem `reassignTo` como responsável sugerido
      (versão +1, evento, notificação); `createdBy` é preservado como autoria histórica.
    Concluídos/cancelados, revisadas (seguem o prazo), descartadas e registros pessoais não
    entram.
    """

    @staticmethod
    def _intimations(tx: UnitTransaction, office_id: str, user_id: str) -> list[Intimation]:
        out = []
        for i in tx.intimations.in_scope(Scope.office(office_id)):
            if not i.pending:
                continue
            suggested_active = ops.is_active_member(tx, office_id, i.suggested_responsible_id) and \
                i.suggested_responsible_id != user_id
            if i.suggested_responsible_id == user_id or (i.created_by == user_id and not suggested_active):
                out.append(i)
        return sorted(out, key=lambda i: i.id)

    def count_open(self, tx: UnitTransaction, office_id: str, user_id: str) -> int:
        return len(tx.deadlines.open_in_office_for(office_id, user_id)) + len(self._intimations(tx, office_id, user_id))

    def reassign_open(
        self, tx: UnitTransaction, office_id: str, from_user_id: str, to_user_id: str, actor_id: str, reason: str
    ) -> int:
        deadlines = sorted(tx.deadlines.open_in_office_for(office_id, from_user_id), key=lambda d: d.id)
        intimations = self._intimations(tx, office_id, from_user_id)
        for d in deadlines:
            ops.reassign_deadline(tx, d, to_user_id, actor_id, reason)
        tx.checkpoint("reassign:between")
        for i in intimations:
            updated = replace(i, suggested_responsible_id=to_user_id, version=i.version + 1, updated_at=tx.now)
            tx.intimations.put(updated)
            tx.checkpoint("reassign:intimation")
            event = IntimationEvent(
                id=uuid.uuid4().hex, intimation_id=i.id, actor_id=actor_id, action="responsible_reassigned",
                at=tx.now, details={"fromResponsibleId": i.suggested_responsible_id, "toResponsibleId": to_user_id,
                                    "reason": reason, "createdBy": i.created_by},
            )
            tx.intimations.add_event(event)
            ops.notify(tx, recipient_id=to_user_id, actor_id=actor_id, kind="intimation_assigned",
                       resource_type="intimation", resource_id=i.id, scope=i.scope, event_id=event.id)
        return len(deadlines) + len(intimations)

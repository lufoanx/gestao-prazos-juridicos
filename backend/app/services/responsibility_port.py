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

from app.domain.deadlines import HistoryEvent
from app.repositories.deadlines import UnitTransaction


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
    """Integração real: só prazos EM ABERTO do escritório; concluídos/cancelados e
    registros pessoais não são tocados. Cada prazo recebe versão +1, `updatedAt` e um
    evento `reassigned` (ator, responsável anterior e novo, motivo)."""

    def count_open(self, tx: UnitTransaction, office_id: str, user_id: str) -> int:
        return len(tx.deadlines.open_in_office_for(office_id, user_id))

    def reassign_open(
        self, tx: UnitTransaction, office_id: str, from_user_id: str, to_user_id: str, actor_id: str, reason: str
    ) -> int:
        targets = sorted(tx.deadlines.open_in_office_for(office_id, from_user_id), key=lambda d: d.id)
        for d in targets:
            tx.deadlines.put(replace(d, responsible_id=to_user_id, version=d.version + 1, updated_at=tx.now))
            tx.checkpoint("reassign:deadline")
            tx.deadlines.add_history(HistoryEvent(
                id=uuid.uuid4().hex, deadline_id=d.id, actor_id=actor_id, action="reassigned", at=tx.now,
                details={"fromResponsibleId": from_user_id, "toResponsibleId": to_user_id, "reason": reason},
            ))
            tx.checkpoint("reassign:history")
        return len(targets)

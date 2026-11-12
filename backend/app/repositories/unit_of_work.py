"""Unidade de trabalho EM MEMÓRIA entre escritórios, prazos, intimações e notificações.

Ordem ÚNICA de locks: escritórios → prazos → intimações → notificações (Etapa 5).
Nenhuma operação adquire um lock fora dessa ordem.

- `transaction(clock)`: só escritórios (implementa `OrgRepository`). Não pode remover
  vínculos (isso exige a verificação de responsabilidades em prazos).
- `unit(clock)`: os quatro armazenamentos. Usada por todas as operações de prazo,
  intimação e notificação (que consultam vínculos) e por remoção/saída de membros.

Em ambas, o relógio é lido DEPOIS de adquiridos os locks, e as escritas são
PREPARADAS (copy-on-write). Ao final do bloco sem exceção:
1. preparação final: limites de capacidade; política da caixa de notificações; invariantes
   de responsáveis (prazos em aberto e intimações pendentes) e do vínculo intimação ↔ prazo
   (único, recíproco, registros existentes, mesmo ambiente);
2. publicação: troca das quatro referências de estado; se algo falhar no meio, TODAS as
   referências antigas são restauradas.
Qualquer exceção em qualquer ponto descarta tudo. `fault` permite que os testes
injetem falhas em pontos nomeados (atributo interno; não há API pública para isso).
"""
from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Any

from app.core.clock import Clock
from app.domain.deadlines import Scope
from app.repositories.deadlines_memory import MemoryDeadlineStore, MemoryDeadlineTransaction
from app.repositories.intimations_memory import (
    IntimationLimits,
    MemoryIntimationStore,
    MemoryIntimationTransaction,
    MemoryNotificationStore,
    MemoryNotificationTransaction,
    NotificationLimits,
)
from app.repositories.memory_tx import ConsistencyError
from app.repositories.org_memory import MemoryOrgStore, MemoryOrgTransaction


class MemoryUnitTransaction:
    def __init__(
        self,
        org: MemoryOrgTransaction,
        deadlines: MemoryDeadlineTransaction,
        fault: Callable[[str], None] | None,
        intimations: MemoryIntimationTransaction | None = None,
        notifications: MemoryNotificationTransaction | None = None,
    ) -> None:
        self._org = org
        self._deadlines = deadlines
        self._fault = fault
        self._intimations = intimations
        self._notifications = notifications

    @property
    def intimations(self) -> MemoryIntimationTransaction:
        assert self._intimations is not None
        return self._intimations

    @property
    def notifications(self) -> MemoryNotificationTransaction:
        assert self._notifications is not None
        return self._notifications

    @property
    def org(self) -> MemoryOrgTransaction:
        return self._org

    @property
    def deadlines(self) -> MemoryDeadlineTransaction:
        return self._deadlines

    @property
    def now(self) -> datetime:
        return self._org.now

    def checkpoint(self, name: str) -> None:
        if self._fault is not None:
            self._fault(name)

    def lock_anchors(self, *, office_ids: tuple[str, ...] = (), user_ids: tuple[str, ...] = ()) -> None:
        return None  # locks globais já adquiridos na abertura da unidade

    @property
    def queries(self):
        from app.repositories.queries import MemoryQueries

        return MemoryQueries(self)


_DEFAULT_INTIMATION_LIMITS = IntimationLimits(5_000, 500, 30 * 24 * 3600)
_DEFAULT_NOTIFICATION_LIMITS = NotificationLimits(1_000, 90 * 24 * 3600)


class MemoryUnitOfWork:
    def __init__(
        self,
        org_store: MemoryOrgStore,
        deadline_store: MemoryDeadlineStore,
        intimation_store: MemoryIntimationStore | None = None,
        notification_store: MemoryNotificationStore | None = None,
    ) -> None:
        self.org_store = org_store
        self.deadline_store = deadline_store
        self.intimation_store = intimation_store or MemoryIntimationStore(_DEFAULT_INTIMATION_LIMITS)
        self.notification_store = notification_store or MemoryNotificationStore(_DEFAULT_NOTIFICATION_LIMITS)
        self.fault: Callable[[str], None] | None = None

    def _checkpoint(self, name: str) -> None:
        if self.fault is not None:
            self.fault(name)

    # ------------------------------------------------------------ só escritórios
    @contextmanager
    def transaction(self, clock: Clock) -> Iterator[MemoryOrgTransaction]:
        with self.org_store.lock:
            now = clock.now()  # lido DEPOIS de adquirir o lock
            tx = MemoryOrgTransaction(self.org_store, now, allow_membership_delete=False)
            tx.maybe_purge()
            yield tx
            self._checkpoint("org:prepare")
            if tx.changed:
                self.org_store.state = tx.build()
            if tx.purged:
                self.org_store.last_purge = now

    @contextmanager
    def read(self, clock: Clock) -> Iterator[MemoryUnitTransaction]:
        """Leitura consistente: em memória, a própria unidade (locks globais; nada é publicado)."""
        with self.unit(clock) as tx:
            yield tx

    def purge(self, now: datetime) -> int:
        with self.org_store.lock:
            tx = MemoryOrgTransaction(self.org_store, now, allow_membership_delete=False)
            removed = tx.purge()
            if tx.changed:
                self.org_store.state = tx.build()
            self.org_store.last_purge = now
            return removed

    # ------------------------------------- escritórios + prazos + intimações + notificações
    @contextmanager
    def unit(self, clock: Clock) -> Iterator[MemoryUnitTransaction]:
        with self.org_store.lock, self.deadline_store.lock, self.intimation_store.lock, \
                self.notification_store.lock:   # ordem fixa
            now = clock.now()  # lido DEPOIS de adquirir todos os locks
            org_tx = MemoryOrgTransaction(self.org_store, now, allow_membership_delete=True)
            org_tx.maybe_purge()
            dl_tx = MemoryDeadlineTransaction(self.deadline_store, now)
            in_tx = MemoryIntimationTransaction(self.intimation_store, now)
            in_tx.maybe_purge()
            nt_tx = MemoryNotificationTransaction(self.notification_store, now)
            nt_tx.maybe_purge()
            tx = MemoryUnitTransaction(org_tx, dl_tx, self.fault, in_tx, nt_tx)
            yield tx
            # 1. Preparação final (nada publicado ainda).
            dl_tx.validate_capacity()
            in_tx.validate_capacity()
            nt_tx.enforce_capacity()           # política da caixa (exclusões também são preparadas)
            self._check_responsibles(org_tx, dl_tx)
            self._check_intimations(org_tx, dl_tx, in_tx)
            self._checkpoint("unit:prepare")
            # 2. Publicação com restauração integral em caso de falha.
            stores: tuple[Any, ...] = (
                self.org_store, self.deadline_store, self.intimation_store, self.notification_store,
            )
            olds = tuple(st.state for st in stores)
            news = (
                org_tx.build() if org_tx.changed else olds[0],
                dl_tx.build() if dl_tx.changed else olds[1],
                in_tx.build() if in_tx.changed else olds[2],
                nt_tx.build() if nt_tx.changed else olds[3],
            )
            try:
                for i, (store, new_state) in enumerate(zip(stores, news, strict=True)):
                    store.state = new_state
                    if i < len(stores) - 1:
                        self._checkpoint("unit:publish" if i == 0 else f"unit:publish:{i}")
            except BaseException:
                for store, old_state in zip(stores, olds, strict=True):
                    store.state = old_state
                raise
            if org_tx.purged:
                self.org_store.last_purge = now
            if in_tx.purged:
                self.intimation_store.last_purge = now
            if nt_tx.purged:
                self.notification_store.last_purge = now

    @staticmethod
    def _check_intimations(
        org: MemoryOrgTransaction, dl: MemoryDeadlineTransaction, it: MemoryIntimationTransaction
    ) -> None:
        """Vínculo único e recíproco, registros existentes, mesmo ambiente, responsáveis válidos."""
        def active_in(office_id: str | None, user_id: str | None) -> bool:
            m = org.membership_of_user(user_id) if user_id else None
            return m is not None and m.office_id == office_id

        for iid in it.touched:
            i = it.get(iid)
            if i is None:
                continue
            if (i.status == "reviewed") != (i.deadline_id is not None):
                raise ConsistencyError("intimação revisada sem vínculo (ou vínculo sem revisão)")
            if i.deadline_id:
                d = dl.get(i.deadline_id)
                if d is None or it.by_deadline(i.deadline_id) is not i or d.scope != i.scope:
                    raise ConsistencyError("vínculo intimação ↔ prazo inconsistente")
            if i.pending and i.scope.kind == "office":
                if i.suggested_responsible_id and not active_in(i.scope.office_id, i.suggested_responsible_id):
                    raise ConsistencyError("intimação pendente com responsável sugerido fora do escritório")
                if not active_in(i.scope.office_id, i.created_by) and \
                        not active_in(i.scope.office_id, i.suggested_responsible_id):
                    raise ConsistencyError("intimação pendente sem responsável operacional (autor e sugerido inativos)")
        for did in dl.touched:
            linked = it.by_deadline(did)
            d = dl.get(did)
            if linked is not None and (d is None or linked.deadline_id != did or linked.scope != d.scope):
                raise ConsistencyError("prazo vinculado em ambiente diferente da intimação")
        for m in org.removed_memberships:
            if active_in(m.office_id, m.user_id):
                continue
            for i in it.in_scope(Scope.office(m.office_id)):
                if not i.pending:
                    continue
                orphan = i.created_by == m.user_id and not active_in(m.office_id, i.suggested_responsible_id)
                if i.suggested_responsible_id == m.user_id or orphan:
                    raise ConsistencyError("intimação pendente sem responsável operacional após saída")

    @staticmethod
    def _check_responsibles(org: MemoryOrgTransaction, dl: MemoryDeadlineTransaction) -> None:
        """Invariante: nenhum prazo em aberto do escritório com responsável fora dele."""
        def active_in(office_id: str, user_id: str) -> bool:
            m = org.membership_of_user(user_id)
            return m is not None and m.office_id == office_id

        for did in dl.touched:
            d = dl.get(did)
            if d and d.status == "open" and d.scope.kind == "office" and d.scope.office_id:
                if not active_in(d.scope.office_id, d.responsible_id):
                    raise ConsistencyError("prazo em aberto com responsável fora do escritório")
        for m in org.removed_memberships:
            if dl.open_in_office_for(m.office_id, m.user_id) and not active_in(m.office_id, m.user_id):
                raise ConsistencyError("vínculo removido com prazos em aberto")

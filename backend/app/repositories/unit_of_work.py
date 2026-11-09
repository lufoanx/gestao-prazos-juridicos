"""Unidade de trabalho EM MEMÓRIA entre escritórios e prazos (Etapa 4).

Ordem ÚNICA de locks: escritórios → prazos. Nenhuma operação adquire o lock de
prazos antes do de escritórios.

- `transaction(clock)`: só escritórios (implementa `OrgRepository`). Não pode remover
  vínculos (isso exige a verificação de responsabilidades em prazos).
- `unit(clock)`: escritórios + prazos. Usada por todas as operações de prazo (que
  consultam vínculos) e por remoção/saída de membros.

Em ambas, o relógio é lido DEPOIS de adquiridos os locks, e as escritas são
PREPARADAS (copy-on-write). Ao final do bloco sem exceção:
1. preparação final: limites de capacidade e invariante "nenhum prazo em aberto do
   escritório com responsável fora do escritório";
2. publicação: troca das referências de estado (escritórios, depois prazos); se algo
   falhar no meio, as referências antigas são restauradas.
Qualquer exceção em qualquer ponto descarta tudo. `fault` permite que os testes
injetem falhas em pontos nomeados (atributo interno; não há API pública para isso).
"""
from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime

from app.core.clock import Clock
from app.repositories.deadlines_memory import MemoryDeadlineStore, MemoryDeadlineTransaction
from app.repositories.memory_tx import ConsistencyError
from app.repositories.org_memory import MemoryOrgStore, MemoryOrgTransaction


class MemoryUnitTransaction:
    def __init__(
        self, org: MemoryOrgTransaction, deadlines: MemoryDeadlineTransaction, fault: Callable[[str], None] | None
    ) -> None:
        self._org = org
        self._deadlines = deadlines
        self._fault = fault

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


class MemoryUnitOfWork:
    def __init__(self, org_store: MemoryOrgStore, deadline_store: MemoryDeadlineStore) -> None:
        self.org_store = org_store
        self.deadline_store = deadline_store
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

    def purge(self, now: datetime) -> int:
        with self.org_store.lock:
            tx = MemoryOrgTransaction(self.org_store, now, allow_membership_delete=False)
            removed = tx.purge()
            if tx.changed:
                self.org_store.state = tx.build()
            self.org_store.last_purge = now
            return removed

    # ----------------------------------------------------- escritórios + prazos
    @contextmanager
    def unit(self, clock: Clock) -> Iterator[MemoryUnitTransaction]:
        with self.org_store.lock, self.deadline_store.lock:   # ordem fixa
            now = clock.now()  # lido DEPOIS de adquirir os dois locks
            org_tx = MemoryOrgTransaction(self.org_store, now, allow_membership_delete=True)
            org_tx.maybe_purge()
            dl_tx = MemoryDeadlineTransaction(self.deadline_store, now)
            tx = MemoryUnitTransaction(org_tx, dl_tx, self.fault)
            yield tx
            # 1. Preparação final (nada publicado ainda).
            dl_tx.validate_capacity()
            self._check_responsibles(org_tx, dl_tx)
            self._checkpoint("unit:prepare")
            # 2. Publicação com restauração em caso de falha.
            old_org, old_dl = self.org_store.state, self.deadline_store.state
            new_org = org_tx.build() if org_tx.changed else old_org
            new_dl = dl_tx.build() if dl_tx.changed else old_dl
            try:
                self.org_store.state = new_org
                self._checkpoint("unit:publish")
                self.deadline_store.state = new_dl
            except BaseException:
                self.org_store.state, self.deadline_store.state = old_org, old_dl
                raise
            if org_tx.purged:
                self.org_store.last_purge = now

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

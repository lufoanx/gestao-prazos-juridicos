"""Escritórios, vínculos, convites e solicitações no PostgreSQL (implementa `OrgTransaction`).

Numa unidade de escrita, qualquer leitura de algo que pertence a um escritório trava ANTES a
âncora do escritório (identificação preliminar → âncora → releitura). Assim, decisões como
"último administrador", "vínculo atual" e "convite pendente" valem para o estado estável do
escritório enquanto a transação durar.
"""
from __future__ import annotations

from sqlalchemy import and_, any_, exists, func, literal, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from app.db.tables import invitations, join_requests, memberships, offices
from app.domain.errors import DomainConflictError, JoinCodeCollisionError
from app.domain.org import Invitation, JoinRequest, Membership, Office
from app.repositories.sql._base import violated_constraint
from app.repositories.sql.domain.mapping import (
    U,
    invitation_cols,
    invitation_out,
    membership_cols,
    membership_out,
    office_out,
    request_cols,
    request_out,
)


class SqlOrgTransaction:
    def __init__(self, ctx) -> None:
        self._c = ctx

    @property
    def now(self):
        return self._c.now

    def lock_anchors(self, *, office_ids: tuple[str, ...] = (), user_ids: tuple[str, ...] = ()) -> None:
        self._c.lock_anchors(office_ids, user_ids)

    def _one(self, stmt):
        return self._c.conn.execute(stmt).first()

    # ------------------------------------------------------------ escritórios
    def get_office(self, office_id: str) -> Office | None:
        oid = U(office_id)
        if oid is None:
            return None
        self._c.anchor_office(oid)
        row = self._one(select(offices).where(offices.c.id == oid))
        return office_out(row) if row else None

    def get_office_by_code(self, code: str) -> Office | None:
        pre = self._one(select(offices.c.id).where(offices.c.join_code == code))
        if pre is None:
            return None
        self._c.anchor_office(pre.id)
        row = self._one(select(offices).where(offices.c.id == pre.id, offices.c.join_code == code))  # revalida
        return office_out(row) if row else None

    def code_in_use(self, code: str) -> bool:
        return self._one(select(offices.c.id).where(offices.c.join_code == code)) is not None

    def put_office(self, office: Office) -> None:
        """Insere ou atualiza; colisão de código num SAVEPOINT → JoinCodeCollisionError (transação segue válida)."""
        self._c.require_write()
        values = {"id": U(office.id), "name": office.name, "created_by": U(office.created_by),
                  "created_at": office.created_at, "join_code": office.join_code}
        try:
            with self._c.conn.begin_nested():
                self._c.conn.execute(pg_insert(offices).values(**values).on_conflict_do_update(
                    index_elements=["id"], set_={"name": office.name, "join_code": office.join_code}))
        except IntegrityError as exc:
            if violated_constraint(exc) == "uq_offices_join_code":
                raise JoinCodeCollisionError() from None
            raise
        if U(office.id) not in self._c._offices:
            self._c.adopt_new_office(U(office.id))   # novo (invisível até o COMMIT) ou já travado

    # ------------------------------------------------------------ vínculos
    def membership_of_user(self, user_id: str) -> Membership | None:
        uid = U(user_id)
        if uid is None:
            return None
        for _ in range(3):
            pre = self._one(select(memberships.c.office_id).where(memberships.c.user_id == uid))
            if pre is None:
                return None
            if self._c.now_captured and pre.office_id not in self._c.anchored_offices:
                # Vínculo em escritório NÃO travado por esta operação, consultado depois do relógio
                # (ex.: a pessoa já está em OUTRO escritório; responsável de fora numa reatribuição).
                # Leitura do estado confirmado, sem bloqueio: mudar vínculo NESTE escritório exige a
                # âncora que a operação já segura; o vínculo único é garantido pela PK de memberships
                # e ingressos da mesma pessoa se serializam pela âncora pessoal.
                row = self._one(select(memberships).where(memberships.c.user_id == uid))
                return membership_out(row) if row else None
            self._c.anchor_office(pre.office_id)
            row = self._one(select(memberships).where(memberships.c.user_id == uid))
            if row is None or self._c.read_only or row.office_id == pre.office_id:
                return membership_out(row) if row else None
        return membership_out(row) if row else None                      # pragma: no cover

    def members_of(self, office_id: str) -> list[Membership]:
        oid = U(office_id)
        if oid is None:
            return []
        self._c.anchor_office(oid)
        rows = self._c.conn.execute(select(memberships).where(memberships.c.office_id == oid).order_by(
            memberships.c.joined_at, memberships.c.user_id))
        return [membership_out(r) for r in rows]

    def count_admins(self, office_id: str) -> int:
        oid = U(office_id)
        if oid is None:
            return 0
        self._c.anchor_office(oid)
        return self._c.conn.execute(select(func.count()).select_from(memberships).where(
            memberships.c.office_id == oid, literal("office.manage") == any_(memberships.c.permissions))).scalar_one()

    def put_membership(self, membership: Membership) -> None:
        """Vínculo único por pessoa: se, sob concorrência, a pessoa já entrou em OUTRO escritório,
        o upsert não altera nada e a operação recusa com 409 `already_in_office`."""
        self._c.require_write()
        cols = membership_cols(membership)
        self._c.anchor_office(cols["office_id"])
        ins = pg_insert(memberships).values(**cols)
        upsert = ins.on_conflict_do_update(
            index_elements=["user_id"],
            set_={k: ins.excluded[k] for k in ("role_label", "practice_areas", "permissions", "visibility")},
            where=memberships.c.office_id == ins.excluded.office_id,
        ).returning(memberships.c.user_id)
        if self._c.conn.execute(upsert).first() is None:
            raise DomainConflictError("already_in_office", "A pessoa já participa de outro escritório.")

    def delete_membership(self, user_id: str) -> None:
        if not self._c.allow_membership_delete:
            raise RuntimeError("remoção de vínculo exige a unidade de trabalho com prazos")
        m = self.membership_of_user(user_id)            # trava a âncora do escritório
        if m is None:
            return
        self._c.conn.execute(memberships.delete().where(memberships.c.user_id == U(user_id)))
        self._c.removed_member_offices.add(U(m.office_id))

    # ------------------------------------------------------------ convites
    def _invitation(self, where) -> Invitation | None:
        pre = self._one(select(invitations.c.id, invitations.c.office_id).where(where))
        if pre is None:
            return None
        self._c.anchor_office(pre.office_id)
        row = self._one(select(invitations).where(invitations.c.id == pre.id))
        return invitation_out(row) if row else None

    def get_invitation(self, invitation_id: str) -> Invitation | None:
        iid = U(invitation_id)
        return self._invitation(invitations.c.id == iid) if iid else None

    def get_invitation_by_hash(self, token_hash: str) -> Invitation | None:
        return self._invitation(invitations.c.token_hash == token_hash)

    def invitations_of(self, office_id: str) -> list[Invitation]:
        oid = U(office_id)
        if oid is None:
            return []
        self._c.anchor_office(oid)
        rows = self._c.conn.execute(select(invitations).where(invitations.c.office_id == oid).order_by(
            invitations.c.created_at.desc(), invitations.c.id))
        return [invitation_out(r) for r in rows]

    def put_invitation(self, invitation: Invitation) -> None:
        self._c.require_write()
        cols = invitation_cols(invitation)
        self._c.anchor_office(cols["office_id"])
        self._c.conn.execute(pg_insert(invitations).values(**cols).on_conflict_do_update(
            index_elements=["id"], set_={"status": invitation.status, "closed_at": invitation.closed_at}))

    # ------------------------------------------------------------ solicitações
    def get_request(self, request_id: str) -> JoinRequest | None:
        rid = U(request_id)
        if rid is None:
            return None
        pre = self._one(select(join_requests.c.office_id).where(join_requests.c.id == rid))
        if pre is None:
            return None
        self._c.anchor_office(pre.office_id)
        row = self._one(select(join_requests).where(join_requests.c.id == rid))
        return request_out(row) if row else None

    def requests_of_office(self, office_id: str) -> list[JoinRequest]:
        oid = U(office_id)
        if oid is None:
            return []
        self._c.anchor_office(oid)
        rows = self._c.conn.execute(select(join_requests).where(join_requests.c.office_id == oid).order_by(
            join_requests.c.created_at.desc(), join_requests.c.id))
        return [request_out(r) for r in rows]

    def requests_of_user(self, user_id: str) -> list[JoinRequest]:
        """Pendências da PESSOA (vários escritórios): trava a âncora pessoal (depois das de escritório)."""
        uid = U(user_id)
        if uid is None:
            return []
        self._c.anchor_user(uid)
        rows = self._c.conn.execute(select(join_requests).where(join_requests.c.user_id == uid).order_by(
            join_requests.c.created_at.desc(), join_requests.c.id))
        return [request_out(r) for r in rows]

    def put_request(self, request: JoinRequest) -> None:
        self._c.require_write()
        cols = request_cols(request)
        self._c.conn.execute(pg_insert(join_requests).values(**cols).on_conflict_do_update(
            index_elements=["id"], set_={"status": request.status, "decided_at": request.decided_at,
                                         "decided_by": cols["decided_by"]}))


_unused = (and_, exists, update)

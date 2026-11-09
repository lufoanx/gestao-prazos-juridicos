"""Casos de uso de escritórios, equipe, convites e solicitações (Etapa 3).

Padrão de TODA operação protegida:
1. limites de taxa (antes de qualquer trabalho);
2. abrir transação;
3. ler o vínculo ATUAL do ator e do alvo dentro da transação;
4. aplicar as políticas puras (app/policies/org.py) e as invariantes;
5. só então escrever (nenhuma escrita antes de todas as verificações).

A autoridade nunca vem do JWT nem do corpo da requisição: userId/officeId/permissões
enviados pelo cliente só identificam ALVOS, sempre revalidados contra o estado.
"""
from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass, replace
from datetime import timedelta

from app.core.clock import Clock
from app.core.errors import AppError
from app.core.logging import get_logger
from app.domain.auth import User
from app.domain.org import (
    ADMIN_PERMISSIONS,
    JOIN_CODE_ALPHABET,
    JOIN_CODE_LENGTH,
    MEMBER_PERMISSIONS,
    Invitation,
    InvitationState,
    JoinRequest,
    Membership,
    Office,
)
from app.policies import org as policy
from app.repositories.auth import UserRepository
from app.repositories.org import OrgRepository, OrgTransaction
from app.security.rate_limit import RateLimiter
from app.security.tokens import hash_opaque_token, new_opaque_token
from app.services.responsibility_port import ResponsibilityModuleUnavailableError, ResponsibilityPort

logger = get_logger("prazoai.org")

_CODE_ATTEMPTS = 32


def _raise(denial: policy.Denial) -> None:
    raise AppError(denial.status, denial.code, denial.message)


def _rate_limited(retry: int) -> AppError:
    return AppError(
        429, "rate_limited", "Muitas solicitações. Tente novamente mais tarde.", headers={"Retry-After": str(retry)}
    )


def new_join_code() -> str:
    return "".join(secrets.choice(JOIN_CODE_ALPHABET) for _ in range(JOIN_CODE_LENGTH))


@dataclass(frozen=True)
class OrgLimits:
    invite_ttl_seconds: int
    max_pending_invites_per_office: int
    max_pending_requests_per_office: int
    max_pending_requests_per_user: int


@dataclass(frozen=True)
class MemberEntry:
    membership: Membership
    user: User | None


@dataclass(frozen=True)
class RequestEntry:
    request: JoinRequest
    user: User | None


class OrgService:
    def __init__(
        self,
        *,
        repo: OrgRepository,
        users: UserRepository,
        clock: Clock,
        responsibilities: ResponsibilityPort,
        limits: OrgLimits,
        invite_create_limiter: RateLimiter,
        invite_lookup_limiter: RateLimiter,
        invite_accept_limiter: RateLimiter,
        join_request_limiter: RateLimiter,
    ) -> None:
        self._repo = repo
        self._users = users
        self._clock = clock
        self._resp = responsibilities
        self._limits = limits
        self._invite_create_limiter = invite_create_limiter
        self._invite_lookup_limiter = invite_lookup_limiter
        self._invite_accept_limiter = invite_accept_limiter
        self._join_request_limiter = join_request_limiter

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _limit(limiter: RateLimiter, *keys: str) -> None:
        for key in keys:
            retry = limiter.check_and_hit(key)
            if retry is not None:
                raise _rate_limited(retry)

    @staticmethod
    def _actor_in(tx: OrgTransaction, actor_id: str, office_id: str) -> tuple[Office, Membership]:
        """Vínculo atual do ator NESTE escritório; caso contrário 404 (não revela existência)."""
        actor = tx.membership_of_user(actor_id)
        office = tx.get_office(office_id) if actor is not None else None
        if actor is None or office is None or actor.office_id != office_id:
            _raise(policy.NOT_FOUND)
        assert actor is not None and office is not None
        return office, actor

    @staticmethod
    def _target_in(tx: OrgTransaction, office_id: str, user_id: str) -> Membership:
        target = tx.membership_of_user(user_id)
        if target is None or target.office_id != office_id:
            _raise(policy.NOT_FOUND)
        assert target is not None
        return target

    @staticmethod
    def _cancel_pending_of(tx: OrgTransaction, user_id: str, except_id: str | None = None) -> int:
        """Ao entrar em um escritório, as demais pendências da pessoa viram `cancelled`."""
        n = 0
        for req in tx.requests_of_user(user_id):
            if req.status == "pending" and req.id != except_id:
                tx.put_request(replace(req, status="cancelled", decided_at=tx.now, decided_by=None))
                n += 1
        return n

    def _new_code(self, tx: OrgTransaction) -> str:
        for _ in range(_CODE_ATTEMPTS):
            code = new_join_code()
            if not tx.code_in_use(code):
                return code
        raise AppError(503, "join_code_unavailable", "Não foi possível gerar um código. Tente novamente.")

    def user_of(self, user_id: str) -> User | None:
        return self._users.get_by_id(user_id)

    # ---------------------------------------------------------------- escritório
    def create_office(
        self, actor_id: str, name: str, role_label: str, practice_areas: tuple[str, ...]
    ) -> tuple[Office, Membership]:
        with self._repo.transaction(self._clock) as tx:
            now = tx.now  # instante obtido após o lock
            if tx.membership_of_user(actor_id) is not None:
                raise AppError(409, "already_in_office", "Você já participa de um escritório.")
            office = Office(
                id=uuid.uuid4().hex, name=name, created_by=actor_id, created_at=now, join_code=self._new_code(tx)
            )
            membership = Membership(
                user_id=actor_id, office_id=office.id, role_label=role_label, practice_areas=practice_areas,
                permissions=ADMIN_PERMISSIONS, visibility="all", joined_at=now,
            )
            tx.put_office(office)
            tx.put_membership(membership)
            self._cancel_pending_of(tx, actor_id)
        logger.info("org_office_created office_id=%s", office.id)
        return office, membership

    def current(self, actor_id: str) -> tuple[Office | None, Membership | None]:
        with self._repo.transaction(self._clock) as tx:
            m = tx.membership_of_user(actor_id)
            return (tx.get_office(m.office_id), m) if m else (None, None)

    def get_office(self, actor_id: str, office_id: str) -> Office:
        with self._repo.transaction(self._clock) as tx:
            office, _ = self._actor_in(tx, actor_id, office_id)
            return office

    def update_office(self, actor_id: str, office_id: str, name: str) -> Office:
        with self._repo.transaction(self._clock) as tx:
            office, actor = self._actor_in(tx, actor_id, office_id)
            if (d := policy.can_manage_office(actor)):
                _raise(d)
            office = replace(office, name=name)
            tx.put_office(office)
            return office

    # -------------------------------------------------------------------- equipe
    def list_members(self, actor_id: str, office_id: str) -> tuple[Membership, list[MemberEntry]]:
        with self._repo.transaction(self._clock) as tx:
            _, actor = self._actor_in(tx, actor_id, office_id)
            members = sorted(tx.members_of(office_id), key=lambda m: (m.joined_at, m.user_id))
        return actor, [MemberEntry(m, self.user_of(m.user_id)) for m in members]

    def update_member(
        self,
        actor_id: str,
        office_id: str,
        target_id: str,
        *,
        role_label: str | None = None,
        practice_areas: tuple[str, ...] | None = None,
        visibility: str | None = None,
        permissions: frozenset[str] | None = None,
    ) -> tuple[Membership, MemberEntry]:
        with self._repo.transaction(self._clock) as tx:
            _, actor = self._actor_in(tx, actor_id, office_id)
            target = self._target_in(tx, office_id, target_id)
            denial = policy.check_member_change(
                actor, target, new_permissions=permissions, new_visibility=visibility,
                admins_in_office=tx.count_admins(office_id),
            )
            if denial:
                _raise(denial)
            updated = replace(
                target,
                role_label=role_label if role_label is not None else target.role_label,
                practice_areas=practice_areas if practice_areas is not None else target.practice_areas,
                visibility=visibility if visibility is not None else target.visibility,  # type: ignore[arg-type]
                permissions=permissions if permissions is not None else target.permissions,
            )
            tx.put_membership(updated)
            actor_after = updated if actor.user_id == updated.user_id else actor
        logger.info("org_member_updated office_id=%s target=%s actor=%s", office_id, target_id, actor_id)
        return actor_after, MemberEntry(updated, self.user_of(target_id))

    def promote(self, actor_id: str, office_id: str, target_id: str) -> tuple[Membership, MemberEntry]:
        with self._repo.transaction(self._clock) as tx:
            _, actor = self._actor_in(tx, actor_id, office_id)
            target = self._target_in(tx, office_id, target_id)
            if (d := policy.check_promote(actor, target)):
                _raise(d)
            new_perms = target.permissions | {"team.manage", "office.manage"}
            # Delegação: o administrador só concede o que possui (inclui team/office.manage).
            if new_perms - target.permissions - actor.permissions:
                _raise(policy.Denial(403, "delegation_not_allowed", "Permissões fora do seu alcance."))
            updated = replace(target, permissions=frozenset(new_perms))
            tx.put_membership(updated)
        logger.info("org_member_promoted office_id=%s target=%s actor=%s", office_id, target_id, actor_id)
        return actor, MemberEntry(updated, self.user_of(target_id))

    def _check_reassign_target(self, tx: OrgTransaction, office_id: str, leaving: str, to_user: str | None) -> str:
        if not to_user or to_user == leaving:
            raise AppError(409, "reassign_required", "Indique outro membro para receber as responsabilidades.")
        dest = tx.membership_of_user(to_user)
        if dest is None or dest.office_id != office_id:
            raise AppError(409, "reassign_required", "Indique outro membro para receber as responsabilidades.")
        return to_user

    def _responsibilities(self, office_id: str, user_id: str, tx: OrgTransaction, reassign_to: str | None) -> None:
        """Consulta e, se preciso, reatribui. Chamado APÓS as verificações e ANTES das escritas."""
        try:
            open_count = self._resp.count_open(office_id, user_id)
            if open_count > 0:
                dest = self._check_reassign_target(tx, office_id, user_id, reassign_to)
                self._resp.reassign_open(office_id, user_id, dest)
        except ResponsibilityModuleUnavailableError:
            raise AppError(
                409, "responsibility_module_unavailable",
                "Operação indisponível até a integração com o módulo de prazos.",
            ) from None

    def remove_member(self, actor_id: str, office_id: str, target_id: str, reassign_to: str | None) -> None:
        with self._repo.transaction(self._clock) as tx:
            _, actor = self._actor_in(tx, actor_id, office_id)
            target = self._target_in(tx, office_id, target_id)
            if (d := policy.check_remove(actor, target, tx.count_admins(office_id))):
                _raise(d)
            self._responsibilities(office_id, target_id, tx, reassign_to)
            tx.delete_membership(target_id)  # dados pessoais do usuário não são tocados
        logger.info("org_member_removed office_id=%s target=%s actor=%s", office_id, target_id, actor_id)

    def leave(self, actor_id: str, office_id: str, successor_id: str | None, reassign_to: str | None) -> None:
        with self._repo.transaction(self._clock) as tx:
            _, actor = self._actor_in(tx, actor_id, office_id)
            last_admin = actor.is_admin and tx.count_admins(office_id) <= 1
            successor: Membership | None = None
            if last_admin:
                successor = tx.membership_of_user(successor_id) if successor_id else None
                if successor is None or successor.office_id != office_id or successor.user_id == actor_id:
                    raise AppError(409, "successor_required", "Indique um membro como novo administrador.")
            self._responsibilities(office_id, actor_id, tx, reassign_to)
            if successor is not None:
                tx.put_membership(
                    replace(successor, permissions=frozenset(successor.permissions | {"team.manage", "office.manage"}))
                )
            tx.delete_membership(actor_id)
        logger.info("org_member_left office_id=%s actor=%s", office_id, actor_id)

    # ---------------------------------------------------------- código de ingresso
    def get_join_code(self, actor_id: str, office_id: str) -> str:
        with self._repo.transaction(self._clock) as tx:
            office, actor = self._actor_in(tx, actor_id, office_id)
            if (d := policy.can_manage_team(actor)):
                _raise(d)
            return office.join_code

    def rotate_join_code(self, actor_id: str, office_id: str) -> str:
        with self._repo.transaction(self._clock) as tx:
            office, actor = self._actor_in(tx, actor_id, office_id)
            if (d := policy.can_manage_team(actor)):
                _raise(d)
            office = replace(office, join_code=self._new_code(tx))
            tx.put_office(office)
        logger.info("org_join_code_rotated office_id=%s actor=%s", office_id, actor_id)
        return office.join_code

    # ------------------------------------------------------------------ convites
    def create_invitation(self, actor_id: str, office_id: str, role_label: str) -> tuple[Invitation, str]:
        self._limit(self._invite_create_limiter, f"user:{actor_id}")
        token = new_opaque_token()
        with self._repo.transaction(self._clock) as tx:
            now = tx.now  # instante obtido após o lock
            _, actor = self._actor_in(tx, actor_id, office_id)
            # Autoridade para conceder o conjunto de ingresso, verificada nesta transação.
            if (d := policy.can_grant_entry(actor)):
                _raise(d)
            pending = sum(1 for i in tx.invitations_of(office_id) if i.state(now) == "valid")
            if pending >= self._limits.max_pending_invites_per_office:
                raise AppError(409, "pending_limit_reached", "Limite de convites pendentes atingido.")
            invitation = Invitation(
                id=uuid.uuid4().hex,
                office_id=office_id,
                token_hash=hash_opaque_token(token),
                role_label=role_label,
                created_by=actor_id,
                created_at=now,
                expires_at=now + timedelta(seconds=self._limits.invite_ttl_seconds),
            )
            tx.put_invitation(invitation)
        logger.info("org_invitation_created office_id=%s invitation_id=%s", office_id, invitation.id)
        return invitation, token

    def list_invitations(self, actor_id: str, office_id: str) -> list[Invitation]:
        with self._repo.transaction(self._clock) as tx:
            _, actor = self._actor_in(tx, actor_id, office_id)
            if (d := policy.can_manage_team(actor)):
                _raise(d)
            return sorted(tx.invitations_of(office_id), key=lambda i: (i.created_at, i.id), reverse=True)

    def revoke_invitation(self, actor_id: str, office_id: str, invitation_id: str) -> Invitation:
        with self._repo.transaction(self._clock) as tx:
            now = tx.now  # instante obtido após o lock
            _, actor = self._actor_in(tx, actor_id, office_id)
            inv = tx.get_invitation(invitation_id)
            if inv is None or inv.office_id != office_id:
                _raise(policy.NOT_FOUND)
            assert inv is not None
            if (d := policy.can_manage_team(actor)):
                _raise(d)
            if inv.state(now) != "valid":
                raise AppError(409, "invitation_not_pending", "O convite não está mais pendente.")
            inv = replace(inv, status="revoked", closed_at=now)
            tx.put_invitation(inv)
        logger.info("org_invitation_revoked office_id=%s invitation_id=%s", office_id, invitation_id)
        return inv

    def lookup_invitation(self, token: str, client_ip: str) -> tuple[InvitationState, str | None]:
        self._limit(self._invite_lookup_limiter, f"ip:{client_ip}")
        with self._repo.transaction(self._clock) as tx:
            now = tx.now  # instante obtido após o lock
            inv = tx.get_invitation_by_hash(hash_opaque_token(token))
            if inv is None:
                return "invalid", None
            state = inv.state(now)
            office = tx.get_office(inv.office_id)
            if office is None:
                return "invalid", None
            return state, (office.name if state == "valid" else None)

    def accept_invitation(self, actor_id: str, token: str, client_ip: str) -> tuple[Office, Membership]:
        self._limit(self._invite_accept_limiter, f"ip:{client_ip}", f"user:{actor_id}")
        with self._repo.transaction(self._clock) as tx:
            now = tx.now  # instante obtido após o lock
            inv = tx.get_invitation_by_hash(hash_opaque_token(token))
            office = tx.get_office(inv.office_id) if inv else None
            if inv is None or office is None:
                raise AppError(404, "invitation_invalid", "Convite inválido.")
            state = inv.state(now)
            if state != "valid":
                raise AppError(410, f"invitation_{state}", "Convite indisponível.")
            if tx.membership_of_user(actor_id) is not None:
                raise AppError(409, "already_in_office", "Você já participa de um escritório.")
            membership = Membership(
                user_id=actor_id, office_id=office.id, role_label=inv.role_label, practice_areas=(),
                permissions=MEMBER_PERMISSIONS, visibility="assigned", joined_at=now,
            )
            tx.put_membership(membership)
            tx.put_invitation(replace(inv, status="accepted", closed_at=now))
            self._cancel_pending_of(tx, actor_id)
        logger.info("org_invitation_accepted office_id=%s invitation_id=%s", office.id, inv.id)
        return office, membership

    # ------------------------------------------------------------- solicitações
    def create_join_request(self, actor_id: str, code: str, client_ip: str) -> tuple[JoinRequest, Office]:
        self._limit(self._join_request_limiter, f"ip:{client_ip}", f"user:{actor_id}")
        with self._repo.transaction(self._clock) as tx:
            now = tx.now  # instante obtido após o lock
            office = tx.get_office_by_code(code)
            if office is None:
                raise AppError(404, "join_code_invalid", "Código de ingresso inválido.")
            if tx.membership_of_user(actor_id) is not None:
                raise AppError(409, "already_in_office", "Você já participa de um escritório.")
            mine = [r for r in tx.requests_of_user(actor_id) if r.status == "pending"]
            if any(r.office_id == office.id for r in mine):
                raise AppError(409, "request_already_pending", "Já existe uma solicitação pendente.")
            if len(mine) >= self._limits.max_pending_requests_per_user:
                raise AppError(409, "pending_limit_reached", "Limite de solicitações pendentes atingido.")
            office_pending = sum(1 for r in tx.requests_of_office(office.id) if r.status == "pending")
            if office_pending >= self._limits.max_pending_requests_per_office:
                raise AppError(409, "pending_limit_reached", "Limite de solicitações pendentes atingido.")
            request = JoinRequest(id=uuid.uuid4().hex, office_id=office.id, user_id=actor_id, created_at=now)
            tx.put_request(request)
        logger.info("org_join_request_created office_id=%s request_id=%s", office.id, request.id)
        return request, office

    def my_requests(self, actor_id: str) -> list[tuple[JoinRequest, str | None]]:
        with self._repo.transaction(self._clock) as tx:
            out = []
            for r in sorted(tx.requests_of_user(actor_id), key=lambda r: (r.created_at, r.id), reverse=True):
                office = tx.get_office(r.office_id)
                out.append((r, office.name if office else None))
            return out

    def cancel_request(self, actor_id: str, request_id: str) -> JoinRequest:
        with self._repo.transaction(self._clock) as tx:
            now = tx.now  # instante obtido após o lock
            req = tx.get_request(request_id)
            if req is None or req.user_id != actor_id:
                _raise(policy.NOT_FOUND)
            assert req is not None
            if req.status != "pending":
                raise AppError(409, "request_not_pending", "A solicitação não está mais pendente.")
            req = replace(req, status="cancelled", decided_at=now, decided_by=None)
            tx.put_request(req)
        return req

    def list_office_requests(self, actor_id: str, office_id: str, status: str | None) -> list[RequestEntry]:
        with self._repo.transaction(self._clock) as tx:
            _, actor = self._actor_in(tx, actor_id, office_id)
            if (d := policy.can_manage_team(actor)):
                _raise(d)
            reqs = [r for r in tx.requests_of_office(office_id) if status is None or r.status == status]
        reqs.sort(key=lambda r: (r.created_at, r.id), reverse=True)
        return [RequestEntry(r, self.user_of(r.user_id)) for r in reqs]

    def approve_request(self, actor_id: str, office_id: str, request_id: str) -> tuple[JoinRequest, Membership]:
        conflict = False
        with self._repo.transaction(self._clock) as tx:
            now = tx.now  # instante obtido após o lock
            _, actor = self._actor_in(tx, actor_id, office_id)
            req = tx.get_request(request_id)
            if req is None or req.office_id != office_id:
                _raise(policy.NOT_FOUND)
            assert req is not None
            # Aprovar concede o conjunto de ingresso: mesma autoridade exigida para convidar.
            if (d := policy.can_grant_entry(actor)):
                _raise(d)
            if req.status != "pending":
                raise AppError(409, "request_not_pending", "A solicitação não está mais pendente.")
            if tx.membership_of_user(req.user_id) is not None:
                # Conflito: a pessoa entrou em outro escritório → cancelled (não rejected).
                tx.put_request(replace(req, status="cancelled", decided_at=now, decided_by=None))
                conflict = True
            else:
                membership = Membership(
                    user_id=req.user_id, office_id=office_id, role_label="Membro", practice_areas=(),
                    permissions=MEMBER_PERMISSIONS, visibility="assigned", joined_at=now,
                )
                tx.put_membership(membership)
                req = replace(req, status="approved", decided_at=now, decided_by=actor_id)
                tx.put_request(req)
                self._cancel_pending_of(tx, req.user_id, except_id=req.id)
        if conflict:
            raise AppError(
                409, "already_in_office", "A pessoa já participa de outro escritório; solicitação cancelada."
            )
        logger.info("org_join_request_approved office_id=%s request_id=%s", office_id, request_id)
        return req, membership

    def reject_request(self, actor_id: str, office_id: str, request_id: str) -> JoinRequest:
        with self._repo.transaction(self._clock) as tx:
            now = tx.now  # instante obtido após o lock
            _, actor = self._actor_in(tx, actor_id, office_id)
            req = tx.get_request(request_id)
            if req is None or req.office_id != office_id:
                _raise(policy.NOT_FOUND)
            assert req is not None
            if (d := policy.can_manage_team(actor)):
                _raise(d)
            if req.status != "pending":
                raise AppError(409, "request_not_pending", "A solicitação não está mais pendente.")
            req = replace(req, status="rejected", decided_at=now, decided_by=actor_id)
            tx.put_request(req)
        logger.info("org_join_request_rejected office_id=%s request_id=%s", office_id, request_id)
        return req

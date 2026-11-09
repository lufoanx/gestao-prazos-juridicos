"""DTOs da Etapa 3 (camelCase, campos extras proibidos, nada descartado em silêncio)."""
from __future__ import annotations

import unicodedata
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, Field, model_validator

from app.domain.org import JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH
from app.schemas.auth import _Input, _Output

OFFICE_NAME_MIN, OFFICE_NAME_MAX = 2, 120
ROLE_LABEL_MAX = 60
PRACTICE_AREA_MAX = 60
PRACTICE_AREAS_MAX_ITEMS = 20
ID_MAX = 64

PermissionName = Literal[
    "deadline.read", "deadline.create", "deadline.edit", "deadline.complete",
    "deadline.transfer", "team.manage", "office.manage",
]
VisibilityName = Literal["all", "assigned"]


def _clean_text(value: str, *, field: str, min_len: int, max_len: int) -> str:
    text = " ".join(value.split())
    if len(text) < min_len:
        raise ValueError(f"{field} deve ter ao menos {min_len} caractere(s).")
    if len(text) > max_len:
        raise ValueError(f"{field} deve ter no máximo {max_len} caracteres.")
    if any(unicodedata.category(c).startswith("C") for c in text):
        raise ValueError(f"{field} contém caracteres inválidos.")
    return text


def _office_name(v: str) -> str:
    return _clean_text(v, field="Nome do escritório", min_len=OFFICE_NAME_MIN, max_len=OFFICE_NAME_MAX)


def _role_label(v: str) -> str:
    return _clean_text(v, field="Cargo", min_len=1, max_len=ROLE_LABEL_MAX)


def _practice_areas(values: list[str]) -> list[str]:
    cleaned = [_clean_text(v, field="Área de atuação", min_len=1, max_len=PRACTICE_AREA_MAX) for v in values]
    if len({c.casefold() for c in cleaned}) != len(cleaned):
        raise ValueError("Áreas de atuação repetidas.")
    return cleaned


def _permissions(values: list[str]) -> list[str]:
    if len(set(values)) != len(values):
        raise ValueError("Permissões repetidas.")
    return values


def _join_code(v: str) -> str:
    code = v.strip().upper().replace("-", "").replace(" ", "")
    if len(code) != JOIN_CODE_LENGTH or any(c not in JOIN_CODE_ALPHABET for c in code):
        raise ValueError("Código de ingresso em formato inválido.")
    return code


OfficeName = Annotated[str, Field(max_length=OFFICE_NAME_MAX * 2), AfterValidator(_office_name)]
RoleLabel = Annotated[str, Field(max_length=ROLE_LABEL_MAX * 2), AfterValidator(_role_label)]
PracticeAreas = Annotated[
    list[Annotated[str, Field(max_length=PRACTICE_AREA_MAX * 2)]],
    Field(max_length=PRACTICE_AREAS_MAX_ITEMS),
    AfterValidator(_practice_areas),
]
Permissions = Annotated[list[PermissionName], Field(min_length=1, max_length=7), AfterValidator(_permissions)]
UserRef = Annotated[str, Field(min_length=1, max_length=ID_MAX, pattern=r"^[A-Za-z0-9_-]+$")]
InviteToken = Annotated[str, Field(min_length=16, max_length=256)]
JoinCode = Annotated[str, Field(min_length=1, max_length=32), AfterValidator(_join_code)]


# ------------------------------------------------------------------ entradas
class CreateOfficeRequest(_Input):
    name: OfficeName
    role_label: RoleLabel = "Administrador"
    practice_areas: PracticeAreas = []


class UpdateOfficeRequest(_Input):
    name: OfficeName


class UpdateMemberRequest(_Input):
    """Ao menos um campo. Cargo, áreas, visibilidade e permissões são dimensões separadas."""

    role_label: RoleLabel | None = None
    practice_areas: PracticeAreas | None = None
    visibility: VisibilityName | None = None
    permissions: Permissions | None = None

    @model_validator(mode="after")
    def _at_least_one(self) -> UpdateMemberRequest:
        if all(v is None for v in (self.role_label, self.practice_areas, self.visibility, self.permissions)):
            raise ValueError("Informe ao menos um campo para alterar.")
        return self


class RemoveMemberRequest(_Input):
    reassign_to: UserRef | None = None


class LeaveOfficeRequest(_Input):
    successor_user_id: UserRef | None = None
    reassign_to: UserRef | None = None


class CreateInvitationRequest(_Input):
    role_label: RoleLabel = "Membro"


class InvitationTokenRequest(_Input):
    token: InviteToken


class CreateJoinRequestRequest(_Input):
    join_code: JoinCode


# ------------------------------------------------------------------- saídas
class OfficeView(_Output):
    id: str
    name: str
    created_at: datetime


class OwnMembershipView(_Output):
    office_id: str
    role_label: str
    practice_areas: list[str]
    permissions: list[str]
    visibility: str
    joined_at: datetime


class CurrentOfficeResponse(_Output):
    office: OfficeView | None
    membership: OwnMembershipView | None


class MemberPublicView(_Output):
    user_id: str
    name: str
    role_label: str
    practice_areas: list[str]


class MemberAdminView(MemberPublicView):
    email: str
    permissions: list[str]
    visibility: str
    joined_at: datetime


class MembersResponse(_Output):
    projection: Literal["public", "admin"]
    members: list[MemberAdminView | MemberPublicView]


class JoinCodeView(_Output):
    join_code: str


class InvitationAdminView(_Output):
    id: str
    role_label: str
    state: str
    created_at: datetime
    expires_at: datetime
    closed_at: datetime | None = None


class InvitationCreatedView(InvitationAdminView):
    token: str  # devolvido UMA vez, só nesta resposta


class InvitationLookupView(_Output):
    state: str
    office_name: str | None = None


class OwnJoinRequestView(_Output):
    id: str
    office_name: str | None
    status: str
    created_at: datetime
    decided_at: datetime | None = None


class RequesterView(_Output):
    user_id: str
    name: str
    email: str


class OfficeJoinRequestView(_Output):
    id: str
    requester: RequesterView | None
    status: str
    created_at: datetime
    decided_at: datetime | None = None

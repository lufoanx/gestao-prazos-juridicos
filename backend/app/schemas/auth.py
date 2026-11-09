"""DTOs de autenticação e perfil (camelCase, campos extras proibidos)."""
from __future__ import annotations

import unicodedata
from datetime import datetime
from typing import Annotated

from email_validator import EmailNotValidError, validate_email
from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.domain.auth import User

PASSWORD_MIN = 8
PASSWORD_MAX = 128
NAME_MAX = 120
EMAIL_MAX = 254


def normalize_email(value: str) -> str:
    """Normalização única: remove espaços externos, valida sintaxe e usa minúsculas.

    E-mails são tratados como insensíveis a maiúsculas para unicidade e login.
    """
    candidate = value.strip()
    if not candidate or len(candidate) > EMAIL_MAX:
        raise ValueError("E-mail inválido.")
    try:
        result = validate_email(candidate, check_deliverability=False)
    except EmailNotValidError:
        raise ValueError("E-mail inválido.") from None
    return result.normalized.lower()


def validate_name(value: str) -> str:
    name = " ".join(value.split())
    if not name:
        raise ValueError("Nome obrigatório.")
    if len(name) > NAME_MAX:
        raise ValueError(f"Nome deve ter no máximo {NAME_MAX} caracteres.")
    if any(unicodedata.category(c).startswith("C") for c in name):
        raise ValueError("Nome contém caracteres inválidos.")
    return name


def validate_password(value: str) -> str:
    # Sem truncamento nem alteração da senha: apenas aceita ou rejeita.
    if len(value) < PASSWORD_MIN:
        raise ValueError(f"A senha deve ter pelo menos {PASSWORD_MIN} caracteres.")
    if len(value) > PASSWORD_MAX:
        raise ValueError(f"A senha deve ter no máximo {PASSWORD_MAX} caracteres.")
    if not value.strip():
        raise ValueError("A senha não pode ser composta só de espaços.")
    return value


Email = Annotated[str, Field(max_length=EMAIL_MAX * 2), AfterValidator(normalize_email)]
Name = Annotated[str, Field(max_length=NAME_MAX * 2), AfterValidator(validate_name)]
# max_length no Field é só uma trava de tamanho bruto; a regra exata está em validate_password.
NewPassword = Annotated[str, Field(max_length=PASSWORD_MAX * 4), AfterValidator(validate_password)]
LoginPassword = Annotated[str, Field(min_length=1, max_length=PASSWORD_MAX * 4)]
OpaqueToken = Annotated[str, Field(min_length=16, max_length=256)]


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=False)


class _Output(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class RegisterRequest(_Input):
    name: Name
    email: Email
    password: NewPassword


class LoginRequest(_Input):
    email: Email
    password: LoginPassword


class RefreshRequest(_Input):
    refresh_token: OpaqueToken


class ForgotPasswordRequest(_Input):
    email: Email


class ResetPasswordRequest(_Input):
    token: OpaqueToken
    new_password: NewPassword


class UpdateMeRequest(_Input):
    """Somente `name`. E-mail, senha, permissões, escritório e preferências não são aceitos."""

    name: Name


class PublicUser(_Output):
    id: str
    name: str
    email: str
    created_at: datetime

    @classmethod
    def from_user(cls, user: User) -> PublicUser:
        """Projeção pública explícita (whitelist): nunca inclui o hash da senha."""
        return cls(id=user.id, name=user.name, email=user.email, created_at=user.created_at)


class MeResponse(_Output):
    user: PublicUser


class TokenResponse(_Output):
    access_token: str
    refresh_token: str
    token_type: str = "Bearer"
    expires_in: int


class LoginResponse(TokenResponse):
    user: PublicUser


class MessageResponse(_Output):
    message: str

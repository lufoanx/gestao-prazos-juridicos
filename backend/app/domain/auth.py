"""Entidades de autenticação (sem ORM). Ver docs/backend/03-modelo-de-dominio.md."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class User:
    id: str
    name: str
    email: str  # normalizado (minúsculas); âncora de identidade, imutável pelo perfil
    password_hash: str  # Argon2id — nunca exposto em respostas ou logs
    created_at: datetime

    def __repr__(self) -> str:  # evita vazar o hash em logs/tracebacks
        return f"User(id={self.id!r})"


@dataclass
class AuthSession:
    """Família de sessão: um login gera uma sessão; refresh tokens giram dentro dela."""

    id: str
    user_id: str
    created_at: datetime
    expires_at: datetime  # vida máxima absoluta (a rotação não estende)
    current_refresh_hash: str
    used_refresh_hashes: set[str] = field(default_factory=set)
    revoked_at: datetime | None = None

    @property
    def revoked(self) -> bool:
        return self.revoked_at is not None

    def __repr__(self) -> str:
        return f"AuthSession(id={self.id!r}, user_id={self.user_id!r}, revoked={self.revoked})"


@dataclass
class PasswordResetToken:
    token_hash: str  # SHA-256 do token; o token em claro nunca é armazenado
    user_id: str
    created_at: datetime
    expires_at: datetime
    used_at: datetime | None = None
    invalidated_at: datetime | None = None

    def __repr__(self) -> str:
        return f"PasswordResetToken(user_id={self.user_id!r})"

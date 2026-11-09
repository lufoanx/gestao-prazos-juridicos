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
    # Incrementada a cada troca de senha (redefinição). Sessões guardam a versão com que
    # foram criadas; versão divergente = credencial antiga = sessão inválida.
    # O rehash (mesma senha, novos parâmetros) NÃO altera a versão.
    credential_version: int = 0

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
    credential_version: int  # versão da credencial do usuário no momento do login
    used_refresh_hashes: set[str] = field(default_factory=set)
    revoked_at: datetime | None = None

    @property
    def revoked(self) -> bool:
        return self.revoked_at is not None

    @property
    def rotation_count(self) -> int:
        return len(self.used_refresh_hashes)

    def view(self) -> SessionView:
        """Projeção sem o histórico de hashes (o serviço não precisa dele)."""
        return SessionView(
            id=self.id,
            user_id=self.user_id,
            created_at=self.created_at,
            expires_at=self.expires_at,
            credential_version=self.credential_version,
            rotation_count=self.rotation_count,
            revoked=self.revoked,
        )

    def __repr__(self) -> str:
        return f"AuthSession(id={self.id!r}, user_id={self.user_id!r}, revoked={self.revoked})"


@dataclass(frozen=True)
class SessionView:
    """Dados de uma sessão expostos pelo repositório ao serviço (sem tokens nem histórico)."""

    id: str
    user_id: str
    created_at: datetime
    expires_at: datetime
    credential_version: int
    rotation_count: int
    revoked: bool


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

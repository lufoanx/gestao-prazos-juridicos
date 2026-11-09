"""Interfaces de repositório de autenticação (contrato para a futura persistência).

A implementação atual é EM MEMÓRIA (app/repositories/memory.py). Uma implementação com
banco deverá oferecer as mesmas garantias de atomicidade (unicidade de e-mail, rotação
de refresh token e consumo de token de recuperação), por exemplo com restrições UNIQUE
e transações.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Protocol

from app.domain.auth import AuthSession, PasswordResetToken, User


class EmailAlreadyRegisteredError(Exception):
    """E-mail já cadastrado (unicidade)."""


class UserRepository(Protocol):
    def add(self, user: User) -> None:
        """Insere o usuário. Levanta EmailAlreadyRegisteredError de forma atômica."""
        ...

    def get_by_id(self, user_id: str) -> User | None: ...

    def get_by_email(self, email: str) -> User | None: ...

    def update_name(self, user_id: str, name: str) -> User | None: ...

    def update_password_hash(self, user_id: str, password_hash: str) -> bool: ...


class RotationResult(Enum):
    ROTATED = "rotated"
    INVALID = "invalid"   # desconhecido, expirado ou sessão revogada
    REUSED = "reused"     # token já utilizado: família revogada


class SessionRepository(Protocol):
    def add(self, session: AuthSession) -> None: ...

    def get(self, session_id: str) -> AuthSession | None: ...

    def rotate_refresh(
        self, refresh_hash: str, new_refresh_hash: str, now: datetime
    ) -> tuple[RotationResult, AuthSession | None]:
        """Troca atomicamente o refresh token atual por um novo; detecta reutilização."""
        ...

    def revoke(self, session_id: str, now: datetime) -> bool: ...

    def revoke_all_for_user(self, user_id: str, now: datetime) -> int: ...


class PasswordResetRepository(Protocol):
    def add(self, token: PasswordResetToken) -> None: ...

    def consume(self, token_hash: str, now: datetime) -> PasswordResetToken | None:
        """Marca o token como usado de forma atômica; None se inválido/expirado/usado."""
        ...

    def invalidate_all_for_user(self, user_id: str, now: datetime) -> int: ...

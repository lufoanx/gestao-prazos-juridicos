"""Hash de senha com Argon2id (argon2-cffi). Nenhuma criptografia própria."""
from __future__ import annotations

import secrets

from argon2 import PasswordHasher as _Argon2Hasher
from argon2 import Type
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError


class PasswordHasher:
    """Wrapper fino sobre argon2-cffi com Argon2id e parâmetros padrão da biblioteca (RFC 9106)."""

    def __init__(self, hasher: _Argon2Hasher | None = None) -> None:
        self._h = hasher or _Argon2Hasher(type=Type.ID)
        if self._h.type is not Type.ID:
            raise ValueError("Somente Argon2id é permitido.")
        # Hash fictício para equalizar o custo quando o usuário não existe.
        self._dummy_hash = self._h.hash(secrets.token_urlsafe(32))

    def hash(self, password: str) -> str:
        return self._h.hash(password)

    def verify(self, password_hash: str, password: str) -> bool:
        try:
            return self._h.verify(password_hash, password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

    def verify_dummy(self, password: str) -> None:
        """Executa uma verificação de custo equivalente e descarta o resultado."""
        self.verify(self._dummy_hash, password)

    def needs_rehash(self, password_hash: str) -> bool:
        try:
            return self._h.check_needs_rehash(password_hash)
        except InvalidHashError:
            return False

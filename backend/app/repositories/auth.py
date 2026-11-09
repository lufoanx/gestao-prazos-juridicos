"""Interfaces de repositório de autenticação (contrato para a futura persistência).

A implementação atual é EM MEMÓRIA (app/repositories/memory.py). Uma implementação com
banco deverá oferecer as MESMAS garantias de atomicidade, por exemplo:
- unicidade de e-mail (restrição UNIQUE);
- criação de sessão condicionada à versão da credencial
  (`INSERT ... SELECT ... WHERE users.credential_version = :v`, na mesma transação);
- rehash condicionado à versão (`UPDATE ... WHERE credential_version = :v`);
- rotação de refresh token e consumo de token de recuperação em transação;
- redefinição de senha como UMA transação (consumo + credencial + tokens + sessões);
- no máximo um token de recuperação ativo por usuário (substituição em transação).
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Protocol

from app.domain.auth import AuthSession, PasswordResetToken, SessionView, User


class EmailAlreadyRegisteredError(Exception):
    """E-mail já cadastrado (unicidade)."""


class UserRepository(Protocol):
    def add(self, user: User) -> None:
        """Insere o usuário. Levanta EmailAlreadyRegisteredError de forma atômica."""
        ...

    def get_by_id(self, user_id: str) -> User | None: ...

    def get_by_email(self, email: str) -> User | None: ...

    def update_name(self, user_id: str, name: str) -> User | None: ...

    def update_password_hash_if_version(self, user_id: str, password_hash: str, expected_version: int) -> bool:
        """Rehash condicional: grava só se a versão da credencial ainda for `expected_version`.

        Não altera a versão (a senha é a mesma). Retorna False se a credencial mudou.
        """
        ...


class RotationResult(Enum):
    ROTATED = "rotated"
    INVALID = "invalid"   # desconhecido, expirado, sessão revogada ou credencial alterada
    REUSED = "reused"     # token já utilizado: família revogada
    LIMIT_REACHED = "limit_reached"  # teto de rotações da sessão atingido: sessão encerrada


class SessionRepository(Protocol):
    def add_if_credentials_current(self, session: AuthSession) -> bool:
        """Cria a sessão SOMENTE se `session.credential_version` ainda for a versão atual
        do usuário (verificação e inserção atômicas). Aplica o limite de sessões por usuário."""
        ...

    def get(self, session_id: str) -> SessionView | None:
        """Dados públicos da sessão, SEM copiar o histórico de hashes."""
        ...

    def rotate_refresh(
        self, refresh_hash: str, new_refresh_hash: str, now: datetime
    ) -> tuple[RotationResult, SessionView | None]:
        """Troca atomicamente o refresh token atual por um novo; detecta reutilização.

        Política de histórico finito: cada sessão aceita no máximo `max_rotations`
        rotações. Ao apresentar o token atual de uma sessão que já girou esse número de
        vezes, a sessão é ENCERRADA (revogada) e o resultado é LIMIT_REACHED — o cliente
        precisa fazer novo login. Nenhum hash de token antigo é descartado enquanto a
        família existir; o histórico (≤ teto) é liberado só quando a sessão expira.
        Em banco: contador de rotações na própria linha da sessão, atualizado na mesma
        transação da troca de token (UPDATE ... WHERE rotation_count < :max).
        """
        ...

    def revoke(self, session_id: str, now: datetime) -> bool: ...

    def revoke_all_for_user(self, user_id: str, now: datetime) -> int: ...

    def purge_expired(self, now: datetime) -> int:
        """Remove sessões cuja vida absoluta terminou (e os índices de seus tokens)."""
        ...


class PasswordResetRepository(Protocol):
    def issue_replacing_active(self, token: PasswordResetToken, now: datetime) -> None:
        """Invalida os tokens ativos do usuário E registra o novo, atomicamente
        (no máximo um token ativo por usuário)."""
        ...

    def is_active(self, token_hash: str, now: datetime) -> bool:
        """Pré-validação SEM consumir (evita trabalho caro com token inválido).
        Não substitui a revalidação atômica em `complete_reset`."""
        ...

    def complete_reset(self, token_hash: str, new_password_hash: str, now: datetime) -> str | None:
        """Operação completa e atômica: revalida e consome o token, troca o hash e
        incrementa a versão da credencial, invalida os demais tokens e revoga todas as
        sessões do usuário. Retorna o user_id, ou None se o token não estiver ativo."""
        ...

    def purge_expired(self, now: datetime) -> int:
        """Remove tokens usados, invalidados ou expirados."""
        ...

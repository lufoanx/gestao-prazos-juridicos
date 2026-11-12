"""Apoio aos testes de autenticação SQL: repositórios sobre o banco autorizado e gates de concorrência."""
from __future__ import annotations

import hashlib
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from app.domain.auth import AuthSession, PasswordResetToken, User

PASSWORD_HASH = "$argon2id$v=19$m=65536,t=3,p=4$fake$fake"     # não é um hash real (repositório não verifica)


def new_user(email: str | None = None, **over) -> User:
    uid = uuid.uuid4().hex
    data = dict(id=uid, name="Usuária", email=email or f"u-{uid[:8]}@x.com", password_hash=PASSWORD_HASH,
                created_at=datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc))
    data.update(over)
    return User(**data)


def new_session(user: User, now: datetime, refresh_hash: str, *, ttl: int = 3600,
                version: int | None = None) -> AuthSession:
    return AuthSession(id=uuid.uuid4().hex, user_id=user.id, created_at=now, expires_at=now + timedelta(seconds=ttl),
                       current_refresh_hash=refresh_hash,
                       credential_version=user.credential_version if version is None else version)


def h(n: int | str) -> str:
    """Hash fictício e determinístico de 64 hex (formato SHA-256) para refresh/reset."""
    return hashlib.sha256(f"teste:{n}".encode()).hexdigest()


def new_reset(user: User, now: datetime, token_hash: str, ttl: int = 1800) -> PasswordResetToken:
    return PasswordResetToken(token_hash=token_hash, user_id=user.id, created_at=now,
                              expires_at=now + timedelta(seconds=ttl))


@dataclass
class Gates:
    """Pontos de controle determinísticos: pausar uma thread num ponto nomeado ou falhar ali.

    `pause_at(nome)` → quando uma thread chega ao ponto, sinaliza `reached[nome]` e espera `release(nome)`.
    `fail_at(nome)` → lança RuntimeError no ponto (falha injetada antes do COMMIT).
    """
    reached: dict[str, threading.Event] = field(default_factory=dict)
    released: dict[str, threading.Event] = field(default_factory=dict)
    failing: set[str] = field(default_factory=set)
    once: set[str] = field(default_factory=set)

    def pause_at(self, name: str, *, once: bool = True) -> None:
        self.reached[name] = threading.Event()
        self.released[name] = threading.Event()
        if once:
            self.once.add(name)

    def fail_at(self, name: str) -> None:
        self.failing.add(name)

    def wait_reached(self, name: str, timeout: float = 10) -> None:
        assert self.reached[name].wait(timeout), f"ninguém chegou a {name}"

    def release(self, name: str) -> None:
        self.released[name].set()

    def __call__(self, name: str) -> None:
        if name in self.failing:
            raise RuntimeError(f"falha injetada em {name}")
        if name in self.reached and not self.reached[name].is_set():
            self.reached[name].set()
            assert self.released[name].wait(15), f"{name} não foi liberado"


class Runner(threading.Thread):
    """Thread que guarda o resultado ou a exceção da função executada."""

    def __init__(self, fn, *args, **kwargs) -> None:
        super().__init__(daemon=True)
        self.fn, self.args, self.kwargs = fn, args, kwargs
        self.result = None
        self.error: BaseException | None = None

    def run(self) -> None:
        try:
            self.result = self.fn(*self.args, **self.kwargs)
        except BaseException as exc:  # noqa: BLE001 — devolvido ao teste
            self.error = exc

    def join_result(self, timeout: float = 20):
        self.join(timeout)
        assert not self.is_alive(), "thread não terminou (possível bloqueio)"
        if self.error:
            raise self.error
        return self.result


def backend_pid(conn) -> int:
    """PID do processo do PostgreSQL que atende esta conexão."""
    return conn.connection.dbapi_connection.info.backend_pid


def wait_for_lock_waiter(engine, *, blocked_by: int | None = None, timeout: float = 10.0) -> int:
    """Espera até o PostgreSQL MOSTRAR um processo aguardando bloqueio (`wait_event_type='Lock'`).

    Com `blocked_by`, exige que esse PID esteja entre os que bloqueiam o processo (pg_blocking_pids).
    É a coordenação: o teste só avança o relógio ou libera depois de VER a espera no banco. O
    `timeout` serve apenas de proteção contra travamento, não para ordenar as operações.
    """
    import time

    from sqlalchemy import text

    query = text(
        "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() "
        "AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0 "
        "AND (CAST(:holder AS integer) IS NULL OR CAST(:holder AS integer) = ANY(pg_blocking_pids(pid))) "
        "ORDER BY pid LIMIT 1"
    )
    deadline = time.monotonic() + timeout
    with engine.connect() as observer:
        while time.monotonic() < deadline:
            pid = observer.execute(query, {"holder": blocked_by}).scalar_one_or_none()
            observer.rollback()                       # cada leitura num snapshot novo
            if pid is not None:
                return pid
            time.sleep(0.02)
    raise AssertionError("nenhuma operação ficou esperando o bloqueio pretendido (proteção contra travamento)")


@contextmanager
def control_connection(engine):
    """Conexão de CONTROLE do teste (segura bloqueios). Em qualquer saída, inclusive asserção que
    falhou: ROLLBACK e fechamento, para nunca deixar bloqueios ou conexões pendentes."""
    conn = engine.connect()
    try:
        yield conn
    finally:
        try:
            conn.rollback()
        finally:
            conn.close()

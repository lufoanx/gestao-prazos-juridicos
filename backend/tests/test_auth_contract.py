"""Contrato COMUM dos repositórios de autenticação: memória e PostgreSQL passam pelos mesmos testes.

A variante `postgres` usa o banco descartável autorizado pela fixture protegida (pulada sem
TEST_DATABASE_URL; obrigatória no CI). Diferença intencional e documentada: no PostgreSQL o instante
da operação vem do relógio capturado DEPOIS dos bloqueios (doc 15, §4.6); aqui o relógio é o mesmo
FakeClock passado aos dois, então os resultados coincidem.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

import pytest

from app.repositories.auth import EmailAlreadyRegisteredError, RotationResult
from tests.auth_sql_support import h, new_reset, new_session, new_user
from tests.conftest import FakeClock

MAX_SESSIONS = 3
MAX_ROTATIONS = 3


class Repos:
    def __init__(self, users, sessions, resets, clock: FakeClock, kind: str) -> None:
        self.users, self.sessions, self.resets, self.clock, self.kind = users, sessions, resets, clock, kind


@pytest.fixture(params=["memory", "postgres"])
def repos(request) -> Repos:
    clock = FakeClock()
    if request.param == "memory":
        from app.repositories.memory import (
            InMemoryPasswordResetRepository,
            InMemorySessionRepository,
            InMemoryUserRepository,
            MemoryAuthStore,
        )

        store = MemoryAuthStore(max_sessions_per_user=MAX_SESSIONS, max_rotations_per_session=MAX_ROTATIONS)
        return Repos(InMemoryUserRepository(store), InMemorySessionRepository(store),
                     InMemoryPasswordResetRepository(store), clock, "memory")
    request.applymarker(pytest.mark.postgres)
    engine = request.getfixturevalue("pg_schema")
    from app.repositories.sql import SqlContext, SqlPasswordResetRepository, SqlSessionRepository, SqlUserRepository

    ctx = SqlContext(engine=engine, clock=clock)
    return Repos(SqlUserRepository(ctx), SqlSessionRepository(ctx, max_sessions_per_user=MAX_SESSIONS,
                                                                max_rotations_per_session=MAX_ROTATIONS),
                 SqlPasswordResetRepository(ctx), clock, "postgres")


def login(r: Repos, user, refresh: int | str, **kw):
    s = new_session(user, r.clock.now(), h(refresh), **kw)
    assert r.sessions.add_if_credentials_current(s) is True
    return s


# ---------------------------------------------------------------- usuários
def test_usuario_inserir_ler_e_email_unico(repos):
    u = new_user()
    repos.users.add(u)
    assert repos.users.get_by_id(u.id).email == u.email
    assert repos.users.get_by_email(u.email).id == u.id
    assert repos.users.get_by_email("nao-existe@x.com") is None
    assert repos.users.get_by_id("f" * 32) is None
    with pytest.raises(EmailAlreadyRegisteredError):
        repos.users.add(new_user(email=u.email))


def test_atualizar_nome_e_rehash_condicional(repos):
    u = new_user()
    repos.users.add(u)
    assert repos.users.update_name(u.id, "Novo Nome").name == "Novo Nome"
    assert repos.users.update_password_hash_if_version(u.id, "hash-novo", expected_version=0) is True
    assert repos.users.get_by_id(u.id).password_hash == "hash-novo"
    assert repos.users.update_password_hash_if_version(u.id, "hash-velho", expected_version=7) is False
    assert repos.users.get_by_id(u.id).password_hash == "hash-novo"
    assert repos.users.get_by_id(u.id).credential_version == 0        # rehash não muda a versão


# ---------------------------------------------------------------- sessões
def test_sessao_so_e_criada_com_credencial_atual(repos):
    u = new_user()
    repos.users.add(u)
    assert repos.sessions.add_if_credentials_current(new_session(u, repos.clock.now(), h(1), version=5)) is False
    s = login(repos, u, 2)
    view, user = repos.sessions.get_with_user(s.id)
    assert (view.id, view.user_id, view.revoked, view.rotation_count) == (s.id, u.id, False, 0)
    assert user.id == u.id and user.credential_version == 0
    assert repos.sessions.get("0" * 32) is None and repos.sessions.get_with_user("0" * 32) is None


def test_limite_de_sessoes_remove_expiradas_depois_revogadas_depois_antigas(repos):
    u = new_user()
    repos.users.add(u)
    old = login(repos, u, 10, ttl=60)                                 # vai expirar
    repos.clock.advance(1)
    revoked = login(repos, u, 11)
    repos.sessions.revoke(revoked.id, repos.clock.now())
    repos.clock.advance(1)
    keep = login(repos, u, 12)
    repos.clock.advance(120)                                          # `old` expirou
    login(repos, u, 13)                                               # 4ª: remove a expirada
    assert repos.sessions.get(old.id) is None
    assert repos.sessions.get(revoked.id) is not None
    login(repos, u, 14)                                               # remove a revogada
    assert repos.sessions.get(revoked.id) is None
    login(repos, u, 15)                                               # remove a mais antiga ativa
    assert repos.sessions.get(keep.id) is None


def test_rotacao_e_reutilizacao_revogam_a_familia(repos):
    u = new_user()
    repos.users.add(u)
    s = login(repos, u, 20)
    result, view = repos.sessions.rotate_refresh(h(20), h(21), repos.clock.now())
    assert result is RotationResult.ROTATED and view.rotation_count == 1
    assert repos.sessions.rotate_refresh(h(999), h(998), repos.clock.now())[0] is RotationResult.INVALID
    assert repos.sessions.rotate_refresh(h(20), h(22), repos.clock.now())[0] is RotationResult.REUSED
    assert repos.sessions.get(s.id).revoked is True
    # atual de sessão revogada → inválido; histórico continua detectando reutilização
    assert repos.sessions.rotate_refresh(h(21), h(23), repos.clock.now())[0] is RotationResult.INVALID
    assert repos.sessions.rotate_refresh(h(20), h(24), repos.clock.now())[0] is RotationResult.REUSED


def test_rotacao_de_sessao_expirada_ou_com_credencial_alterada(repos):
    u = new_user()
    repos.users.add(u)
    s = login(repos, u, 30, ttl=60)
    repos.clock.advance(60)                                           # instante EXATO da expiração
    assert repos.sessions.rotate_refresh(h(30), h(31), repos.clock.now())[0] is RotationResult.INVALID
    assert repos.sessions.get(s.id).revoked is False
    s2 = login(repos, u, 32)
    token = new_reset(u, repos.clock.now(), h("r1"))
    repos.resets.issue_replacing_active(token, repos.clock.now())
    assert repos.resets.complete_reset(h("r1"), "hash-redefinido", repos.clock.now()) == u.id
    assert repos.sessions.rotate_refresh(h(32), h(33), repos.clock.now())[0] is RotationResult.INVALID
    assert repos.sessions.get(s2.id).revoked is True


def test_teto_de_rotacoes_revoga_e_preserva_o_historico(repos):
    u = new_user()
    repos.users.add(u)
    s = login(repos, u, 40)
    for i in range(MAX_ROTATIONS):                                    # N rotações funcionam
        assert repos.sessions.rotate_refresh(h(40 + i), h(41 + i), repos.clock.now())[0] is RotationResult.ROTATED
    current = h(40 + MAX_ROTATIONS)
    assert repos.sessions.rotate_refresh(current, h(99), repos.clock.now())[0] is RotationResult.LIMIT_REACHED
    assert repos.sessions.get(s.id).revoked is True
    assert repos.sessions.rotate_refresh(current, h(98), repos.clock.now())[0] is RotationResult.INVALID
    assert repos.sessions.rotate_refresh(h(40), h(97), repos.clock.now())[0] is RotationResult.REUSED  # 1º token
    repos.clock.advance(4000)                                         # família expirou
    assert repos.sessions.rotate_refresh(h(40), h(96), repos.clock.now())[0] is RotationResult.INVALID
    assert repos.sessions.purge_expired(repos.clock.now()) >= 1
    assert repos.sessions.get(s.id) is None


def test_logout_idempotente_e_sem_afetar_outras_familias(repos):
    u = new_user()
    repos.users.add(u)
    a, b = login(repos, u, 50), login(repos, u, 51)
    assert repos.sessions.revoke(a.id, repos.clock.now()) is True
    assert repos.sessions.revoke(a.id, repos.clock.now()) is False
    assert repos.sessions.get(b.id).revoked is False
    assert repos.sessions.rotate_refresh(h(51), h(52), repos.clock.now())[0] is RotationResult.ROTATED


# ---------------------------------------------------------------- recuperação
def test_um_token_ativo_e_redefinicao_atomica(repos):
    u = new_user()
    repos.users.add(u)
    s = login(repos, u, 60)
    repos.resets.issue_replacing_active(new_reset(u, repos.clock.now(), h("a")), repos.clock.now())
    repos.resets.issue_replacing_active(new_reset(u, repos.clock.now(), h("b")), repos.clock.now())
    assert repos.resets.is_active(h("a"), repos.clock.now()) is False   # substituído
    assert repos.resets.is_active(h("b"), repos.clock.now()) is True
    assert repos.resets.complete_reset(h("a"), "x", repos.clock.now()) is None
    assert repos.resets.complete_reset(h("b"), "hash-novo", repos.clock.now()) == u.id
    after = repos.users.get_by_id(u.id)
    assert (after.password_hash, after.credential_version) == ("hash-novo", 1)
    assert repos.sessions.get(s.id).revoked is True
    assert repos.resets.is_active(h("b"), repos.clock.now()) is False   # consumido
    assert repos.resets.complete_reset(h("b"), "de-novo", repos.clock.now()) is None


def test_emissao_devolve_o_registro_persistido(repos):
    u = new_user()
    repos.users.add(u)
    requested = new_reset(u, repos.clock.now(), h("p"), ttl=900)
    issued = repos.resets.issue_replacing_active(requested, repos.clock.now())
    assert (issued.token_hash, issued.user_id) == (h("p"), u.id)
    assert issued.expires_at - issued.created_at == timedelta(seconds=900)
    assert repos.resets.is_active(h("p"), issued.expires_at - timedelta(microseconds=1)) is True
    assert repos.resets.is_active(h("p"), issued.expires_at) is False


def test_token_expira_no_instante_exato(repos):
    u = new_user()
    repos.users.add(u)
    repos.resets.issue_replacing_active(new_reset(u, repos.clock.now(), h("e"), ttl=30), repos.clock.now())
    repos.clock.advance(30)
    assert repos.resets.is_active(h("e"), repos.clock.now()) is False
    assert repos.resets.complete_reset(h("e"), "x", repos.clock.now()) is None
    assert repos.users.get_by_id(u.id).credential_version == 0
    assert repos.resets.purge_expired(repos.clock.now()) >= 1


def test_usuario_inalterado_quando_token_invalido(repos):
    u = new_user()
    repos.users.add(u)
    assert repos.resets.complete_reset(h("nada"), "x", repos.clock.now()) is None
    assert replace(repos.users.get_by_id(u.id), name=u.name).password_hash == u.password_hash
    assert repos.users.get_by_id(u.id).credential_version == 0
    _ = timedelta  # (import mantido para clareza dos cenários com tempo)

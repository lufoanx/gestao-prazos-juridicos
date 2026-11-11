"""P2 — esquema PostgreSQL: os 22 cenários aprovados (docs/backend/15b) como testes automatizados,
mais verificações reais de COMMIT das FKs diferidas, rollback, índices parciais, inspeção e
comparação do esquema migrado com o MetaData. Somente com a fixture protegida da P1.
"""
from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import date, datetime, time, timedelta, timezone

import pytest
from sqlalchemy import Connection, Engine, insert, select, text, update
from sqlalchemy.exc import IntegrityError

from app.db.tables import (
    TABLE_NAMES,
    auth_sessions,
    auth_used_refresh_hashes,
    deadlines,
    intimations,
    invitations,
    join_requests,
    memberships,
    metadata,
    notifications,
    offices,
    password_reset_tokens,
    users,
)

pytestmark = pytest.mark.postgres
NOW = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
ALL_PERMS = ["deadline.read", "deadline.create", "deadline.edit", "deadline.complete",
             "deadline.transfer", "team.manage", "office.manage"]


def uid() -> uuid.UUID:
    return uuid.uuid4()


class World:
    def __init__(self) -> None:
        self.ana, self.bia, self.caio = uid(), uid(), uid()
        self.office = uid()


def seed(conn: Connection) -> World:
    w = World()
    conn.execute(insert(users), [
        {"id": w.ana, "name": "Ana", "email": f"ana-{w.ana.hex[:6]}@x.com", "password_hash": "h", "created_at": NOW},
        {"id": w.bia, "name": "Bia", "email": f"bia-{w.bia.hex[:6]}@x.com", "password_hash": "h", "created_at": NOW},
        {"id": w.caio, "name": "Caio", "email": f"caio-{w.caio.hex[:6]}@x.com", "password_hash": "h",
         "created_at": NOW},
    ])
    conn.execute(insert(offices).values(id=w.office, name="Escritório", created_by=w.ana, created_at=NOW,
                                        join_code="ABCDEFGH23"))
    conn.execute(insert(memberships), [
        {"user_id": w.ana, "office_id": w.office, "role_label": "Sócia", "permissions": ALL_PERMS,
         "visibility": "all", "joined_at": NOW},
        {"user_id": w.bia, "office_id": w.office, "role_label": "Associada", "permissions": ["deadline.read"],
         "visibility": "assigned", "joined_at": NOW},
    ])
    return w


def deadline_row(**over):
    row = dict(id=uid(), title="Contestação", case_number="0001234-56.2026", court="TJSC", practice_area="Cível",
               status="open", priority="normal", start_date=date(2026, 11, 1), due_date=date(2026, 11, 20),
               counting_mode="business", duration=10, reviewed=True, created_at=NOW, updated_at=NOW)
    row.update(over)
    return row


def office_deadline(w: World, responsible: uuid.UUID, **over):
    return deadline_row(scope_kind="office", office_id=w.office, responsible_id=responsible, created_by=w.ana,
                        open_office_id=w.office if over.get("status", "open") == "open" else None, **over)


def personal_deadline(owner: uuid.UUID, **over):
    return deadline_row(**{"scope_kind": "personal", "owner_id": owner, "responsible_id": owner,
                           "created_by": owner, **over})


def intimation_row(**over):
    row = dict(id=uid(), file_name="intimacao.pdf", file_size_bytes=2048, file_content_type="application/pdf",
               received_at=date(2026, 11, 1), status="awaiting_review", created_at=NOW, updated_at=NOW)
    row.update(over)
    return row


@pytest.fixture
def world(pg_schema: Engine) -> World:
    with pg_schema.begin() as conn:
        return seed(conn)


def fails_now(engine: Engine, action: Callable[[Connection], object], constraint: str) -> None:
    """Falha IMEDIATA (constraint não diferida) — e nada fica gravado."""
    with engine.connect() as conn, conn.begin():
        with pytest.raises(IntegrityError) as exc:
            action(conn)
    assert exc.value.orig.diag.constraint_name == constraint  # type: ignore[union-attr]


def fails_on_commit(engine: Engine, action: Callable[[Connection], object], constraint: str) -> None:
    """FK DIFERIDA: o comando é aceito e a violação aparece no COMMIT REAL."""
    with engine.connect() as conn:
        tx = conn.begin()
        action(conn)                                  # aceito durante a transação
        with pytest.raises(IntegrityError) as exc:
            tx.commit()
    assert exc.value.orig.diag.constraint_name == constraint  # type: ignore[union-attr]


def count(engine: Engine, table) -> int:
    with engine.connect() as conn:
        return conn.execute(select(text("count(*)")).select_from(table)).scalar_one()


# ---------------------------------------------------------------- cenários 1–22 (doc 15, §11)
def test_01_email_duplicado(pg_schema, world):
    with pg_schema.connect() as c:
        email = c.execute(select(users.c.email).where(users.c.id == world.ana)).scalar_one()
    fails_now(pg_schema, lambda c: c.execute(insert(users).values(
        id=uid(), name="X", email=email, password_hash="h", created_at=NOW)), "uq_users_email")


def test_02_email_com_maiusculas(pg_schema, world):
    fails_now(pg_schema, lambda c: c.execute(insert(users).values(
        id=uid(), name="X", email="Outra@x.com", password_hash="h", created_at=NOW)), "ck_users_email_normalized")


def test_03_segundo_vinculo_do_mesmo_usuario(pg_schema, world):
    with pg_schema.begin() as c:
        other = uid()
        c.execute(insert(offices).values(id=other, name="Outro", created_by=world.caio, created_at=NOW,
                                         join_code="ZZZZZZZZ23"))
    fails_now(pg_schema, lambda c: c.execute(insert(memberships).values(
        user_id=world.bia, office_id=other, role_label="X", permissions=[], visibility="all", joined_at=NOW)),
        "pk_memberships")


def test_04_prazo_aberto_com_responsavel_sem_vinculo_falha_no_commit(pg_schema, world):
    fails_on_commit(pg_schema, lambda c: c.execute(insert(deadlines).values(**office_deadline(world, world.caio))),
                    "fk_deadlines_active_responsible")
    assert count(pg_schema, deadlines) == 0


def test_05_prazo_aberto_para_membro_ativo(pg_schema, world):
    with pg_schema.begin() as c:
        c.execute(insert(deadlines).values(**office_deadline(world, world.bia)))
    assert count(pg_schema, deadlines) == 1


def test_06_remover_vinculo_com_prazo_aberto_sem_reatribuir_falha_no_commit(pg_schema, world):
    with pg_schema.begin() as c:
        c.execute(insert(deadlines).values(**office_deadline(world, world.bia)))
    fails_on_commit(pg_schema, lambda c: c.execute(memberships.delete().where(memberships.c.user_id == world.bia)),
                    "fk_deadlines_active_responsible")
    with pg_schema.connect() as c:                              # vínculo continua lá (rollback)
        assert c.execute(select(memberships.c.user_id).where(memberships.c.user_id == world.bia)).first()


def test_07_open_office_id_incoerente_com_o_status(pg_schema, world):
    row = office_deadline(world, world.bia)
    with pg_schema.begin() as c:
        c.execute(insert(deadlines).values(**row))
    fails_now(pg_schema, lambda c: c.execute(update(deadlines).where(deadlines.c.id == row["id"]).values(
        status="completed")), "ck_deadlines_open_office_matches_status")


def test_08_reatribuir_e_remover_vinculo_na_mesma_transacao(pg_schema, world):
    row = office_deadline(world, world.bia)
    with pg_schema.begin() as c:
        c.execute(insert(deadlines).values(**row))
    with pg_schema.begin() as c:                                # COMMIT real deve passar
        c.execute(memberships.delete().where(memberships.c.user_id == world.bia))
        c.execute(update(deadlines).where(deadlines.c.id == row["id"]).values(responsible_id=world.ana, version=2))
    with pg_schema.connect() as c:
        assert c.execute(select(deadlines.c.responsible_id)).scalar_one() == world.ana
        assert c.execute(select(memberships.c.user_id).where(memberships.c.user_id == world.bia)).first() is None


def test_09_prazo_pessoal_com_responsavel_diferente_do_dono(pg_schema, world):
    fails_now(pg_schema, lambda c: c.execute(insert(deadlines).values(
        **personal_deadline(world.caio, responsible_id=world.ana))), "ck_deadlines_personal_responsible_is_owner")


def test_10_vencimento_antes_do_inicio(pg_schema, world):
    fails_now(pg_schema, lambda c: c.execute(insert(deadlines).values(
        **personal_deadline(world.caio, start_date=date(2026, 11, 20), due_date=date(2026, 11, 1)))),
        "ck_deadlines_due_after_start")


def _personal_linked(c: Connection, w: World) -> tuple[uuid.UUID, uuid.UUID]:
    d = personal_deadline(w.ana)
    i = intimation_row(scope_kind="personal", owner_id=w.ana, status="reviewed", deadline_id=d["id"],
                       created_by=w.ana, closed_at=NOW)
    c.execute(insert(deadlines).values(**d))
    c.execute(insert(intimations).values(**i))
    return d["id"], i["id"]


def test_11_intimacao_pessoal_revisada_vinculada_ao_prazo_pessoal(pg_schema, world):
    with pg_schema.begin() as c:
        _personal_linked(c, world)
    assert count(pg_schema, intimations) == 1


def test_12_segunda_intimacao_para_o_mesmo_prazo(pg_schema, world):
    with pg_schema.begin() as c:
        d_id, _ = _personal_linked(c, world)
    fails_now(pg_schema, lambda c: c.execute(insert(intimations).values(**intimation_row(
        scope_kind="personal", owner_id=world.ana, status="reviewed", deadline_id=d_id, created_by=world.ana,
        closed_at=NOW))), "uq_intimations_deadline_id")


def test_13_revisada_sem_vinculo(pg_schema, world):
    fails_now(pg_schema, lambda c: c.execute(insert(intimations).values(**intimation_row(
        scope_kind="personal", owner_id=world.ana, status="reviewed", created_by=world.ana, closed_at=NOW))),
        "ck_intimations_reviewed_iff_linked")


def _move_deadline_to_office(c: Connection, w: World, d_id: uuid.UUID) -> None:
    c.execute(update(deadlines).where(deadlines.c.id == d_id).values(
        scope_kind="office", owner_id=None, office_id=w.office, open_office_id=w.office, version=2))


def test_14_transferir_so_o_prazo_falha_no_commit(pg_schema, world):
    with pg_schema.begin() as c:
        d_id, _ = _personal_linked(c, world)
    fails_on_commit(pg_schema, lambda c: _move_deadline_to_office(c, world, d_id),
                    "fk_intimations_deadline_same_scope")
    with pg_schema.connect() as c:                              # nada mudou
        assert c.execute(select(deadlines.c.scope_kind)).scalar_one() == "personal"


def test_15_transferir_prazo_e_intimacao_juntos(pg_schema, world):
    with pg_schema.begin() as c:
        d_id, i_id = _personal_linked(c, world)
    with pg_schema.begin() as c:
        _move_deadline_to_office(c, world, d_id)
        c.execute(update(intimations).where(intimations.c.id == i_id).values(
            scope_kind="office", owner_id=None, office_id=world.office, version=2))
    with pg_schema.connect() as c:
        assert c.execute(select(intimations.c.scope_key)).scalar_one() == f"office:{world.office}"
        assert c.execute(select(deadlines.c.scope_key)).scalar_one() == f"office:{world.office}"


def test_16_pendencia_sugerida_a_quem_nao_tem_vinculo_falha_no_commit(pg_schema, world):
    fails_on_commit(pg_schema, lambda c: c.execute(insert(intimations).values(**intimation_row(
        scope_kind="office", office_id=world.office, suggested_responsible_id=world.caio,
        suggested_open_office_id=world.office, created_by=world.ana))), "fk_intimations_suggested_active")


def test_17_notificacao_duplicada_on_conflict_do_nothing(pg_schema, world):
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    with pg_schema.begin() as c:
        d = office_deadline(world, world.bia)
        c.execute(insert(deadlines).values(**d))
    event = uid()
    stmt = lambda: pg_insert(notifications).values(  # noqa: E731
        id=uid(), recipient_id=world.bia, scope_kind="office", office_id=world.office, kind="deadline_assigned",
        deadline_id=d["id"], event_id=event, created_at=NOW,
    ).on_conflict_do_nothing(constraint="uq_notifications_recipient_id_event_id").returning(notifications.c.id)
    with pg_schema.begin() as c:                                # RETURNING: linhas efetivamente inseridas
        assert len(c.execute(stmt()).all()) == 1
        assert len(c.execute(stmt()).all()) == 0
    assert count(pg_schema, notifications) == 1


def _token(user: uuid.UUID, ch: str, **over):
    row = dict(token_hash=ch * 64, user_id=user, created_at=NOW, expires_at=NOW + timedelta(hours=1))
    row.update(over)
    return row


def test_18_19_um_token_de_recuperacao_ativo_por_usuario(pg_schema, world):
    with pg_schema.begin() as c:
        c.execute(insert(password_reset_tokens).values(**_token(world.ana, "a")))
    fails_now(pg_schema, lambda c: c.execute(insert(password_reset_tokens).values(**_token(world.ana, "b"))),
              "uq_password_reset_tokens_one_active_per_user")


def test_20_permissao_desconhecida(pg_schema, world):
    fails_now(pg_schema, lambda c: c.execute(update(memberships).where(memberships.c.user_id == world.ana).values(
        permissions=["deadline.read", "superuser"])), "ck_memberships_permissions_known")


def test_21_update_com_versao_antiga_afeta_zero_linhas(pg_schema, world):
    row = office_deadline(world, world.bia)
    with pg_schema.begin() as c:
        c.execute(insert(deadlines).values(**row))
        c.execute(update(deadlines).where(deadlines.c.id == row["id"]).values(title="Aba A", version=2))
    with pg_schema.begin() as c:
        result = c.execute(update(deadlines).where(deadlines.c.id == row["id"], deadlines.c.version == 1).values(
            title="Aba velha", version=deadlines.c.version + 1))
        assert result.rowcount == 0
    with pg_schema.connect() as c:
        assert c.execute(select(deadlines.c.title, deadlines.c.version)).one() == ("Aba A", 2)


def test_22_codigo_de_ingresso_repetido_on_conflict_nao_aborta(pg_schema, world):
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    def office(code: str):
        return pg_insert(offices).values(id=uid(), name="Outro", created_by=world.caio, created_at=NOW,
                                         join_code=code).on_conflict_do_nothing(
            index_elements=["join_code"]).returning(offices.c.id)

    with pg_schema.begin() as c:
        assert c.execute(office("ABCDEFGH23")).all() == []           # colide: transação segue válida
        assert len(c.execute(office("ZZZZZZZZ23")).all()) == 1       # nova tentativa insere
    assert count(pg_schema, offices) == 2


# ---------------------------------------------------------------- rollback e índices parciais
def test_rollback_integral_sem_registros_parciais(pg_schema, world):
    def many(c: Connection) -> None:
        c.execute(insert(deadlines).values(**office_deadline(world, world.bia)))             # válido
        c.execute(insert(deadlines).values(**personal_deadline(world.caio)))                  # válido
        c.execute(insert(intimations).values(**intimation_row(scope_kind="personal", owner_id=world.caio,
                                                              created_by=world.caio)))      # válido
        c.execute(insert(deadlines).values(**office_deadline(world, world.caio)))           # viola no COMMIT

    fails_on_commit(pg_schema, many, "fk_deadlines_active_responsible")
    assert (count(pg_schema, deadlines), count(pg_schema, intimations)) == (0, 0)


def test_token_liberado_apos_uso_ou_invalidacao(pg_schema, world):
    with pg_schema.begin() as c:
        c.execute(insert(password_reset_tokens).values(**_token(world.ana, "a")))
        c.execute(update(password_reset_tokens).where(password_reset_tokens.c.token_hash == "a" * 64).values(
            used_at=NOW))
        c.execute(insert(password_reset_tokens).values(**_token(world.ana, "b")))            # liberado pelo uso
        c.execute(update(password_reset_tokens).where(password_reset_tokens.c.token_hash == "b" * 64).values(
            invalidated_at=NOW))
        c.execute(insert(password_reset_tokens).values(**_token(world.ana, "c")))            # liberado pela invalidação
        c.execute(insert(password_reset_tokens).values(**_token(world.bia, "d")))            # outro usuário
    assert count(pg_schema, password_reset_tokens) == 4


def test_solicitacao_pendente_unica_e_liberada_apos_decisao(pg_schema, world):
    req = dict(office_id=world.office, user_id=world.caio, created_at=NOW)
    with pg_schema.begin() as c:
        c.execute(insert(join_requests).values(id=uid(), **req))
    fails_now(pg_schema, lambda c: c.execute(insert(join_requests).values(id=uid(), **req)),
              "uq_join_requests_one_pending")
    with pg_schema.begin() as c:
        c.execute(update(join_requests).values(status="cancelled", decided_at=NOW))         # decided_by NULL
        c.execute(insert(join_requests).values(id=uid(), **req))                             # liberada
        c.execute(update(join_requests).where(join_requests.c.status == "pending").values(
            status="rejected", decided_at=NOW, decided_by=world.ana))
        c.execute(insert(join_requests).values(id=uid(), **req))
    assert count(pg_schema, join_requests) == 3


def test_varios_opcionais_nulos_permitidos_onde_ha_unicidade(pg_schema, world):
    with pg_schema.begin() as c:
        for _ in range(3):                                          # deadline_id NULL em várias pendências
            c.execute(insert(intimations).values(**intimation_row(
                scope_kind="office", office_id=world.office, created_by=world.ana)))
    assert count(pg_schema, intimations) == 3


def test_coerencia_de_convite_e_de_encerramento(pg_schema, world):
    inv = dict(id=uid(), office_id=world.office, token_hash="e" * 64, role_label="Associado", created_by=world.ana,
               created_at=NOW, expires_at=NOW + timedelta(days=7))
    fails_now(pg_schema, lambda c: c.execute(insert(invitations).values(**inv, status="accepted")),
              "ck_invitations_closed_iff_not_pending")
    with pg_schema.begin() as c:
        c.execute(insert(invitations).values(**inv))
        c.execute(update(invitations).values(status="revoked", closed_at=NOW))
    fails_now(pg_schema, lambda c: c.execute(insert(intimations).values(**intimation_row(
        scope_kind="personal", owner_id=world.ana, status="discarded", created_by=world.ana))),
        "ck_intimations_closed_iff_terminal")


def test_forma_do_escopo_e_recurso_da_notificacao(pg_schema, world):
    fails_now(pg_schema, lambda c: c.execute(insert(deadlines).values(**deadline_row(
        scope_kind="personal", owner_id=world.ana, office_id=world.office, responsible_id=world.ana,
        created_by=world.ana))), "ck_deadlines_scope_shape")
    with pg_schema.begin() as c:
        d = office_deadline(world, world.bia)
        c.execute(insert(deadlines).values(**d))
    fails_now(pg_schema, lambda c: c.execute(insert(notifications).values(
        id=uid(), recipient_id=world.bia, scope_kind="office", office_id=world.office, kind="intimation_assigned",
        deadline_id=d["id"], event_id=uid(), created_at=NOW)), "ck_notifications_resource_matches_kind")


def test_tipos_civis_e_instantes_preservados(pg_schema, world):
    row = personal_deadline(world.ana, start_date=date(2026, 2, 1), due_date=date(2026, 2, 28),
                            agenda_time=time(9, 30))
    with pg_schema.begin() as c:
        c.execute(text("SET LOCAL TIME ZONE 'Pacific/Kiritimati'"))  # fuso da SESSÃO não muda a data civil
        c.execute(insert(deadlines).values(**row))
    with pg_schema.connect() as c:
        c.execute(text("SET TIME ZONE 'America/Los_Angeles'"))
        due, agenda, created = c.execute(select(deadlines.c.due_date, deadlines.c.agenda_time,
                                                deadlines.c.created_at)).one()
    assert (due, agenda) == (date(2026, 2, 28), time(9, 30))
    assert created == NOW                                          # mesmo instante, qualquer fuso


def test_sessao_apagada_leva_o_historico_de_hashes(pg_schema, world):
    sid = uid()
    with pg_schema.begin() as c:
        c.execute(insert(auth_sessions).values(id=sid, user_id=world.ana, created_at=NOW,
                                               expires_at=NOW + timedelta(days=7), current_refresh_hash="f" * 64,
                                               credential_version=0))
        c.execute(insert(auth_used_refresh_hashes).values(refresh_hash="0" * 64, session_id=sid, used_at=NOW))
    with pg_schema.begin() as c:
        c.execute(auth_sessions.delete())
    assert count(pg_schema, auth_used_refresh_hashes) == 0


# ---------------------------------------------------------------- inspeção do esquema
EXPECTED_CONSTRAINTS = {
    "users": {"pk_users", "uq_users_email", "ck_users_name_length", "ck_users_email_normalized",
              "ck_users_credential_version_nonnegative"},
    "auth_sessions": {"pk_auth_sessions", "fk_auth_sessions_user_id_users", "uq_auth_sessions_current_refresh_hash",
                      "ck_auth_sessions_refresh_hash_length", "ck_auth_sessions_rotation_count_nonnegative",
                      "ck_auth_sessions_expires_after_created"},
    "auth_used_refresh_hashes": {"pk_auth_used_refresh_hashes", "fk_auth_used_refresh_hashes_session_id_auth_sessions",
                                 "ck_auth_used_refresh_hashes_refresh_hash_length"},
    "password_reset_tokens": {"pk_password_reset_tokens", "fk_password_reset_tokens_user_id_users",
                              "ck_password_reset_tokens_token_hash_length"},
    "offices": {"pk_offices", "fk_offices_created_by_users", "uq_offices_join_code", "ck_offices_name_length",
                "ck_offices_join_code_format"},
    "memberships": {"pk_memberships", "fk_memberships_user_id_users", "fk_memberships_office_id_offices",
                    "uq_memberships_user_id_office_id", "ck_memberships_role_label_length",
                    "ck_memberships_permissions_known", "ck_memberships_visibility_valid"},
    "invitations": {"pk_invitations", "fk_invitations_office_id_offices", "fk_invitations_created_by_users",
                    "uq_invitations_token_hash", "ck_invitations_token_hash_length", "ck_invitations_status_valid",
                    "ck_invitations_closed_iff_not_pending"},
    "join_requests": {"pk_join_requests", "fk_join_requests_office_id_offices", "fk_join_requests_user_id_users",
                      "fk_join_requests_decided_by_users", "ck_join_requests_status_valid",
                      "ck_join_requests_decided_iff_not_pending"},
    "deadlines": {"pk_deadlines", "fk_deadlines_owner_id_users", "fk_deadlines_office_id_offices",
                  "fk_deadlines_responsible_id_users", "fk_deadlines_created_by_users", "ck_deadlines_scope_shape",
                  "ck_deadlines_status_valid", "ck_deadlines_priority_valid", "ck_deadlines_counting_mode_valid",
                  "ck_deadlines_duration_range", "ck_deadlines_version_positive", "ck_deadlines_due_after_start",
                  "ck_deadlines_open_office_matches_status", "ck_deadlines_personal_responsible_is_owner",
                  "uq_deadlines_id_scope_key", "fk_deadlines_active_responsible"},
    "deadline_comments": {"pk_deadline_comments", "fk_deadline_comments_deadline_id_deadlines",
                          "fk_deadline_comments_author_id_users", "ck_deadline_comments_text_length"},
    "deadline_history": {"pk_deadline_history", "fk_deadline_history_deadline_id_deadlines",
                         "fk_deadline_history_actor_id_users", "ck_deadline_history_action_valid"},
    "intimations": {"pk_intimations", "fk_intimations_owner_id_users", "fk_intimations_office_id_offices",
                    "fk_intimations_suggested_responsible_id_users", "fk_intimations_created_by_users",
                    "ck_intimations_scope_shape", "ck_intimations_file_name_length", "ck_intimations_file_size_range",
                    "ck_intimations_file_content_type_pdf", "ck_intimations_file_not_stored",
                    "ck_intimations_status_valid", "ck_intimations_processing_status_valid",
                    "ck_intimations_draft_counting_mode_valid", "ck_intimations_draft_duration_range",
                    "ck_intimations_draft_priority_valid", "ck_intimations_version_positive",
                    "ck_intimations_reviewed_iff_linked", "ck_intimations_closed_iff_terminal",
                    "ck_intimations_suggested_open_office_matches", "uq_intimations_deadline_id",
                    "fk_intimations_deadline_same_scope", "fk_intimations_suggested_active"},
    "intimation_events": {"pk_intimation_events", "fk_intimation_events_intimation_id_intimations",
                          "fk_intimation_events_actor_id_users"},
    "notifications": {"pk_notifications", "fk_notifications_recipient_id_users", "fk_notifications_owner_id_users",
                      "fk_notifications_office_id_offices", "fk_notifications_deadline_id_deadlines",
                      "fk_notifications_intimation_id_intimations", "ck_notifications_scope_shape",
                      "ck_notifications_kind_valid", "ck_notifications_resource_matches_kind",
                      "uq_notifications_recipient_id_event_id"},
}
EXPECTED_INDEXES = {
    "ix_auth_sessions_user_id_created_at", "ix_auth_sessions_expires_at", "ix_auth_used_refresh_hashes_session_id",
    "uq_password_reset_tokens_one_active_per_user", "ix_memberships_office_id_joined_at",
    "ix_invitations_office_id_created_at", "uq_join_requests_one_pending",
    "ix_join_requests_office_id_status_created_at", "ix_join_requests_user_id_status_created_at",
    "ix_deadlines_office_list", "ix_deadlines_personal_list", "ix_deadlines_open_responsible",
    "ix_deadline_comments_deadline_id_created_at", "ix_deadline_history_deadline_id_at",
    "ix_intimations_office_list", "ix_intimations_personal_list", "ix_intimations_discarded_purge",
    "ix_intimation_events_intimation_id_at", "ix_notifications_inbox", "ix_notifications_unread",
    "ix_notifications_read_purge",
}


def test_tabelas_no_esquema_explicito_e_nada_em_public(pg_schema):
    with pg_schema.connect() as c:
        tables = {r[0] for r in c.execute(text(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'prazoai'"))}
        public = c.execute(text(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")).scalar_one()
    assert tables == set(TABLE_NAMES) | {"alembic_version", "prazoai_test_marker"}
    assert public == 0


def test_constraints_com_nomes_estaveis(pg_schema):
    with pg_schema.connect() as c:
        rows = c.execute(text(
            "SELECT t.relname, con.conname FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid "
            "JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'prazoai' AND con.contype <> 'n'"))
        found: dict[str, set[str]] = {}
        for table, name in rows:
            found.setdefault(table, set()).add(name)
    found.pop("prazoai_test_marker", None)
    found.pop("alembic_version", None)
    assert found == EXPECTED_CONSTRAINTS


def test_indices_com_nomes_estaveis_e_parciais(pg_schema):
    with pg_schema.connect() as c:
        rows = dict(c.execute(text(
            "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'prazoai' "
            "AND indexname NOT LIKE 'pk_%' AND indexname NOT LIKE 'uq_%_key' "
            "AND tablename NOT IN ('alembic_version', 'prazoai_test_marker')")).all())
    unique_constraint_indexes = {n for t in EXPECTED_CONSTRAINTS.values() for n in t if n.startswith("uq_")}
    assert set(rows) - unique_constraint_indexes == EXPECTED_INDEXES
    one_active = rows["uq_password_reset_tokens_one_active_per_user"]
    assert "WHERE ((used_at IS NULL) AND (invalidated_at IS NULL))" in one_active
    assert "WHERE (status = 'pending'::text)" in rows["uq_join_requests_one_pending"]
    assert rows["uq_join_requests_one_pending"].startswith("CREATE UNIQUE INDEX")


def test_fks_diferidas_e_imediatas(pg_schema):
    with pg_schema.connect() as c:
        rows = dict((r[0], (r[1], r[2])) for r in c.execute(text(
            "SELECT conname, condeferrable, condeferred FROM pg_constraint con JOIN pg_namespace n "
            "ON n.oid = con.connamespace WHERE n.nspname = 'prazoai' AND contype = 'f'")))
    deferred = {k for k, v in rows.items() if v == (True, True)}
    assert deferred == {"fk_deadlines_active_responsible", "fk_intimations_deadline_same_scope",
                        "fk_intimations_suggested_active"}
    assert all(v == (False, False) for k, v in rows.items() if k not in deferred)


def test_tipos_das_colunas(pg_schema):
    with pg_schema.connect() as c:
        types = {(r[0], r[1]): r[2] for r in c.execute(text(
            "SELECT table_name, column_name, data_type FROM information_schema.columns "
            "WHERE table_schema = 'prazoai'"))}
    assert types[("users", "id")] == "uuid"
    assert types[("deadlines", "due_date")] == "date"
    assert types[("deadlines", "agenda_time")] == "time without time zone"
    assert types[("deadlines", "created_at")] == "timestamp with time zone"
    assert types[("intimations", "received_at")] == "date"
    assert types[("memberships", "permissions")] == "ARRAY"
    assert types[("deadline_history", "details")] == "jsonb"
    with pg_schema.connect() as c:
        generated = {r[0] for r in c.execute(text(
            "SELECT table_name FROM information_schema.columns WHERE table_schema = 'prazoai' "
            "AND column_name = 'scope_key' AND is_generated = 'ALWAYS'"))}
    assert generated == {"deadlines", "intimations"}


def _compare_with_metadata(pg_config) -> list:
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlalchemy import create_engine

    from app.db.engine import connect_arguments

    # O engine da aplicação fixa search_path=prazoai, e o dialeto memoriza esse esquema como padrão;
    # o Alembic então refletiria `prazoai` como "sem esquema". Para comparar com o MetaData (que
    # declara `prazoai` explicitamente), usa-se um engine do teste com os MESMOS parâmetros efetivos
    # (host/porta/banco explícitos) e apenas o search_path em `public`.
    args = connect_arguments(pg_config, application_name="prazoai-tests-compare")
    args["options"] = str(args["options"]).replace("search_path=prazoai", "search_path=public")
    engine = create_engine(pg_config.url, connect_args=args, hide_parameters=True)

    def include(obj, name, type_, reflected, compare_to):
        if type_ == "table":
            return name in TABLE_NAMES
        return True

    try:
        with engine.connect() as c:
            assert c.dialect.default_schema_name == "public"
            ctx = MigrationContext.configure(c, opts={
                "include_schemas": True, "include_name": lambda n, t, p: t != "schema" or n == "prazoai",
                "include_object": include, "compare_type": True, "compare_server_default": True,
            })
            return compare_metadata(ctx, metadata)
    finally:
        engine.dispose()


def test_esquema_migrado_igual_ao_metadata(pg_schema, pg_config):
    """Sem diferenças entre o esquema criado pela migration 0002 e app/db/tables (Alembic compare)."""
    assert _compare_with_metadata(pg_config) == []


def test_comparacao_detecta_divergencia(pg_schema, pg_config):
    """Prova negativa: um índice criado fora da migration aparece como diferença."""
    with pg_schema.begin() as c:
        c.execute(text("CREATE INDEX ix_tmp_divergencia ON prazoai.users (name)"))
    try:
        diff = _compare_with_metadata(pg_config)
        assert [d[0] for d in diff] == ["remove_index"]
        assert diff[0][1].name == "ix_tmp_divergencia"
    finally:
        with pg_schema.begin() as c:
            c.execute(text("DROP INDEX prazoai.ix_tmp_divergencia"))

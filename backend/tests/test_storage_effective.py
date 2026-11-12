"""Verificação OBRIGATÓRIA do armazenamento efetivo das suítes HTTP.

Com PRAZOAI_TEST_STORAGE=postgres (CI), as apps criadas pela fixture `make_app` precisam subir em
STORAGE=postgres de verdade (autenticação e domínio) e gravar no banco; se caírem em memória, este
teste falha. Sem a variável, é pulado.
"""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from tests.org_utils import API, OrgClient, fast_hasher

pytestmark = pytest.mark.skipif(os.environ.get("PRAZOAI_TEST_STORAGE") != "postgres",
                                reason="só quando as suítes rodam contra STORAGE=postgres")


def test_apps_de_teste_sobem_em_postgres_e_gravam_no_banco(make_app, pg_schema):
    from app.db.tables import deadlines, offices, users
    from app.repositories.sql import SqlUserRepository
    from app.repositories.sql.domain import SqlUnitOfWork
    from tests.deadline_utils import create

    app = make_app(OFFICES_ENABLED="true", password_hasher=fast_hasher())
    assert app.state.auth.storage == "postgres" and isinstance(app.state.auth.users, SqlUserRepository)
    assert isinstance(app.state.org.unit_of_work, SqlUnitOfWork)
    assert TestClient(app).get(f"{API}/health").json()["storage"] == "postgres"
    o = OrgClient(app)
    ana = o.person("ana")
    o.office(ana)
    create(o, ana)
    with pg_schema.connect() as c:
        counts = [c.execute(select(func.count()).select_from(t)).scalar_one() for t in (users, offices, deadlines)]
    assert counts == [1, 1, 1]

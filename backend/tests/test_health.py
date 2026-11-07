
import pytest
from fastapi.testclient import TestClient

import app.core.config as config_module
from app.main import create_app


@pytest.fixture
def client(monkeypatch):
    """Cliente com settings limpas por teste (sem cache compartilhado)."""
    config_module.get_settings.cache_clear()
    app = create_app()
    return TestClient(app, raise_server_exceptions=False)


def test_health_v1_ok(client):
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "service": "prazoai-backend"}


def test_health_legacy_alias_ok(client):
    # Alias legado de compatibilidade (contrato canônico é /api/v1/health).
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "service": "prazoai-backend"}


def test_404_padronizado_sem_stacktrace(client):
    resp = client.get("/api/v1/rota-inexistente")
    assert resp.status_code == 404
    body = resp.json()
    assert "error" in body and "code" in body["error"]
    s = str(body).lower()
    assert "traceback" not in s and "/home/" not in s


def test_422_padronizado(client):
    # /calcular-prazo exige 'dias' int; valor inválido → 422 padronizado.
    resp = client.get("/calcular-prazo", params={"data_inicial": "01/01/2026", "dias": "abc"})
    assert resp.status_code == 422
    body = resp.json()
    assert body["error"]["code"] == "validation_error"
    assert isinstance(body["error"].get("details"), list)


def test_500_sem_stacktrace(client, monkeypatch):
    # Força erro interno no serviço legado e verifica 500 genérico, sem vazamento.
    import app.main as main_module

    def boom(*_a, **_k):
        raise RuntimeError("segredo-interno /home/app/x.py")

    monkeypatch.setattr(main_module, "calcular_prazo", boom)
    resp = client.get("/calcular-prazo", params={"data_inicial": "01/01/2026", "dias": 5})
    assert resp.status_code == 500
    body = resp.json()
    assert body == {"error": {"code": "internal_error", "message": "Erro interno."}}
    s = str(body).lower()
    assert "traceback" not in s and "/home/" not in s and "segredo-interno" not in s


def test_legacy_root(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.json() == {"message": "API do sistema de prazos jurídicos"}


def test_legacy_calcular_prazo(client):
    resp = client.get("/calcular-prazo", params={"data_inicial": "01/01/2026", "dias": 5})
    assert resp.status_code == 200
    data = resp.json()
    assert data["data_inicial"] == "01/01/2026"
    assert data["dias"] == 5
    assert isinstance(data["data_final"], str) and len(data["data_final"]) == 10

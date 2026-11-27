
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import create_app


def _fresh_settings():
    get_settings.cache_clear()
    return get_settings()


def test_environment_invalido_rejeitado(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "qualquer-coisa")
    get_settings.cache_clear()
    with pytest.raises(Exception):
        get_settings()
    get_settings.cache_clear()


def test_production_incompleta_e_recusada_antes_de_criar_a_aplicacao(monkeypatch):
    # Doc 27: production só inicia com todos os requisitos; a documentação interativa fica desligada em
    # staging/production (conferido com a app real em tests/test_hosted_config.py).
    from app.core.config import HostedConfigError

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("AUTH_ENABLED", "false")
    get_settings.cache_clear()
    with pytest.raises(HostedConfigError):
        create_app()
    get_settings.cache_clear()


def test_development_liga_docs(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "development")
    get_settings.cache_clear()
    app = create_app()
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/openapi.json").status_code == 200
    get_settings.cache_clear()


def test_cors_rejeita_wildcard(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "*,http://localhost:3000")
    s = _fresh_settings()
    assert "*" not in s.cors_origin_list          # curinga descartado (inseguro c/ credenciais)
    assert "http://localhost:3000" in s.cors_origin_list
    assert s.cors_has_wildcard is True
    get_settings.cache_clear()


def test_cors_lista_multiplas_origens(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:3000, https://app.exemplo.com")
    s = _fresh_settings()
    assert s.cors_origin_list == ["http://localhost:3000", "https://app.exemplo.com"]
    get_settings.cache_clear()


def test_api_base_versionada():
    s = Settings(API_PREFIX="/api", API_VERSION_PREFIX="/v1")
    assert s.api_base == "/api/v1"


def test_api_version_prefix_invalido():
    with pytest.raises(Exception):
        Settings(API_VERSION_PREFIX="v1")  # sem barra inicial

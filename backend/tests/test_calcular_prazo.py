"""Issue #3 — validação de entrada em /calcular-prazo.

Cenários cobertos (conforme revisão do mantenedor):
- formato diferente de DD/MM/AAAA;
- data inexistente no calendário (ex.: 31/02/2026);
- string vazia;
- dias = 0 e dias negativo;
- entrada válida.

Entradas inválidas retornam 422 no formato padronizado da aplicação
({"error": {"code": "validation_error", ...}}), o mesmo dos demais DTOs.
"""
import pytest
from fastapi.testclient import TestClient

import app.core.config as config_module
from app.main import create_app
from app.services.prazo_service import calcular_prazo


@pytest.fixture
def client():
    config_module.get_settings.cache_clear()
    return TestClient(create_app(), raise_server_exceptions=False)


def obter_resposta(client: TestClient, data_inicial: str, dias: int | str):
    return client.get(
        "/calcular-prazo",
        params={"data_inicial": data_inicial, "dias": dias},
    )


def campos_invalidos(resposta) -> list[str]:
    """Campos apontados no erro padronizado de validação."""
    detalhes = resposta.json()["error"]["details"]
    return [item["field"] for item in detalhes]


def test_calcula_prazo_em_dias_uteis(client):
    resposta = obter_resposta(client, "02/11/2026", 5)

    assert resposta.status_code == 200
    assert resposta.json() == {
        "data_inicial": "02/11/2026",
        "dias": 5,
        "data_final": "09/11/2026",
    }


@pytest.mark.parametrize(
    "data_inicial",
    ["2026-11-07", "7/11/2026", "07-11-2026", "07/11/26"],
)
def test_data_em_formato_invalido_retorna_422(client, data_inicial):
    resposta = obter_resposta(client, data_inicial, 5)

    assert resposta.status_code == 422
    assert resposta.json()["error"]["code"] == "validation_error"
    assert "query.data_inicial" in campos_invalidos(resposta)


@pytest.mark.parametrize("data_inicial", ["31/02/2026", "29/02/2025"])
def test_data_inexistente_retorna_422(client, data_inicial):
    resposta = obter_resposta(client, data_inicial, 5)

    assert resposta.status_code == 422
    assert resposta.json()["error"]["code"] == "validation_error"
    assert "query.data_inicial" in campos_invalidos(resposta)


def test_data_vazia_retorna_422(client):
    resposta = obter_resposta(client, "", 5)

    assert resposta.status_code == 422
    assert resposta.json()["error"]["code"] == "validation_error"
    assert "query.data_inicial" in campos_invalidos(resposta)


def test_dias_zero_retorna_422(client):
    resposta = obter_resposta(client, "06/11/2026", 0)

    assert resposta.status_code == 422
    assert resposta.json()["error"]["code"] == "validation_error"
    assert "query.dias" in campos_invalidos(resposta)


def test_dias_negativos_retorna_422(client):
    resposta = obter_resposta(client, "07/11/2026", -5)

    assert resposta.status_code == 422
    assert resposta.json()["error"]["code"] == "validation_error"
    assert "query.dias" in campos_invalidos(resposta)


@pytest.mark.parametrize("dias", [0, -1])
def test_servico_rejeita_dias_nao_positivo(dias):
    with pytest.raises(ValueError):
        calcular_prazo("07/11/2026", dias)


def test_servico_rejeita_data_inexistente():
    with pytest.raises(ValueError):
        calcular_prazo("31/02/2026", 5)

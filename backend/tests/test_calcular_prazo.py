import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.prazo_service import calcular_prazo

client = TestClient(app)


def obter_resposta(data_inicial: str, dias: int):
    return client.get(
        "/calcular-prazo",
        params={"data_inicial": data_inicial, "dias": dias},
    )


def test_calcula_prazo_em_dias_uteis():
    resposta = obter_resposta("02/11/2026", 5)

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
def test_data_em_formato_invalido_retorna_422(data_inicial):
    resposta = obter_resposta(data_inicial, 5)

    assert resposta.status_code == 422
    erro = resposta.json()["detail"][0]
    assert erro["loc"] == ["query", "data_inicial"]
    assert "DD/MM/AAAA" in erro["msg"]


@pytest.mark.parametrize("data_inicial", ["31/02/2026", "29/02/2025"])
def test_data_inexistente_retorna_422(data_inicial):
    resposta = obter_resposta(data_inicial, 5)

    assert resposta.status_code == 422
    erro = resposta.json()["detail"][0]
    assert erro["loc"] == ["query", "data_inicial"]
    assert "não existe" in erro["msg"]


def test_data_vazia_retorna_422():
    resposta = obter_resposta("", 5)

    assert resposta.status_code == 422
    assert resposta.json()["detail"][0]["loc"] == ["query", "data_inicial"]


def test_dias_zero_retorna_422():
    resposta = obter_resposta("06/11/2026", 0)

    assert resposta.status_code == 422
    assert resposta.json()["detail"][0]["loc"] == ["query", "dias"]


def test_dias_negativos_retorna_422():
    resposta = obter_resposta("07/11/2026", -5)

    assert resposta.status_code == 422
    assert resposta.json()["detail"][0]["loc"] == ["query", "dias"]


@pytest.mark.parametrize("dias", [0, -1])
def test_servico_rejeita_dias_nao_positivo(dias):
    with pytest.raises(ValueError):
        calcular_prazo("07/11/2026", dias)

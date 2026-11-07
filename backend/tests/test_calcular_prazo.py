from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_calcula_prazo_em_dias_uteis():
    resposta = client.get(
        "/calcular-prazo", params={"data_inicial": "02/11/2026", "dias": 5}
    )

    assert resposta.status_code == 200
    assert resposta.json()["data_final"] == "09/11/2026"


def test_data_em_formato_invalido_retorna_400():
    resposta = client.get(
        "/calcular-prazo", params={"data_inicial": "2026-11-07", "dias": 5}
    )

    assert resposta.status_code == 400
    assert resposta.json()["detail"] == "data_inicial deve estar no formato DD/MM/AAAA"


def test_data_inexistente_retorna_400():
    resposta = client.get(
        "/calcular-prazo", params={"data_inicial": "31/02/2026", "dias": 5}
    )

    assert resposta.status_code == 400


def test_dias_negativos_retorna_erro_de_validacao():
    resposta = client.get(
        "/calcular-prazo", params={"data_inicial": "07/11/2026", "dias": -5}
    )

    assert resposta.status_code == 422


def test_dias_zero_mantem_a_data_inicial():
    resposta = client.get(
        "/calcular-prazo", params={"data_inicial": "06/11/2026", "dias": 0}
    )

    assert resposta.status_code == 200
    assert resposta.json()["data_final"] == "06/11/2026"

"""Issue #3 — validação de data_inicial e dias em /calcular-prazo.

Entradas inválidas devem resultar em HTTP 422 no formato padronizado do backend
({"error": {"code": "validation_error", ...}}), nunca em 500. A mesma regra existe
na camada de serviço (EntradaPrazoInvalidaError) como defesa.
"""
import pytest
from fastapi.testclient import TestClient

import app.core.config as config_module
from app.main import create_app
from app.services.prazo_service import EntradaPrazoInvalidaError, calcular_prazo


@pytest.fixture
def client():
    config_module.get_settings.cache_clear()
    return TestClient(create_app(), raise_server_exceptions=False)


def _assert_422_padronizado(resp, campo: str) -> None:
    assert resp.status_code == 422
    body = resp.json()
    assert body["error"]["code"] == "validation_error"
    assert body["error"]["message"] == "Dados inválidos."
    campos = [d["field"] for d in body["error"]["details"]]
    assert f"query.{campo}" in campos
    texto = str(body).lower()
    assert "traceback" not in texto and "/home/" not in texto and ".py" not in texto


# --- Rota HTTP --------------------------------------------------------------

def test_formato_iso_retorna_422(client):
    resp = client.get("/calcular-prazo", params={"data_inicial": "2026-12-01", "dias": 5})
    _assert_422_padronizado(resp, "data_inicial")


@pytest.mark.parametrize("data", ["31/02/2026", "29/02/2026", "00/01/2026", "15/13/2026"])
def test_data_inexistente_retorna_422(client, data):
    resp = client.get("/calcular-prazo", params={"data_inicial": data, "dias": 5})
    _assert_422_padronizado(resp, "data_inicial")


def test_string_vazia_retorna_422(client):
    resp = client.get("/calcular-prazo", params={"data_inicial": "", "dias": 5})
    _assert_422_padronizado(resp, "data_inicial")


def test_dias_zero_retorna_422(client):
    resp = client.get("/calcular-prazo", params={"data_inicial": "01/12/2026", "dias": 0})
    _assert_422_padronizado(resp, "dias")


def test_dias_negativo_retorna_422(client):
    resp = client.get("/calcular-prazo", params={"data_inicial": "01/12/2026", "dias": -3})
    _assert_422_padronizado(resp, "dias")


def test_data_valida_com_dias_validos_retorna_200(client):
    # 01/12/2026 (ter) + 5 dias úteis: 02, 03, 04, 07, 08 → 08/12/2026.
    resp = client.get("/calcular-prazo", params={"data_inicial": "01/12/2026", "dias": 5})
    assert resp.status_code == 200
    assert resp.json() == {"data_inicial": "01/12/2026", "dias": 5, "data_final": "08/12/2026"}


def test_sem_limite_arbitrario_de_365_dias(client):
    resp = client.get("/calcular-prazo", params={"data_inicial": "01/12/2026", "dias": 366})
    assert resp.status_code == 200


def test_dias_enorme_nao_vira_500(client):
    # Antes: OverflowError → 500. Agora: 422 (data fora do calendário suportado).
    resp = client.get("/calcular-prazo", params={"data_inicial": "01/12/2026", "dias": 10**9})
    _assert_422_padronizado(resp, "dias")


def test_health_continua_ok(client):
    assert client.get("/api/v1/health").status_code == 200


# --- Camada de serviço (defesa) -------------------------------------------------

@pytest.mark.parametrize("data", ["2026-12-01", "31/02/2026", "", "1/12/2026", "01-12-2026", "aa/bb/cccc"])
def test_servico_rejeita_data_invalida(data):
    with pytest.raises(EntradaPrazoInvalidaError) as exc:
        calcular_prazo(data, 5)
    assert exc.value.campo == "data_inicial"


@pytest.mark.parametrize("dias", [0, -1, -30])
def test_servico_rejeita_dias_menor_que_1(dias):
    with pytest.raises(EntradaPrazoInvalidaError) as exc:
        calcular_prazo("01/12/2026", dias)
    assert exc.value.campo == "dias"


def test_servico_converte_overflow_em_erro_de_validacao():
    # 24/12/9999 (sex) + 6 dias úteis ultrapassa 31/12/9999: não pode vazar OverflowError.
    with pytest.raises(EntradaPrazoInvalidaError) as exc:
        calcular_prazo("24/12/9999", 6)
    assert exc.value.campo == "dias"


def test_servico_aceita_entrada_valida():
    assert calcular_prazo("01/12/2026", 5) == "08/12/2026"

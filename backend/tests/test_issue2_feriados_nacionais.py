"""Issue #2 — feriados nacionais no cálculo de dias úteis.

Datas esperadas conferidas manualmente no calendário de 2026:
- 13/11/2026 (sex) + 5 dias úteis: 16, 17, 18, 19 (20/11 feriado; 21–22 fim de semana), 23 → 23/11/2026.
- 30/10/2026 (sex) + 1 dia útil: 31/10–01/11 fim de semana, 02/11 feriado → 03/11/2026.
- 10/09/2026 (qui) + 2 dias úteis: 11/09 (sex), 14/09 (seg), sem feriado → 14/09/2026.
"""
from datetime import date

import pytest
from fastapi.testclient import TestClient

import app.core.config as config_module
from app.main import create_app
from app.services.calendario import eh_dia_util, eh_feriado_nacional, feriados_nacionais
from app.services.prazo_service import calcular_prazo


@pytest.fixture
def client():
    config_module.get_settings.cache_clear()
    return TestClient(create_app(), raise_server_exceptions=False)


# --- Casos reportados na Issue #2 ---------------------------------------------

def test_consciencia_negra_20_11_2026_nao_conta_como_dia_util():
    assert calcular_prazo("13/11/2026", 5) == "23/11/2026"


def test_finados_02_11_2026_nao_conta_como_dia_util():
    assert calcular_prazo("30/10/2026", 1) == "03/11/2026"


def test_caso_comum_sem_feriado_continua_igual():
    assert calcular_prazo("10/09/2026", 2) == "14/09/2026"


def test_endpoint_legado_aplica_feriados(client):
    resp = client.get("/calcular-prazo", params={"data_inicial": "13/11/2026", "dias": 5})
    assert resp.status_code == 200
    assert resp.json() == {"data_inicial": "13/11/2026", "dias": 5, "data_final": "23/11/2026"}


# --- Calendário isolado ------------------------------------------------------

def test_feriados_nacionais_2026_incluem_os_reportados():
    feriados = feriados_nacionais(2026)
    assert date(2026, 11, 2) in feriados
    assert date(2026, 11, 20) in feriados
    assert len(feriados) == 9


def test_20_11_so_e_feriado_nacional_a_partir_de_2024():
    # Lei 14.759/2023: feriado nacional a partir de 2024.
    assert date(2023, 11, 20) not in feriados_nacionais(2023)
    assert date(2024, 11, 20) in feriados_nacionais(2024)


def test_dia_util_exclui_fim_de_semana_e_feriado():
    assert eh_dia_util(date(2026, 11, 19)) is True    # quinta comum
    assert eh_dia_util(date(2026, 11, 20)) is False   # feriado (sexta)
    assert eh_dia_util(date(2026, 11, 21)) is False   # sábado
    assert eh_dia_util(date(2026, 11, 2)) is False    # feriado (segunda)


def test_limitacao_documentada_nao_inclui_feriados_nao_nacionais():
    # Sexta-feira da Paixão (03/04/2026) não é feriado nacional por lei federal;
    # feriados estaduais, municipais e forenses estão fora do escopo.
    assert eh_feriado_nacional(date(2026, 4, 3)) is False

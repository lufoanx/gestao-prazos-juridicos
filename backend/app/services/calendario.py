"""Calendário de dias úteis com feriados nacionais brasileiros (Issue #2).

Abrangência (calendário próprio, sem dependência externa):
- exclui sábados e domingos;
- exclui os feriados nacionais fixos definidos em lei federal:
  - Lei 662/1949, com redação da Lei 10.607/2002: 01/01, 21/04, 01/05, 07/09,
    02/11, 15/11 e 25/12;
  - Lei 6.802/1980: 12/10 (Nossa Senhora Aparecida);
  - Lei 14.759/2023: 20/11 (Dia Nacional de Zumbi e da Consciência Negra),
    aplicado a partir de 2024.

NÃO contempla (limitações conhecidas):
- recesso forense (art. 220 do CPC) e suspensões de prazo;
- feriados estaduais e municipais (inclusive Sexta-feira da Paixão e Corpus
  Christi, que não são feriados nacionais por lei federal);
- pontos facultativos (ex.: Carnaval);
- calendários e feriados forenses específicos de cada tribunal.

Este módulo NÃO é cálculo processual oficial.
"""
from __future__ import annotations

from datetime import date, datetime
from functools import lru_cache

# (mês, dia) dos feriados nacionais fixos válidos em qualquer ano suportado.
_FERIADOS_FIXOS: tuple[tuple[int, int], ...] = (
    (1, 1),    # Confraternização Universal
    (4, 21),   # Tiradentes
    (5, 1),    # Dia do Trabalho
    (9, 7),    # Independência do Brasil
    (10, 12),  # Nossa Senhora Aparecida
    (11, 2),   # Finados
    (11, 15),  # Proclamação da República
    (12, 25),  # Natal
)

# 20/11 passou a ser feriado nacional pela Lei 14.759, de 21/12/2023.
_CONSCIENCIA_NEGRA = (11, 20)
_CONSCIENCIA_NEGRA_DESDE = 2024


@lru_cache(maxsize=256)
def feriados_nacionais(ano: int) -> frozenset[date]:
    """Retorna os feriados nacionais fixos do ano informado."""
    datas = {date(ano, mes, dia) for mes, dia in _FERIADOS_FIXOS}
    if ano >= _CONSCIENCIA_NEGRA_DESDE:
        datas.add(date(ano, *_CONSCIENCIA_NEGRA))
    return frozenset(datas)


def _como_data(dia: date | datetime) -> date:
    return dia.date() if isinstance(dia, datetime) else dia


def eh_feriado_nacional(dia: date | datetime) -> bool:
    """Indica se a data é feriado nacional (conforme a abrangência acima)."""
    d = _como_data(dia)
    return d in feriados_nacionais(d.year)


def eh_dia_util(dia: date | datetime) -> bool:
    """Dia útil = segunda a sexta que não seja feriado nacional."""
    d = _como_data(dia)
    return d.weekday() < 5 and not eh_feriado_nacional(d)

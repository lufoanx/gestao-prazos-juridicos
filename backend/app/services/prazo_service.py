from datetime import datetime, timedelta

from app.services.calendario import eh_dia_util

FORMATO_DATA = "%d/%m/%Y"


def calcular_prazo(data_inicial: str, dias: int):
    if dias < 1:
        raise ValueError("dias deve ser maior ou igual a 1")

    data = datetime.strptime(data_inicial, FORMATO_DATA)
    dias_adicionados = 0

    while dias_adicionados < dias:
        data += timedelta(days=1)

        if eh_dia_util(data):
            dias_adicionados += 1

    return data.strftime(FORMATO_DATA)

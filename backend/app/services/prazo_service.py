from datetime import datetime, timedelta

from app.services.calendario import eh_dia_util


def calcular_prazo(data_inicial: str, dias: int):
    data = datetime.strptime(data_inicial, "%d/%m/%Y")
    dias_adicionados = 0

    while dias_adicionados < dias:
        data += timedelta(days=1)

        if eh_dia_util(data):
            dias_adicionados += 1

    return data.strftime("%d/%m/%Y")

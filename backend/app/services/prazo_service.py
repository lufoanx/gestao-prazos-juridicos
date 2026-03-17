from datetime import datetime, timedelta

def calcular_prazo(data_inicial: str, dias: int):
    data = datetime.strptime(data_inicial, "%d/%m/%Y")
    dias_adicionados = 0

    while dias_adicionados < dias:
        data += timedelta(days=1)

        if data.weekday() < 5:
            dias_adicionados += 1

    return data.strftime("%d/%m/%Y")

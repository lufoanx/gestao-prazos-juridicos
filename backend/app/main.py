from datetime import datetime
from re import fullmatch
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from pydantic import AfterValidator

from app.services.prazo_service import calcular_prazo

app = FastAPI()

FORMATO_DATA = "%d/%m/%Y"


def validar_data_inicial(valor: str) -> str:
    """Aceita apenas DD/MM/AAAA e datas que existem no calendário."""
    if fullmatch(r"\d{2}/\d{2}/\d{4}", valor) is None:
        raise ValueError("data_inicial deve estar no formato DD/MM/AAAA")

    try:
        datetime.strptime(valor, FORMATO_DATA)
    except ValueError as exc:
        raise ValueError("data_inicial não existe no calendário") from exc

    return valor


DataInicial = Annotated[str, AfterValidator(validar_data_inicial)]


@app.get("/")
def read_root():
    return {"message": "API do sistema de prazos jurídicos"}


@app.get("/calcular-prazo")
def calcular(
    data_inicial: DataInicial,
    dias: Annotated[int, Query(ge=1)],
):
    try:
        resultado = calcular_prazo(data_inicial, dias)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "data_inicial": data_inicial,
        "dias": dias,
        "data_final": resultado
    }

from fastapi import FastAPI, HTTPException, Query
from app.services.prazo_service import calcular_prazo

app = FastAPI()


@app.get("/")
def read_root():
    return {"message": "API do sistema de prazos jurídicos"}


@app.get("/calcular-prazo")
def calcular(data_inicial: str, dias: int = Query(..., ge=0)):
    try:
        resultado = calcular_prazo(data_inicial, dias)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="data_inicial deve estar no formato DD/MM/AAAA",
        )

    return {
        "data_inicial": data_inicial,
        "dias": dias,
        "data_final": resultado
    }

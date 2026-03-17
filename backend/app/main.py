from fastapi import FastAPI
from app.services.prazo_service import calcular_prazo

app = FastAPI()

@app.get("/")
def read_root():
    return {"message": "API do sistema de prazos jurídicos"}

@app.get("/calcular-prazo")
def calcular(data_inicial: str, dias: int):
    resultado = calcular_prazo(data_inicial, dias)
    return {
        "data_inicial": data_inicial,
        "dias": dias,
        "data_final": resultado
    }

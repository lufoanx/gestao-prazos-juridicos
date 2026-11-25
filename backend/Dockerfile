# Backend PrazoAI (FastAPI) — imagem para homologação/produção (doc 27).
# - UM processo/worker: limites de taxa e fila de e-mail são por processo (WEB_CONCURRENCY=1).
# - --no-proxy-headers: o uvicorn NÃO reescreve o IP a partir de X-Forwarded-For; o IP do cliente chega
#   só pelo BFF com TRUSTED_PROXY_SECRET (app/api/deps.py).
# - Migrations NÃO rodam no startup: comando explícito (doc 27, §6) com a mesma imagem.
# - Nenhum segredo na imagem: tudo vem de variáveis do ambiente da plataforma.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    WEB_CONCURRENCY=1

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app

RUN useradd --system --uid 10001 --home-dir /srv prazoai
USER prazoai

EXPOSE 8000
# PORT é definido por muitas plataformas; 8000 por padrão.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --no-proxy-headers --no-server-header"]

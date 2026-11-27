# Scripts reproduzíveis do backend (FastAPI/Python).
# Observação: backend em Python não usa package.json/npm. Os alvos abaixo são os
# equivalentes a dev/test/lint/typecheck/build pedidos no enunciado.

VENV=.venv
PY=$(VENV)/bin/python
PIP=$(VENV)/bin/pip

install:
	python3 -m venv $(VENV)
	$(PIP) install -U pip
	$(PIP) install -r requirements-dev.txt

dev:
	$(VENV)/bin/uvicorn app.main:app --reload --port 8000 --no-proxy-headers

test:
	$(VENV)/bin/pytest

lint:
	$(VENV)/bin/ruff check app tests

typecheck:
	$(VENV)/bin/mypy app

build:
	# Backend interpretado (sem artefato de build). Valida a compilação dos módulos.
	$(PY) -m compileall app

# Regenera os locks com hash (CI e Docker instalam SÓ deles: --only-binary :all: --require-hashes).
# Rode depois de mudar requirements.txt ou requirements-dev.txt e faça commit dos dois .lock.
LOCK_OPTS=--python-version 3.12 --python-platform x86_64-manylinux_2_28 --generate-hashes --only-binary :all: --no-header
lock:
	uvx --from uv uv pip compile requirements.txt $(LOCK_OPTS) -o requirements.lock.tmp
	uvx --from uv uv pip compile requirements-dev.txt $(LOCK_OPTS) -o requirements-dev.lock.tmp
	@echo "Confira e renomeie: requirements.lock.tmp → requirements.lock (mantendo o cabeçalho GERADO)."

.PHONY: install dev test lint typecheck build lock

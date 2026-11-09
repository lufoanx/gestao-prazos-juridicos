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

.PHONY: install dev test lint typecheck build

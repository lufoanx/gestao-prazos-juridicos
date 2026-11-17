"""Verificações que FALHAM sem reproduzir valores sensíveis (correção da auditoria da E3).

Por que existe: a reescrita de `assert` do pytest explica os OPERANDOS de uma asserção que falha
(`assert x in msg.text` imprime o corpo inteiro; `assert segredo not in caplog.text` imprime o segredo e o
log; argumentos de chamadas dentro do `assert` também aparecem). Um `repr` opaco ou uma mensagem no
`assert` não evitam isso.

Regras:
- a condição é avaliada AQUI, fora de qualquer `assert` (este módulo não é reescrito: não é módulo de
  teste nem conftest, e não usa `assert`);
- a falha usa `pytest.fail(rótulo, pytrace=False)`: o relatório mostra só o rótulo (o requisito), sem
  traceback e, portanto, sem variáveis locais mesmo com `--showlocals`;
- rótulos nunca contêm valores; quem chama passa apenas o nome do requisito;
- `private_log_capture` captura os logs numa lista PRIVADA retirando temporariamente os handlers da raiz
  (inclusive os do pytest): os registros do bloco não chegam ao "Captured log" do relatório. Os
  handlers são restaurados em `finally`; os demais testes continuam com o diagnóstico normal.
"""
from __future__ import annotations

import logging
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager

import pytest


def require(condition: bool, requirement: str) -> None:
    """Falha com o NOME do requisito apenas (sem operandos, sem traceback)."""
    if not condition:
        pytest.fail(f"requisito não atendido: {requirement}", pytrace=False)


def require_contains(text: str, expected: str, requirement: str) -> None:
    require(expected in text, requirement)


def require_absent(text: str, secrets: Mapping[str, str], where: str) -> None:
    """Falha listando só os RÓTULOS dos segredos encontrados em `text`."""
    leaked = sorted(label for label, value in secrets.items() if value and value in text)
    if leaked:
        pytest.fail(f"requisito não atendido: {where} expõe {', '.join(leaked)}", pytrace=False)


class _ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.lines: list[str] = []
        self.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.lines.append(self.format(record))
        except Exception:                       # nunca propaga (nem imprime) o registro
            self.lines.append("<registro não formatável>")


class PrivateLogs:
    def __init__(self, handler: _ListHandler) -> None:
        self._handler = handler

    @property
    def text(self) -> str:
        return "\n".join(self._handler.lines)


@contextmanager
def private_log_capture(extra_loggers: Iterable[str] = ()) -> Iterator[PrivateLogs]:
    """Todos os registros do bloco vão SÓ para uma lista privada (nenhum handler do pytest os vê)."""
    root = logging.getLogger()
    handler = _ListHandler()
    saved_root = (root.handlers[:], root.level)
    saved_other = []
    for name in extra_loggers:                  # loggers que não propagam (nenhum no app hoje)
        lg = logging.getLogger(name)
        saved_other.append((lg, lg.handlers[:], lg.level, lg.propagate))
        lg.handlers = [handler]
        lg.setLevel(logging.DEBUG)
    root.handlers = [handler]
    root.setLevel(logging.DEBUG)
    try:
        yield PrivateLogs(handler)
    finally:
        root.handlers, level = saved_root
        root.setLevel(level)
        for lg, handlers, lvl, propagate in saved_other:
            lg.handlers = handlers
            lg.setLevel(lvl)
            lg.propagate = propagate

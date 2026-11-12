"""Base das transações em memória com ESCRITAS PREPARADAS (copy-on-write).

Cada transação trabalha sobre um `Fork` do estado confirmado:
- leituras veem as escritas da própria transação;
- a primeira escrita em um dicionário cria uma cópia rasa dele (os valores são
  imutáveis: dataclasses congeladas, `frozenset` e `tuple`, então a cópia rasa basta);
- o estado confirmado NUNCA é tocado durante a transação;
- o commit publica o novo estado trocando UMA referência por armazenamento; se algo
  falhar antes ou durante a publicação, as referências antigas são restauradas.

Assim, qualquer exceção (de regra, de capacidade, de invariante ou injetada nos testes)
descarta integralmente as alterações — inclusive em operações que tocam escritórios e
prazos ao mesmo tempo.
"""
from __future__ import annotations

from dataclasses import fields, replace
from typing import Any, Generic, TypeVar

S = TypeVar("S")


from app.domain.errors import ConsistencyError  # noqa: E402,F401  (reexportado por compatibilidade)


class Fork(Generic[S]):
    def __init__(self, base: S) -> None:
        self._base = base
        self._copies: dict[str, dict[Any, Any]] = {}

    def r(self, name: str) -> dict[Any, Any]:
        if name in self._copies:
            return self._copies[name]
        return getattr(self._base, name)

    def w(self, name: str) -> dict[Any, Any]:
        if name not in self._copies:
            self._copies[name] = dict(getattr(self._base, name))
        return self._copies[name]

    @property
    def changed(self) -> bool:
        return bool(self._copies)

    def build(self) -> S:
        return replace(self._base, **self._copies) if self._copies else self._base  # type: ignore[type-var]


def empty_state(cls: type[S]) -> S:
    return cls(**{f.name: {} for f in fields(cls)})  # type: ignore[arg-type]


def add_to_index(index: dict[str, frozenset[str]], key: str, value: str) -> None:
    index[key] = index.get(key, frozenset()) | {value}


def remove_from_index(index: dict[str, frozenset[str]], key: str, value: str) -> None:
    current = index.get(key)
    if current is None:
        return
    remaining = current - {value}
    if remaining:
        index[key] = remaining
    else:
        del index[key]

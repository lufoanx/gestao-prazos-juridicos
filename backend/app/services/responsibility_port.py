"""Porta de responsabilidades (prazos) usada por remoção e saída de membros.

A regra do projeto exige reatribuir os prazos em aberto antes de remover alguém. O
módulo de prazos só existe na Etapa 4. Até lá, o adaptador padrão é
`UnavailableResponsibilityPort`: ele recusa a consulta, e remoção/saída respondem
409 `responsibility_module_unavailable` SEM qualquer efeito (nenhum vínculo removido,
nenhum sucessor promovido). Não há "contagem sempre zero".

Contrato para a Etapa 4:
- os métodos são chamados DENTRO da transação do escritório, depois de todas as
  verificações de autorização e invariantes e ANTES de qualquer escrita de vínculo;
- `reassign_open` deve ser atômica: reatribui tudo ou nada (levanta exceção em falha);
- com banco, deve participar da MESMA transação; em memória, ordem de locks fixa:
  escritórios → prazos (nunca o inverso), para evitar deadlock.
"""
from __future__ import annotations

from typing import Protocol


class ResponsibilityModuleUnavailableError(Exception):
    """O módulo de responsabilidades (prazos) ainda não está integrado."""


class ResponsibilityPort(Protocol):
    def count_open(self, office_id: str, user_id: str) -> int:
        """Quantidade de responsabilidades em aberto do usuário no escritório."""
        ...

    def reassign_open(self, office_id: str, from_user_id: str, to_user_id: str) -> int:
        """Reatribui atomicamente todas as responsabilidades em aberto; retorna quantas."""
        ...


class UnavailableResponsibilityPort:
    """Adaptador padrão até a Etapa 4: bloqueia explicitamente os fluxos dependentes."""

    def count_open(self, office_id: str, user_id: str) -> int:
        raise ResponsibilityModuleUnavailableError()

    def reassign_open(self, office_id: str, from_user_id: str, to_user_id: str) -> int:
        raise ResponsibilityModuleUnavailableError()

"""Verificações da E3 sobre a mensagem capturada, o link e os logs — SANITIZADAS (ver
`tests/sensitive_checks.py`). Os mesmos funções são usadas pelos testes reais (`test_recovery_mailpit`)
e pela prova negativa (`test_recovery_mail_checks_negative`), que as exercita com dados fictícios.
"""
from __future__ import annotations

import urllib.parse
from datetime import datetime
from zoneinfo import ZoneInfo

from app.security.tokens import hash_opaque_token
from tests.sensitive_checks import require, require_absent, require_contains

SUBJECT = "PrazoAI: redefinição de senha"
RESET_PATH = "/redefinir-senha"


def local_fmt(moment: datetime, tz: str) -> str:
    return moment.astimezone(ZoneInfo(tz)).strftime("%d/%m/%Y %H:%M") + f" ({tz})"


def extract_reset_token(text: str, origin: str) -> str:
    """Token do ÚNICO link de redefinição, conferindo origem, caminho, query e fragmento."""
    links = [w for w in text.split() if w.startswith(f"{origin}{RESET_PATH}")]
    require(len(links) == 1, "corpo: exatamente um link de redefinição")
    link = urllib.parse.urlsplit(links[0])
    require(f"{link.scheme}://{link.netloc}" == origin, "link: origem pública configurada")
    require(link.path == RESET_PATH, "link: caminho sem token")
    require(link.query == "", "link: sem query")
    token = link.fragment
    require(bool(token), "link: token no fragmento")
    require(token not in link.path and token not in link.query, "link: token só no fragmento")
    return token


def check_message(msg, *, origin: str, from_name: str, from_address: str, recipient: str) -> str:
    """Cabeçalhos e link; devolve o token (nunca impresso)."""
    require(msg.from_address == from_address and msg.from_name == from_name, "mensagem: remetente configurado")
    require(msg.to == (recipient,), "mensagem: destinatário único e correto")
    require(msg.subject == SUBJECT, "mensagem: assunto")
    return extract_reset_token(msg.text, origin)


def check_persisted_instants(msg, *, created_at: datetime, expires_at: datetime, tz: str) -> None:
    require_contains(msg.text, f"Gerado em: {local_fmt(created_at, tz)}", "corpo: 'Gerado em' = registro persistido")
    require_contains(msg.text, f"Válido até: {local_fmt(expires_at, tz)}",
                     "corpo: 'Válido até' = registro persistido")
    require_contains(msg.text, "apenas o link gerado por último funciona", "corpo: aviso de que só o último link vale")


def check_only_hash_stored(token: str, *, stored_hash: str, row_dump: str) -> None:
    require(stored_hash == hash_opaque_token(token), "banco: hash do token recebido")
    require(token not in row_dump, "banco: token em claro ausente")


def check_logs_clean(log_text: str, secrets: dict[str, str]) -> None:
    require_absent(log_text, secrets, "log")

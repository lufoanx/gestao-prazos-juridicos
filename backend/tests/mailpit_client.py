"""Cliente de TESTE da API do capturador Mailpit (E3 do doc 21). Nunca usado pelo código do produto.

- Só aceita API em loopback (capturador local descartável).
- Devolve objetos cujo `repr` NÃO mostra corpo, destinatário nem link: uma asserção que falhe não
  imprime o conteúdo sensível da mensagem (o link contém o token).
- Esperas são por CONDIÇÃO observável na API, com prazo apenas de proteção contra travamento.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

LOOPBACK = frozenset({"127.0.0.1", "localhost", "::1"})


class MailpitConfigError(ValueError):
    pass


@dataclass(frozen=True)
class CapturedMessage:
    id: str
    from_address: str
    from_name: str
    to: tuple[str, ...]
    subject: str
    text: str = field(repr=False)

    def __repr__(self) -> str:                     # nunca expõe corpo, link ou destinatário
        return f"CapturedMessage(id={self.id!r})"


class MailpitClient:
    def __init__(self, api_url: str, *, timeout: float = 5.0) -> None:
        parts = urllib.parse.urlsplit(api_url)
        if parts.scheme != "http" or parts.hostname not in LOOPBACK or parts.path not in ("", "/"):
            raise MailpitConfigError("API do capturador deve ser http://<loopback>:<porta> (somente local).")
        self._base = f"http://{parts.netloc}"
        self._timeout = timeout

    # -------------------------------------------------------------- HTTP
    def _request(self, method: str, path: str):
        req = urllib.request.Request(self._base + path, method=method)
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:   # noqa: S310 (loopback validado)
            body = resp.read()
        return json.loads(body) if body and body[:1] in (b"{", b"[") else None

    # -------------------------------------------------------------- consultas
    def ready(self) -> bool:
        try:
            req = urllib.request.Request(self._base + "/readyz")
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:  # noqa: S310
                return resp.status == 200
        except OSError:
            return False

    def wait_ready(self, timeout: float = 30.0) -> None:
        deadline = time.monotonic() + timeout
        while not self.ready():
            if time.monotonic() >= deadline:
                raise AssertionError("capturador SMTP não respondeu (proteção contra travamento)")
            time.sleep(0.2)

    def count(self) -> int:
        return int(self._request("GET", "/api/v1/messages?limit=1")["messages_count"])

    def delete_all(self) -> None:
        self._request("DELETE", "/api/v1/messages")

    def summaries(self) -> list[dict]:
        """Lista (mais recentes primeiro, como devolve a API) — só metadados."""
        return list(self._request("GET", "/api/v1/messages?limit=200")["messages"])

    def message(self, message_id: str) -> CapturedMessage:
        data = self._request("GET", f"/api/v1/message/{urllib.parse.quote(message_id)}")
        sender = data.get("From") or {}
        return CapturedMessage(
            id=data["ID"], from_address=sender.get("Address", ""), from_name=sender.get("Name", ""),
            to=tuple(r.get("Address", "") for r in data.get("To") or []), subject=data.get("Subject", ""),
            text=data.get("Text", ""),
        )

    def messages_to(self, address: str) -> list[CapturedMessage]:
        """Mensagens para `address`, em ordem de CHEGADA (mais antiga primeiro)."""
        query = urllib.parse.quote(f'to:"{address}"')
        found = self._request("GET", f"/api/v1/search?query={query}&limit=200")["messages"]
        return [self.message(m["ID"]) for m in reversed(found)]

    def wait_count(self, expected: int, timeout: float = 15.0) -> int:
        """Espera a contagem TOTAL chegar a `expected` (condição observável; prazo só de proteção)."""
        deadline = time.monotonic() + timeout
        while True:
            current = self.count()
            if current >= expected or time.monotonic() >= deadline:
                return current
            time.sleep(0.1)

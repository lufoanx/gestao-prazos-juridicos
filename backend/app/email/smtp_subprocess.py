"""Transporte SMTP em SUBPROCESSO supervisionado (doc 21, §4.6 e §4.9). Só Linux nesta fase.

Fases, com orçamento medido por relógio MONOTÔNICO:
  1. criação (`Popen`) — FORA do lock; a aplicação só MEDE a duração (o sistema operacional decide);
  2. comunicação/execução — `communicate(timeout=restante)`, restante = prazo − tempo já gasto;
  3. tolerância ao SIGTERM — `killpg(SIGTERM)` + `wait(timeout=term_grace)`;
  4. escalonamento — `killpg(SIGKILL)`;
  5. coleta — `wait(timeout=reap_timeout)`; NUNCA `wait()` sem timeout.
Falha de coleta → transporte INDISPONÍVEL: nenhum outro filho é criado e nada é repetido.

Coordenação com `cancel()` (parada pedida por quem desliga o serviço):
- `send` reserva o estado "criando" sob o lock e chama `Popen` FORA dele; `cancel()` nunca espera um
  lock retido durante uma criação sem prazo;
- ao voltar de `Popen`, sob o lock: se a parada foi pedida, o filho é encerrado ANTES de receber a
  mensagem (resultado `cancelled`); senão é publicado, e um `cancel()` posterior o encerra.
Segredos e mensagem vão SÓ pelo pipe de entrada; argumentos e ambiente não carregam nada sensível.
Nenhum objeto de exceção é registrado (poderia carregar conteúdo); só categorias e duração.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

from app.email.config import EmailConfig
from app.email.message import CHILD_CATEGORIES, OutgoingEmail, SendResult
from app.email.transport import UnsupportedPlatformError

logger = logging.getLogger("prazoai.email")
CHILD_SCRIPT = Path(__file__).resolve().with_name("smtp_child.py")
MAX_CHILD_OUTPUT = 64
MINIMAL_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}


def ensure_supported_platform() -> None:
    """Exige POSIX com grupos de processos e `resource` (Linux/contêiner nesta fase)."""
    if os.name != "posix" or not sys.platform.startswith("linux") or not hasattr(os, "killpg"):
        raise UnsupportedPlatformError("EMAIL_TRANSPORT=smtp é suportado somente em Linux nesta fase.")
    try:
        import resource  # noqa: F401
    except ImportError:
        raise UnsupportedPlatformError("EMAIL_TRANSPORT=smtp exige o módulo 'resource' (Linux).") from None


class SubprocessSmtpTransport:
    def __init__(self, config: EmailConfig, *, script: Path = CHILD_SCRIPT, python: str | None = None,
                 popen: Callable[..., subprocess.Popen] = subprocess.Popen,
                 monotonic: Callable[[], float] = time.monotonic) -> None:
        ensure_supported_platform()
        self._cfg = config
        self._script = Path(script).resolve()
        self._python = python or sys.executable          # caminho do interpretador em uso (confiável)
        self._popen = popen
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self._creating = False
        self._child: subprocess.Popen | None = None      # publicado; None quando coletado
        self._stop = False
        self._available = True
        self.spawned = 0                                 # filhos criados (observabilidade e testes)

    # ------------------------------------------------------------ estado
    @property
    def available(self) -> bool:
        with self._lock:
            return self._available and not self._stop

    def cancel(self) -> None:
        """Parada coordenada. Não espera nenhuma criação; encerra um filho já publicado."""
        with self._lock:
            self._stop = True
            child = self._child
        if child is not None and not self._terminate(child):
            with self._lock:
                self._available = False                # filho sem encerramento confirmado
            logger.error("email_smtp_reap_failed")

    # ------------------------------------------------------------ envio
    def send(self, message: OutgoingEmail) -> SendResult:
        started = self._monotonic()
        with self._lock:
            if self._stop:
                return self._done(SendResult.CANCELLED, started)
            if not self._available or self._creating or self._child is not None:
                return self._done(SendResult.UNAVAILABLE, started)    # nunca dois filhos
            self._creating = True                                      # reserva sob o lock
        payload = self._payload(message)
        try:
            child = self._popen(
                [self._python, "-I", str(self._script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, env=dict(MINIMAL_ENV), cwd="/", close_fds=True,
                start_new_session=True, shell=False,
            )
        except OSError:
            with self._lock:
                self._creating = False
            return self._done(SendResult.SPAWN_FAILED, started)
        self.spawned += 1
        with self._lock:
            self._creating = False
            self._child = child                                        # publicado
            stop_requested = self._stop
        if stop_requested:                                             # parada antes de transmitir
            self._finish(child, self._terminate(child))
            return self._done(SendResult.CANCELLED, started)
        remaining = self._cfg.send_deadline_seconds - (self._monotonic() - started)
        result = SendResult.DEADLINE_KILLED
        if remaining > 0:
            try:
                out, _ = child.communicate(payload, timeout=remaining)
                result = self._parse(child.returncode, out)
            except subprocess.TimeoutExpired:
                result = SendResult.DEADLINE_KILLED
            except OSError:
                result = SendResult.ERROR
        reaped = self._terminate(child) if child.poll() is None else True
        self._finish(child, reaped)
        with self._lock:
            if self._stop and result is not SendResult.ACCEPTED:
                result = SendResult.CANCELLED
        if not reaped:
            return self._done(SendResult.UNAVAILABLE, started, reap_failed=True)
        return self._done(result, started)

    # ------------------------------------------------------------ fases 3 a 5
    def _terminate(self, child: subprocess.Popen) -> bool:
        """SIGTERM → espera limitada → SIGKILL → coleta limitada. True se coletado."""
        import signal

        if child.poll() is not None:
            return True
        self._signal_group(child, signal.SIGTERM)
        try:
            child.wait(timeout=self._cfg.term_grace_seconds)
            return True
        except subprocess.TimeoutExpired:
            pass
        self._signal_group(child, signal.SIGKILL)
        try:
            child.wait(timeout=self._cfg.reap_timeout_seconds)
            return True
        except subprocess.TimeoutExpired:
            return False

    @staticmethod
    def _signal_group(child: subprocess.Popen, sig: int) -> None:
        try:
            os.killpg(child.pid, sig)                  # o filho lidera a própria sessão/grupo
        except (ProcessLookupError, PermissionError):
            pass

    def _finish(self, child: subprocess.Popen, reaped: bool) -> None:
        for stream in (child.stdin, child.stdout):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass
        with self._lock:
            if reaped:
                if self._child is child:
                    self._child = None
            else:
                self._available = False                # filho sem encerramento confirmado
                logger.error("email_smtp_reap_failed")

    # ------------------------------------------------------------ auxiliares
    def _payload(self, message: OutgoingEmail) -> bytes:
        c = self._cfg
        return json.dumps({
            "config": {"host": c.smtp_host, "port": c.smtp_port, "security": c.security, "timeout": c.timeout_seconds,
                       "username": c.username, "password": c.password, "ca_file": c.ca_file,
                       "from_display": c.from_display, "from_address": c.from_address},
            "message": {"to": message.to, "subject": message.subject, "text": message.text},
        }).encode("utf-8")

    @staticmethod
    def _parse(returncode: int | None, out: bytes | None) -> SendResult:
        if returncode != 0 or not out or len(out) > MAX_CHILD_OUTPUT:
            return SendResult.INVALID_OUTPUT
        category = out.decode("ascii", errors="replace").strip()
        return SendResult(category) if category in CHILD_CATEGORIES else SendResult.INVALID_OUTPUT

    def _done(self, result: SendResult, started: float, *, reap_failed: bool = False) -> SendResult:
        logger.info("email_send result=%s duration_ms=%d%s", result.value,
                    int((self._monotonic() - started) * 1000), " reap_failed=true" if reap_failed else "")
        return result

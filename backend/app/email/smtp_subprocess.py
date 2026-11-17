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
import sysconfig
import threading
import time
from collections.abc import Callable
from pathlib import Path

from app.core.deadline import Deadline
from app.email.config import EmailConfig
from app.email.message import CHILD_CATEGORIES, OutgoingEmail, SendResult
from app.email.transport import UnsupportedPlatformError

logger = logging.getLogger("prazoai.email")
CHILD_SCRIPT = Path(__file__).resolve().with_name("smtp_child.py")
MAX_CHILD_OUTPUT = 64
MINIMAL_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
PROC_MAPS = "/proc/self/maps"                            # mapeamentos DESTE processo (Linux)
_config_var = sysconfig.get_config_var                   # ponto de injeção para testes


def _loaded_libpython_dir() -> str | None:
    """Diretório de onde ESTE processo carregou a `libpython` compartilhada; None se o interpretador é
    estático ou se a biblioteca não aparece nos mapeamentos.

    Correção da E4 (doc 21, §21): o Python do `actions/setup-python` é compilado com `--enable-shared` e
    RUNPATH ABSOLUTO para `/opt/hostedtoolcache/...`; dentro de um contêiner de job o toolcache fica em
    outro caminho (`/__t/...`) e o processo pai só encontra a biblioteca porque o setup-python exporta
    LD_LIBRARY_PATH. O filho, com o ambiente mínimo, não a encontrava e terminava antes de executar o
    script (código 127). O caminho vem do que o carregador REALMENTE mapeou para o processo atual — não
    da configuração de compilação (que aponta para o caminho original) nem do ambiente herdado.
    """
    if not _config_var("Py_ENABLE_SHARED"):
        return None
    soname = _config_var("INSTSONAME")
    if not isinstance(soname, str) or not soname:
        return None
    try:
        with open(PROC_MAPS, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                parts = line.rstrip("\n").split(None, 5)
                if len(parts) == 6 and os.path.isabs(parts[5]) and os.path.basename(parts[5]) == soname:
                    return os.path.dirname(parts[5])
    except OSError:
        return None
    return None


def child_env(python: str) -> dict[str, str]:
    """Ambiente do filho: MINIMAL_ENV e, SOMENTE quando o filho é o próprio interpretador em uso e ele
    depende de `libpython` compartilhada, LD_LIBRARY_PATH com UM diretório — o da biblioteca já
    carregada por este processo. Nada mais do ambiente do pai é repassado (nem o LD_LIBRARY_PATH dele)."""
    env = dict(MINIMAL_ENV)
    if os.path.realpath(python) != os.path.realpath(sys.executable):
        return env                                       # outro interpretador: não sabemos o que ele carrega
    libdir = _loaded_libpython_dir()
    if libdir:
        env["LD_LIBRARY_PATH"] = libdir
    return env


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
        self._child_env = child_env(self._python)        # calculado uma vez; sem E/S por envio
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
        """Leitura SEM lock (E2, correção da auditoria): é consultada pela admissão do despachante e não
        pode bloquear dentro de outra seção crítica. As duas flags só mudam num sentido (`_available`
        True→False, `_stop` False→True) e cada leitura de atributo é atômica; um valor um instante
        atrasado é seguro porque `send` revalida tudo sob o lock antes de qualquer etapa."""
        return self._available and not self._stop

    @property
    def has_unconfirmed_child(self) -> bool:
        """Leitura sem prazo (testes/observação). No encerramento use `unconfirmed_child(timeout)`."""
        with self._lock:
            return self._creating or self._child is not None

    def unconfirmed_child(self, timeout: float) -> bool | None:
        """Criação em curso ou filho sem coleta confirmada; None se o lock não vier no prazo (desconhecido)."""
        if not self._lock.acquire(timeout=max(0.0, timeout)):
            return None
        try:
            return self._creating or self._child is not None
        finally:
            self._lock.release()

    def cancel(self, timeout: float | None = None) -> bool:
        """Parada coordenada. Não espera nenhuma criação; encerra um filho já publicado.

        `timeout` (E2): orçamento TOTAL desta chamada, contado desde a ENTRADA — inclui a aquisição do
        lock, SIGTERM, SIGKILL e coleta (correção da auditoria: antes o lock era adquirido sem prazo).
        Sem `timeout`, valem os limites configurados (comportamento da E1).
        Devolve True só com confirmação (nenhum filho publicado ou filho coletado). Sem o lock no prazo,
        a parada e a indisponibilidade são marcadas sem lock (flags de sentido único; `send` as relê sob o
        lock antes de criar ou transmitir) e o resultado é False: o estado do filho não foi confirmado.
        """
        deadline = Deadline(timeout, self._monotonic)
        if not deadline.acquire(self._lock):
            self._stop = True
            self._available = False
            logger.error("email_smtp_cancel_unconfirmed reason=lock_timeout")
            return False
        try:
            self._stop = True
            child = self._child
            creating = self._creating
        finally:
            self._lock.release()
        if child is None:
            return not creating                        # criação em curso: será encerrada por `send`
        if self._terminate(child, deadline=deadline):
            return True
        # Filho sem encerramento confirmado → indisponível. A publicação NÃO pode esperar além do prazo
        # (correção da 2ª auditoria: aqui havia um `with self._lock` sem prazo). Com tempo restante, sob o
        # lock; senão, escrita sem lock da flag de sentido único (True→False), que `send` relê sob o lock.
        if deadline.acquire(self._lock):
            try:
                self._available = False
            finally:
                self._lock.release()
        else:
            self._available = False
        logger.error("email_smtp_reap_failed")
        return False

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
                stderr=subprocess.DEVNULL, env=dict(self._child_env), cwd="/", close_fds=True,
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
    def _terminate(self, child: subprocess.Popen, deadline: Deadline | None = None) -> bool:
        """SIGTERM → espera limitada → SIGKILL → coleta limitada. True se coletado.

        Com `deadline` (fixado pelo chamador na entrada da operação), as duas esperas usam só o tempo
        restante: a tolerância ao SIGTERM usa no máximo metade dele, para sobrar tempo à coleta."""
        import signal

        if child.poll() is not None:
            return True
        deadline = deadline or Deadline(None, self._monotonic)

        def limit(configured: float, share: float = 1.0) -> float:
            if not deadline.bounded:
                return configured
            return max(0.0, min(configured, deadline.remaining() * share))

        self._signal_group(child, signal.SIGTERM)
        try:
            child.wait(timeout=limit(self._cfg.term_grace_seconds, 0.5))
            return True
        except subprocess.TimeoutExpired:
            pass
        self._signal_group(child, signal.SIGKILL)
        try:
            child.wait(timeout=limit(self._cfg.reap_timeout_seconds))
            return True
        except subprocess.TimeoutExpired:
            return child.poll() is not None

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

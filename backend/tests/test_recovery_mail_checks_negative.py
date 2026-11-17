"""Prova NEGATIVA da correção da auditoria da E3: falhas das verificações sensíveis não reproduzem o
segredo no relatório.

Executa o pytest num SUBPROCESSO com um módulo sintético e dados inteiramente FICTÍCIOS (token aleatório
gerado aqui, passado pelo ambiente; nenhuma conta, banco ou capturador). O módulo sintético usa as MESMAS
funções que os testes reais da E3 (`tests/recovery_mail_checks.py`):
1. divergência deliberada no texto da mensagem ("Gerado em" diferente do registro);
2. token fictício deliberadamente registrado no log.
O subprocesso roda com `--showlocals`, `--log-level=DEBUG` e JUnit com `junit_logging=all` (o máximo de
diagnóstico). A FALHA do subprocesso é o resultado ESPERADO; este teste (o externo) passa quando:
- o subprocesso falha exatamente nos dois casos;
- stdout, stderr e o JUnit não contêm o token, o link completo nem o corpo sensível;
- o diagnóstico sanitizado identifica o requisito violado em cada caso.
As verificações do teste externo também usam `require` (nada do conteúdo é impresso se ele falhar).
"""
from __future__ import annotations

import os
import secrets
import subprocess
import sys
from pathlib import Path

from tests.sensitive_checks import require

BACKEND = Path(__file__).resolve().parents[1]

SYNTHETIC = '''
import logging
import os
from datetime import datetime, timezone

from tests.mailpit_client import CapturedMessage
from tests.recovery_mail_checks import check_logs_clean, check_message, check_persisted_instants
from tests.sensitive_checks import private_log_capture

ORIGIN = "http://localhost:3000"
TOKEN = os.environ["PRAZOAI_NEG_TOKEN"]
BODY = (
    "Recebemos um pedido para redefinir a senha da sua conta (corpo ficticio).\\n"
    f"{ORIGIN}/redefinir-senha#{TOKEN}\\n"
    "Gerado em: 01/01/2030 10:00 (America/Sao_Paulo)\\n"
    "Valido ate: 01/01/2030 10:30 (America/Sao_Paulo)\\n"
)


def _msg():
    return CapturedMessage(id="ficticio", from_address="nao-responda@exemplo.com", from_name="PrazoAI",
                           to=("ficticia@exemplo.com",), subject="PrazoAI: redefinição de senha", text=BODY)


def test_caso_1_divergencia_no_texto_da_mensagem():
    msg = _msg()
    token = check_message(msg, origin=ORIGIN, from_name="PrazoAI", from_address="nao-responda@exemplo.com",
                          recipient="ficticia@exemplo.com")
    created = datetime(2031, 6, 1, 12, 0, tzinfo=timezone.utc)      # DIVERGE do corpo (deliberado)
    check_persisted_instants(msg, created_at=created, expires_at=created, tz="America/Sao_Paulo")
    del token


def test_caso_2_token_presente_no_log():
    with private_log_capture() as logs:
        logging.getLogger("prazoai.recovery").warning("vazamento deliberado %s", TOKEN)
    check_logs_clean(logs.text, {"token": TOKEN, "link do token": f"redefinir-senha#{TOKEN}"})
'''


def test_falhas_sensiveis_nao_reproduzem_segredos_no_relatorio(tmp_path):
    token = "ficticio_" + secrets.token_urlsafe(24)
    link = f"http://localhost:3000/redefinir-senha#{token}"
    body_marker = "Recebemos um pedido para redefinir a senha da sua conta (corpo ficticio)"
    module = tmp_path / "test_sintetico_sensivel.py"
    module.write_text(SYNTHETIC, encoding="utf-8")
    junit = tmp_path / "relatorio.xml"
    env = {**os.environ, "PRAZOAI_NEG_TOKEN": token, "PYTHONPATH": str(BACKEND), "ENVIRONMENT": "test"}
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", str(module), "-p", "no:cacheprovider", "-o", "addopts=",
         "-o", "junit_logging=all", "--junitxml", str(junit), "--showlocals", "--log-level=DEBUG", "-rA",
         "--rootdir", str(tmp_path)],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120,
    )
    out, err = proc.stdout, proc.stderr
    report = junit.read_text(encoding="utf-8") if junit.exists() else ""

    # Falha ESPERADA do subprocesso: exatamente os dois casos.
    require(proc.returncode == 1, "subprocesso: deve falhar (código 1)")
    require("2 failed" in out, "subprocesso: os dois casos falham")
    require(bool(report), "subprocesso: relatório JUnit gerado")
    # Nenhum segredo em stdout, stderr ou JUnit.
    for label, text in (("stdout", out), ("stderr", err), ("junit", report)):
        require(token not in text, f"{label}: sem o token fictício")
        require(link not in text, f"{label}: sem o link completo")
        require(body_marker not in text, f"{label}: sem o corpo sensível")
        require("redefinir-senha#" not in text, f"{label}: sem fragmento de link")
    # Diagnóstico sanitizado ainda identifica o requisito violado.
    require("requisito não atendido: corpo: 'Gerado em' = registro persistido" in out,
            "diagnóstico: identifica o requisito do caso 1")
    require("requisito não atendido: log expõe token" in out,
            "diagnóstico: identifica o requisito do caso 2")
    require("test_caso_1_divergencia_no_texto_da_mensagem" in report
            and "test_caso_2_token_presente_no_log" in report, "junit: nomeia os dois casos")

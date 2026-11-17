"""Correção da E4 (doc 21, §21) — ambiente do filho SMTP com interpretador de `libpython` compartilhada.

Causa comprovada no CI: o Python do `actions/setup-python`, usado dentro do contêiner oficial do
Playwright, tem RUNPATH absoluto para `/opt/hostedtoolcache/...` (inexistente no contêiner, onde o
toolcache fica em `/__t/...`). O pai encontra a `libpython` pelo LD_LIBRARY_PATH exportado pelo
setup-python; o filho, com o ambiente mínimo, terminava com 127 antes de executar o script.

SIMULAÇÕES (identificadas): os mapeamentos do processo e as variáveis de compilação são injetados para
cobrir interpretador compartilhado/estático em qualquer máquina. O teste REAL final inicia o
interpretador em uso com o ambiente que o transporte entrega ao filho: falha antes da correção quando o
interpretador é compartilhado e relocado (como no job `integration`) e passa depois; em interpretadores
estáticos ou com RUNPATH válido ele passa nos dois casos (registrado no doc 21).
"""
from __future__ import annotations

import subprocess
import sys

import pytest

import app.email.smtp_subprocess as sp
from app.email.message import SendResult
from tests.test_email_transport import MSG, config, transport

pytestmark = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="transporte SMTP só em Linux")

SONAME = "libpython3.12.so.1.0"
LIBDIR = "/__t/Python/3.12.16/x64/lib"                   # forma do caminho no contêiner do job (fictícia aqui)
SECRET = "segredo-do-pai-que-nao-pode-vazar-7c1"


class EnvCapture:
    """Popen dublê: registra o ambiente pedido e falha a criação (nenhum processo é iniciado)."""

    def __init__(self):
        self.envs: list[dict[str, str]] = []

    def __call__(self, *a, **kw):
        self.envs.append(dict(kw["env"]))
        raise OSError("criação simulada recusada")


def fake_maps(tmp_path, *paths: str):
    lines = [f"7f00000{i}000-7f00000{i}fff r-xp 00000000 08:01 {100 + i}                      {p}\n"
             for i, p in enumerate(paths)]
    lines.append("7ffd00000000-7ffd00021000 rw-p 00000000 00:00 0                          [stack]\n")
    f = tmp_path / "maps"
    f.write_text("".join(lines))
    return str(f)


def shared(name):
    return {"Py_ENABLE_SHARED": 1, "INSTSONAME": SONAME}.get(name)


def static(name):
    return {"Py_ENABLE_SHARED": 0, "INSTSONAME": SONAME}.get(name)


@pytest.fixture
def parent_env(monkeypatch):
    """O pai tem LD_LIBRARY_PATH próprio e um segredo: nenhum dos dois pode chegar ao filho."""
    monkeypatch.setenv("LD_LIBRARY_PATH", f"/caminho/do/pai:{LIBDIR}")
    monkeypatch.setenv("PRAZOAI_SEGREDO_TESTE", SECRET)


def env_sent(**kw) -> dict[str, str]:
    cap = EnvCapture()
    assert transport(config(1), popen=cap, **kw).send(MSG) is SendResult.SPAWN_FAILED
    assert len(cap.envs) == 1
    return cap.envs[0]


def test_simulacao_interpretador_compartilhado_recebe_so_o_diretorio_da_libpython_carregada(
        tmp_path, monkeypatch, parent_env):
    maps = fake_maps(tmp_path, "/usr/lib/x86_64-linux-gnu/libc.so.6", f"{LIBDIR}/{SONAME}",
                     "/usr/lib/x86_64-linux-gnu/libz.so.1")
    monkeypatch.setattr(sp, "PROC_MAPS", maps, raising=False)
    monkeypatch.setattr(sp, "_config_var", shared, raising=False)
    env = env_sent()
    assert env == {**sp.MINIMAL_ENV, "LD_LIBRARY_PATH": LIBDIR}      # exatamente UM diretório, nada do pai
    assert SECRET not in "".join(env.values()) and "/caminho/do/pai" not in env["LD_LIBRARY_PATH"]


def test_simulacao_interpretador_estatico_mantem_o_ambiente_minimo(tmp_path, monkeypatch, parent_env):
    monkeypatch.setattr(sp, "PROC_MAPS", fake_maps(tmp_path, f"{LIBDIR}/{SONAME}"), raising=False)
    monkeypatch.setattr(sp, "_config_var", static, raising=False)
    assert env_sent() == sp.MINIMAL_ENV


@pytest.mark.parametrize("paths", [
    ("/usr/lib/x86_64-linux-gnu/libc.so.6",),                         # biblioteca não mapeada
    (f"{LIBDIR}/{SONAME} (deleted)",),                                # arquivo substituído: não confiar
    (f"{SONAME}",),                                                   # caminho não absoluto
])
def test_simulacao_biblioteca_nao_localizada_mantem_o_ambiente_minimo(tmp_path, monkeypatch, parent_env, paths):
    monkeypatch.setattr(sp, "PROC_MAPS", fake_maps(tmp_path, *paths), raising=False)
    monkeypatch.setattr(sp, "_config_var", shared, raising=False)
    assert env_sent() == sp.MINIMAL_ENV


def test_simulacao_mapeamentos_ilegiveis_mantem_o_ambiente_minimo(tmp_path, monkeypatch, parent_env):
    monkeypatch.setattr(sp, "PROC_MAPS", str(tmp_path / "inexistente"), raising=False)
    monkeypatch.setattr(sp, "_config_var", shared, raising=False)
    assert env_sent() == sp.MINIMAL_ENV


def test_simulacao_outro_interpretador_configurado_nao_recebe_a_biblioteca_do_pai(tmp_path, monkeypatch, parent_env):
    monkeypatch.setattr(sp, "PROC_MAPS", fake_maps(tmp_path, f"{LIBDIR}/{SONAME}"), raising=False)
    monkeypatch.setattr(sp, "_config_var", shared, raising=False)
    assert env_sent(python="/usr/bin/python3-que-nao-e-o-atual") == sp.MINIMAL_ENV


def test_real_interpretador_em_uso_inicia_com_o_ambiente_entregue_ao_filho(parent_env):
    """REAL: o mesmo interpretador que o transporte usa, com o MESMO ambiente que ele entrega ao filho,
    precisa iniciar (código 0). Sem a correção, no job `integration` (Python do setup-python dentro do
    contêiner do Playwright) o carregador sai com 127 antes de qualquer código Python."""
    env = env_sent()
    probe = subprocess.run([sys.executable, "-I", "-c", "pass"], env=env, cwd="/", stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    assert probe.returncode == 0, f"interpretador não iniciou com o ambiente do filho (código {probe.returncode})"

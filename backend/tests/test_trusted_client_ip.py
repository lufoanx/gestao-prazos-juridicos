"""Etapa 6.1 — IP do cliente via intermediário: desativado por padrão, segredo obrigatório."""
import pytest
from fastapi.testclient import TestClient

from tests.auth_utils import API, PASSWORD

SECRET = "segredo-do-bff-para-testes-" + "x" * 20


def _register(client, email, headers=None):
    return client.post(f"{API}/auth/register", json={"name": "Pessoa", "email": email, "password": PASSWORD},
                       headers=headers or {})


def _limited_app(make_app, clock, **env):
    return TestClient(make_app(clock=clock, AUTH_REGISTER_MAX_REQUESTS=1, **env), raise_server_exceptions=False)


def test_desativado_por_padrao_ignora_cabecalhos(make_app, clock):
    client = _limited_app(make_app, clock)
    h = {"X-PrazoAI-Proxy-Secret": SECRET, "X-PrazoAI-Client-IP": "203.0.113.1"}
    assert _register(client, "a@exemplo.com", h).status_code == 201
    h2 = {"X-PrazoAI-Proxy-Secret": SECRET, "X-PrazoAI-Client-IP": "203.0.113.2"}
    assert _register(client, "b@exemplo.com", h2).status_code == 429       # mesmo IP observado


def test_x_forwarded_for_forjado_e_sempre_ignorado(make_app, clock):
    client = _limited_app(make_app, clock, TRUSTED_PROXY_SECRET=SECRET)
    assert _register(client, "a@exemplo.com", {"X-Forwarded-For": "198.51.100.1"}).status_code == 201
    assert _register(client, "b@exemplo.com", {"X-Forwarded-For": "198.51.100.2"}).status_code == 429


@pytest.mark.parametrize("headers", [
    {"X-PrazoAI-Client-IP": "203.0.113.9"},                                       # sem segredo
    {"X-PrazoAI-Proxy-Secret": "errado-" + "y" * 40, "X-PrazoAI-Client-IP": "203.0.113.9"},
    {"X-PrazoAI-Proxy-Secret": SECRET},                                           # sem IP
    {"X-PrazoAI-Proxy-Secret": SECRET, "X-PrazoAI-Client-IP": "203.0.113.9, 10.0.0.1"},
    {"X-PrazoAI-Proxy-Secret": SECRET, "X-PrazoAI-Client-IP": "203.0.113.9:443"},
    {"X-PrazoAI-Proxy-Secret": SECRET, "X-PrazoAI-Client-IP": "nao-e-ip"},
])
def test_segredo_ausente_incorreto_ou_ip_invalido_caem_no_ip_observado(make_app, clock, headers):
    client = _limited_app(make_app, clock, TRUSTED_PROXY_SECRET=SECRET)
    assert _register(client, "a@exemplo.com").status_code == 201                  # consome o IP observado
    assert _register(client, "b@exemplo.com", headers).status_code == 429


def test_encaminhamento_confiavel_separa_os_limites_por_cliente(make_app, clock):
    client = _limited_app(make_app, clock, TRUSTED_PROXY_SECRET=SECRET)
    for i, ip in enumerate(("203.0.113.10", "2001:db8::1", "203.0.113.11")):
        h = {"X-PrazoAI-Proxy-Secret": SECRET, "X-PrazoAI-Client-IP": ip}
        assert _register(client, f"p{i}@exemplo.com", h).status_code == 201
    h = {"X-PrazoAI-Proxy-Secret": SECRET, "X-PrazoAI-Client-IP": "203.0.113.10"}
    assert _register(client, "p9@exemplo.com", h).status_code == 429             # mesmo cliente encaminhado


def test_segredo_curto_e_rejeitado(make_app):
    with pytest.raises(Exception):
        make_app(TRUSTED_PROXY_SECRET="curto")


def test_segredo_nao_aparece_em_respostas_nem_logs(make_app, clock, caplog):
    client = _limited_app(make_app, clock, TRUSTED_PROXY_SECRET=SECRET)
    r = _register(client, "a@exemplo.com", {"X-PrazoAI-Proxy-Secret": SECRET, "X-PrazoAI-Client-IP": "203.0.113.1"})
    assert SECRET not in r.text and SECRET not in caplog.text

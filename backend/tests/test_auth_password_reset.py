"""Etapa 2 — recuperação e redefinição de senha (sem e-mail real)."""
import threading
from concurrent.futures import ThreadPoolExecutor

from app.security.tokens import hash_opaque_token
from tests.auth_utils import API, PASSWORD, bearer, error_code, login, register, register_and_login

NEW_PASSWORD = "Nova-senha-segura-456"
GENERIC = {"message": "Se o e-mail estiver cadastrado, enviaremos instruções de recuperação."}


def _forgot(client, email="ana@exemplo.com"):
    return client.post(f"{API}/auth/forgot-password", json={"email": email})


def _reset(client, token, password=NEW_PASSWORD):
    return client.post(f"{API}/auth/reset-password", json={"token": token, "newPassword": password})


def test_resposta_generica_identica_para_email_existente_e_inexistente(client, delivery):
    register(client)
    existing = _forgot(client, "ana@exemplo.com")
    missing = _forgot(client, "ninguem@exemplo.com")
    assert existing.status_code == missing.status_code == 202
    assert existing.json() == missing.json() == GENERIC
    assert existing.content == missing.content
    # Só o e-mail existente gera mensagem de entrega.
    assert len(delivery.messages) == 1
    msg = delivery.messages[0]
    assert msg.email == "ana@exemplo.com"
    # O token não volta pela API.
    assert msg.token not in existing.text


def test_token_aleatorio_armazenado_somente_como_hash(client, delivery, auth_app):
    register(client)
    _forgot(client)
    _forgot(client)
    tokens = [m.token for m in delivery.messages]
    assert len(set(tokens)) == 2 and all(len(t) >= 40 for t in tokens)
    store = auth_app.state.auth.store
    assert set(store.reset_tokens) == {hash_opaque_token(t) for t in tokens}
    for t in tokens:
        assert t not in repr(vars(store))


def test_reset_valido_troca_a_senha_sem_autenticar(client, delivery):
    register(client)
    _forgot(client)
    resp = _reset(client, delivery.messages[-1].token)
    assert resp.status_code == 204
    assert resp.content == b""  # não autentica automaticamente
    assert login(client, password=PASSWORD).status_code == 401
    assert login(client, password=NEW_PASSWORD).status_code == 200


def test_reset_com_token_invalido(client):
    register(client)
    resp = _reset(client, "token-que-nao-existe-1234567890")
    assert resp.status_code == 400
    assert error_code(resp) == "invalid_reset_token"
    assert _reset(client, "curto").status_code == 422


def test_reset_com_nova_senha_invalida_nao_consome_o_token(client, delivery):
    register(client)
    _forgot(client)
    token = delivery.messages[-1].token
    assert _reset(client, token, password="curta").status_code == 422
    assert _reset(client, token, password="x" * 129).status_code == 422
    assert _reset(client, token).status_code == 204


def test_reset_com_token_expirado(client, delivery, clock):
    register(client)
    _forgot(client)
    clock.advance(1800)
    assert _reset(client, delivery.messages[-1].token).status_code == 400
    assert login(client).status_code == 200  # senha antiga continua


def test_reset_com_token_reutilizado(client, delivery):
    register(client)
    _forgot(client)
    token = delivery.messages[-1].token
    assert _reset(client, token).status_code == 204
    assert _reset(client, token, password="Outra-senha-789").status_code == 400
    assert login(client, password=NEW_PASSWORD).status_code == 200


def test_novo_pedido_invalida_token_pendente_anterior(client, delivery):
    register(client)
    _forgot(client)
    _forgot(client)
    old, new = delivery.messages[0].token, delivery.messages[1].token
    assert _reset(client, old).status_code == 400
    assert _reset(client, new).status_code == 204


def test_reset_invalida_outros_tokens_e_revoga_todas_as_sessoes(client, delivery, auth_app):
    s1 = register_and_login(client)
    s2 = login(client).json()
    _forgot(client)
    token = delivery.messages[-1].token
    # Um token pendente extra, inserido direto no estado (simula estado anterior à política
    # de token único): a redefinição deve invalidá-lo mesmo assim.
    from app.domain.auth import PasswordResetToken

    store_clock = auth_app.state.auth.clock
    pending = "token-pendente-extra-1234567890"
    user_id = s1["user"]["id"]
    auth_app.state.auth.store.reset_tokens[hash_opaque_token(pending)] = PasswordResetToken(
        hash_opaque_token(pending), user_id, store_clock.now(), store_clock.now().replace(year=2027)
    )
    assert _reset(client, token).status_code == 204
    for s in (s1, s2):
        assert client.get(f"{API}/auth/me", headers=bearer(s["accessToken"])).status_code == 401
        assert client.post(f"{API}/auth/refresh", json={"refreshToken": s["refreshToken"]}).status_code == 401
    assert _reset(client, pending).status_code == 400


def test_consumo_concorrente_do_mesmo_token_de_reset(client, delivery, auth_app):
    register(client)
    _forgot(client)
    token = delivery.messages[-1].token
    service = auth_app.state.auth.service
    n = 8
    barrier = threading.Barrier(n)

    def attempt(i):
        barrier.wait()
        try:
            service.reset_password(token, f"Senha-concorrente-{i:02d}")
            return i
        except Exception as exc:
            return exc

    with ThreadPoolExecutor(max_workers=n) as pool:
        results = list(pool.map(attempt, range(n)))
    winners = [r for r in results if isinstance(r, int)]
    assert len(winners) == 1
    assert all(getattr(r, "status_code", None) == 400 for r in results if not isinstance(r, int))
    assert login(client, password=f"Senha-concorrente-{winners[0]:02d}").status_code == 200


def test_falha_na_entrega_nao_altera_a_resposta(make_app, clock):
    class FailingDelivery:
        def send(self, message):
            raise RuntimeError("provedor fora do ar")

    from fastapi.testclient import TestClient

    client = TestClient(make_app(clock=clock, delivery=FailingDelivery()), raise_server_exceptions=False)
    register(client)
    resp = _forgot(client)
    assert resp.status_code == 202 and resp.json() == GENERIC


def test_entrega_padrao_nao_envia_email_nem_expoe_token(make_app, clock, caplog):
    from fastapi.testclient import TestClient

    client = TestClient(make_app(clock=clock), raise_server_exceptions=False)  # adaptador padrão (noop)
    register(client)
    with caplog.at_level("DEBUG"):
        assert _forgot(client).status_code == 202
    assert "password_reset_requested delivery=noop" in caplog.text
    assert "ana@exemplo.com" not in caplog.text

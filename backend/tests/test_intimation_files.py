"""PDF da intimação (doc 28): validação, armazenamento privado (Azurite), autorização, falhas e ciclo de vida.

Unitários (sem serviços): validação estrutural e nome de exibição.
Integração: PostgreSQL DESCARTÁVEL (fixture protegida) + Azurite local (PRAZOAI_TEST_AZURITE_CONNECTION_STRING;
um container próprio por teste, removido ao final). Sem a variável, os casos com Azurite são PULADOS —
ou FALHAM com PRAZOAI_REQUIRE_AZURITE_TESTS=1 (CI). Só PDFs sintéticos (tests/pdf_samples.py).
"""
from __future__ import annotations

import os
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import text

from app.files.pdf import MAX_PDF_BYTES, PdfRejected, validate_pdf
from app.files.storage import AzureBlobStore, FileStorageUnavailable
from app.services.intimation_service import safe_file_name
from tests.intimation_utils import confirm, register
from tests.org_utils import API, MEMBER, OrgClient, fast_hasher
from tests.pdf_samples import pdf_of_size, synthetic_pdf

AZ = os.environ.get("PRAZOAI_TEST_AZURITE_CONNECTION_STRING", "")
JWT = "segredo-jwt-estavel-dos-testes-arquivos-" + "z" * 24


# ------------------------------------------------------------------ unitários
@pytest.mark.parametrize("data, code", [
    (b"", "file_empty"),
    (b"\x89PNG\r\n\x1a\n" + b"0" * 100, "file_not_pdf"),
    (b"Isto nao e um PDF, apesar da extensao .pdf\n%%EOF", "file_not_pdf"),
    (b" %PDF-1.4\n" + synthetic_pdf()[9:], "file_not_pdf"),                       # cabeçalho fora do início
    (synthetic_pdf()[:-30], "pdf_invalid"),                                      # truncado (sem %%EOF/startxref)
    (b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n", "pdf_invalid"),   # sem tabela de referências
    (b"%PDF-1.7\nxref\nstartxref\n0\n%%EOF\n", "pdf_invalid"),                    # sem objetos
    (synthetic_pdf(encrypted=True), "pdf_encrypted"),
])
def test_validacao_recusa(data, code):
    with pytest.raises(PdfRejected) as exc:
        validate_pdf(data)
    assert exc.value.code == code


def test_validacao_limites_de_tamanho():
    validate_pdf(pdf_of_size(MAX_PDF_BYTES))
    with pytest.raises(PdfRejected) as exc:
        validate_pdf(pdf_of_size(MAX_PDF_BYTES + 1))
    assert exc.value.code == "file_too_large" and exc.value.status == 413


@pytest.mark.parametrize("raw, expected", [
    ("contestacao.pdf", "contestacao.pdf"),
    ("../../etc/passwd", "passwd.pdf"),
    ("C:\\Users\\x\\intimação.PDF", "intimação.PDF"),
    ("nome\x00com\ncontrole.pdf", "nomecomcontrole.pdf"),
    ("", "intimacao.pdf"),
    (None, "intimacao.pdf"),
    ("a" * 400 + ".pdf", "a" * 251 + ".pdf"),
])
def test_nome_de_exibicao_nunca_vira_caminho(raw, expected):
    assert safe_file_name(raw) == expected


# ------------------------------------------------------------------ integração (PostgreSQL + Azurite)
@pytest.fixture
def azurite():
    if not AZ:
        if os.environ.get("PRAZOAI_REQUIRE_AZURITE_TESTS") == "1":
            pytest.fail("PRAZOAI_REQUIRE_AZURITE_TESTS=1 exige PRAZOAI_TEST_AZURITE_CONNECTION_STRING.")
        pytest.skip("PRAZOAI_TEST_AZURITE_CONNECTION_STRING não definida (Azurite local).")
    assert "devstoreaccount1" in AZ and "127.0.0.1" in AZ, "testes só contra o Azurite local"
    container = f"t{uuid.uuid4().hex[:24]}"
    store = AzureBlobStore(AZ, container, 10)
    assert store.create_container() is True
    yield container, store
    store._service.delete_container(container)


def blobs(store: AzureBlobStore) -> list[str]:
    return [b.name for b in store._container.list_blobs()]


@pytest.fixture
def files_app(make_app, pg_schema, pg_url, azurite):
    container, _ = azurite

    def _make(file_store=None, **env):
        return make_app(
            password_hasher=fast_hasher(), file_store=file_store,
            STORAGE="postgres", ENVIRONMENT="test", DATABASE_URL=pg_url.render_as_string(hide_password=False),
            AUTH_JWT_SECRET=JWT, FILE_STORAGE="azure_blob", AZURE_STORAGE_CONNECTION_STRING=AZ,
            AZURE_STORAGE_CONTAINER=container, **env,
        )
    return _make


def put_pdf(o, person, iid, data, *, name="intimação teste.pdf", content_type="application/pdf", extra=None):
    from urllib.parse import quote

    headers = {**person.headers, "content-type": content_type, "x-prazoai-file-name": quote(name), **(extra or {})}
    return o.http.put(f"{API}/intimations/{iid}/file", headers=headers, content=data)


def get_pdf(o, person, iid):
    return o.http.get(f"{API}/intimations/{iid}/file", headers=person.headers)


def personal(o, person, **over):
    return register(o, person, scope="personal", **over)


def test_upload_persiste_e_download_devolve_os_mesmos_bytes(files_app, azurite):
    _, store = azurite
    o = OrgClient(files_app())
    ana = o.person("ana")
    i = personal(o, ana)
    data = synthetic_pdf(b"% conteudo sintetico unico " + uuid.uuid4().hex.encode())
    r = put_pdf(o, ana, i["id"], data, name="../pasta/intimação teste.pdf")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["file"]["storage"] == "stored" and body["file"]["sizeBytes"] == len(data)
    assert body["file"]["name"] == "intimação teste.pdf" and body["file"]["storedAt"]
    assert body["version"] == i["version"] + 1 and body["status"] == "awaiting_review"
    keys = blobs(store)
    assert len(keys) == 1 and keys[0].startswith("intimations/") and "teste" not in keys[0]
    assert keys[0] not in r.text                                             # a chave nunca é exposta
    d = get_pdf(o, ana, i["id"])
    assert d.status_code == 200 and d.content == data
    assert d.headers["content-type"] == "application/pdf"
    assert d.headers["x-content-type-options"] == "nosniff"
    assert d.headers["cache-control"] == "no-store, private"
    assert d.headers["content-disposition"].startswith('attachment; filename="intima__o teste.pdf"; filename*=UTF-8')
    with o.app.state.auth.engine.connect() as c:
        row = c.execute(text("SELECT file_storage, file_sha256 FROM prazoai.intimations WHERE id = :i"),
                        {"i": uuid.UUID(i["id"])}).one()
        assert row.file_storage == "stored" and len(row.file_sha256) == 64
        assert c.execute(text("SELECT count(*) FROM prazoai.file_cleanup")).scalar_one() == 0   # reserva consumida
    events = o.http.get(f"{API}/intimations/{i['id']}/history", headers=ana.headers).json()["items"]
    assert [e["action"] for e in events][-1] == "file_stored"


def test_recuperacao_apos_reiniciar_aplicacao_e_clientes(files_app, azurite):
    container, _ = azurite
    o = OrgClient(files_app())
    ana = o.person("ana")
    i = personal(o, ana)
    data = synthetic_pdf(b"% reinicio " + uuid.uuid4().hex.encode())
    assert put_pdf(o, ana, i["id"], data).status_code == 200
    o.app.state.auth.close()
    # Aplicação nova, cliente de blob novo (nada em memória compartilhado com a anterior).
    o2 = OrgClient(files_app(file_store=AzureBlobStore(AZ, container, 10)))
    ana = o2.relogin(ana)
    d = get_pdf(o2, ana, i["id"])
    assert d.status_code == 200 and d.content == data


@pytest.mark.parametrize("data, content_type, status, code", [
    (synthetic_pdf(), "image/png", 415, "file_not_pdf"),                 # tipo declarado errado
    (b"\x89PNG\r\n\x1a\n" + b"0" * 64, "application/pdf", 415, "file_not_pdf"),   # arquivo falso com tipo "certo"
    (synthetic_pdf()[:-40], "application/pdf", 422, "pdf_invalid"),
    (synthetic_pdf(encrypted=True), "application/pdf", 422, "pdf_encrypted"),
    (b"", "application/pdf", 422, "file_empty"),
])
def test_rejeicoes_nao_criam_blob_nem_alteram_a_intimacao(files_app, azurite, data, content_type, status, code):
    _, store = azurite
    o = OrgClient(files_app())
    ana = o.person("ana")
    i = personal(o, ana)
    r = put_pdf(o, ana, i["id"], data, content_type=content_type)
    assert (r.status_code, r.json()["error"]["code"]) == (status, code)
    after = o.http.get(f"{API}/intimations/{i['id']}", headers=ana.headers).json()
    assert after["file"]["storage"] == "not_stored" and after["version"] == i["version"]
    assert blobs(store) == []


def test_tamanho_excessivo_recusado_durante_a_leitura(files_app, azurite):
    _, store = azurite
    o = OrgClient(files_app())
    ana = o.person("ana")
    i = personal(o, ana)
    big = pdf_of_size(MAX_PDF_BYTES + 1)
    r = put_pdf(o, ana, i["id"], big)
    assert (r.status_code, r.json()["error"]["code"]) == (413, "file_too_large")

    def chunks():                                     # sem Content-Length: o limite vale no fluxo
        for k in range(0, len(big), 1 << 20):
            yield big[k:k + (1 << 20)]
    r = o.http.put(f"{API}/intimations/{i['id']}/file", content=chunks(),
                   headers={**ana.headers, "content-type": "application/pdf"})
    assert (r.status_code, r.json()["error"]["code"]) == (413, "file_too_large")
    assert put_pdf(o, ana, i["id"], pdf_of_size(MAX_PDF_BYTES)).status_code == 200   # exatamente 10 MiB aceito
    assert len(blobs(store)) == 1


def test_um_pdf_por_intimacao_e_somente_pendente(files_app, azurite):
    _, store = azurite
    o = OrgClient(files_app())
    ana = o.person("ana")
    i = personal(o, ana)
    assert put_pdf(o, ana, i["id"], synthetic_pdf()).status_code == 200
    r = put_pdf(o, ana, i["id"], synthetic_pdf(b"% outro"))
    assert (r.status_code, r.json()["error"]["code"]) == (409, "file_already_stored")
    j = personal(o, ana)
    v = o.http.post(f"{API}/intimations/{j['id']}/discard", headers=ana.headers, json={"version": j["version"]}).json()
    assert v["status"] == "discarded"
    r = put_pdf(o, ana, j["id"], synthetic_pdf())
    assert (r.status_code, r.json()["error"]["code"]) == (409, "invalid_state")
    assert len(blobs(store)) == 1


def test_sem_autenticacao_e_entre_contas_ou_escritorios(files_app, azurite):
    o = OrgClient(files_app())
    ana, bia, caio = o.person("ana"), o.person("bia"), o.person("caio")
    i = personal(o, ana)
    data = synthetic_pdf()
    assert o.http.put(f"{API}/intimations/{i['id']}/file", content=data,
                      headers={"content-type": "application/pdf"}).status_code == 401
    assert o.http.get(f"{API}/intimations/{i['id']}/file").status_code == 401
    assert put_pdf(o, ana, i["id"], data).status_code == 200
    # outra conta, mesmo conhecendo o identificador: 404 (sem revelar existência)
    assert get_pdf(o, bia, i["id"]).status_code == 404
    assert put_pdf(o, bia, i["id"], data).status_code == 404
    # escritórios diferentes
    oa = o.office(bia, "Escritório A")
    o.office(caio, "Escritório B")
    k = register(o, bia)
    assert put_pdf(o, bia, k["id"], data).status_code == 200
    assert get_pdf(o, caio, k["id"]).status_code == 404
    assert put_pdf(o, caio, k["id"], synthetic_pdf(b"%x")).status_code == 404
    assert get_pdf(o, bia, k["id"]).content == data
    assert oa


def test_permissoes_de_membros(files_app, azurite):
    o = OrgClient(files_app())
    adm, mem, leitor = o.person("adm"), o.person("mem"), o.person("leitor")
    oid = o.office(adm)
    o.join(adm, oid, mem)
    o.join(adm, oid, leitor)
    assert o.set_perms(adm, oid, mem, MEMBER, visibility="assigned").status_code == 200
    assert o.set_perms(adm, oid, leitor, ["deadline.read"], visibility="all").status_code == 200
    i = register(o, adm)                                              # do administrador, sem sugerido
    # membro sem visibilidade total não lê nem envia a intimação de outra pessoa
    assert put_pdf(o, mem, i["id"], synthetic_pdf()).status_code == 404
    # leitor (vê tudo, mas sem deadline.create) não envia: 403
    assert put_pdf(o, leitor, i["id"], synthetic_pdf()).status_code == 403
    assert put_pdf(o, adm, i["id"], synthetic_pdf()).status_code == 200
    assert get_pdf(o, leitor, i["id"]).status_code == 200            # leitura segue as regras de leitura
    assert get_pdf(o, mem, i["id"]).status_code == 404
    # membro envia a própria
    j = register(o, mem)
    assert put_pdf(o, mem, j["id"], synthetic_pdf(b"%m")).status_code == 200
    assert get_pdf(o, mem, j["id"]).status_code == 200


class FailingPut:
    """Armazenamento com falha CONTROLADA: `put` pode gravar e mesmo assim falhar (resultado incerto),
    e `delete` pode falhar — para provar que nada indica sucesso sem arquivo."""

    def __init__(self, real: AzureBlobStore, *, write_then_fail=False, fail_delete=False, before_return=None):
        self.real, self.write_then_fail = real, write_then_fail
        self.fail_delete, self.before_return = fail_delete, before_return

    def put(self, key, data):
        if self.write_then_fail:
            self.real.put(key, data)
        if self.before_return:
            self.before_return()
            return self.real.put(key, data)
        raise FileStorageUnavailable("falha injetada")

    def open(self, key):
        return self.real.open(key)

    def delete(self, key):
        if self.fail_delete:
            raise FileStorageUnavailable("falha injetada")
        self.real.delete(key)

    def check(self):
        self.real.check()


def _cleanup_rows(o):
    with o.app.state.auth.engine.connect() as c:
        return c.execute(text("SELECT blob_key, reason FROM prazoai.file_cleanup")).all()


def test_falha_de_armazenamento_sem_falso_sucesso(files_app, azurite):
    container, store = azurite
    o = OrgClient(files_app(file_store=FailingPut(AzureBlobStore(AZ, container, 10))))
    ana = o.person("ana")
    i = personal(o, ana)
    r = put_pdf(o, ana, i["id"], synthetic_pdf())
    assert (r.status_code, r.json()["error"]["code"]) == (503, "file_storage_unavailable")
    after = o.http.get(f"{API}/intimations/{i['id']}", headers=ana.headers).json()
    assert after["file"]["storage"] == "not_stored" and after["version"] == i["version"]
    assert get_pdf(o, ana, i["id"]).status_code == 404
    assert blobs(store) == []
    assert [row.reason for row in _cleanup_rows(o)] == ["upload_pending"]   # reserva fica para a limpeza


def test_upload_gravado_mas_resposta_incerta_e_remocao_falha_limpeza_posterior(files_app, azurite):
    from app.core.clock import SystemClock
    from app.files.cleanup import run_file_cleanup

    container, store = azurite
    o = OrgClient(files_app(file_store=FailingPut(AzureBlobStore(AZ, container, 10), write_then_fail=True,
                                                  fail_delete=True)))
    ana = o.person("ana")
    i = personal(o, ana)
    r = put_pdf(o, ana, i["id"], synthetic_pdf())
    assert r.status_code == 503
    assert o.http.get(f"{API}/intimations/{i['id']}", headers=ana.headers).json()["file"]["storage"] == "not_stored"
    assert len(blobs(store)) == 1                       # órfão: gravado, mas sem metadado de sucesso
    rows = _cleanup_rows(o)
    assert len(rows) == 1 and rows[0].blob_key == blobs(store)[0]
    engine = o.app.state.auth.engine
    assert run_file_cleanup(engine, store, SystemClock().now()) == 0          # reserva ainda vigente
    assert run_file_cleanup(engine, store, SystemClock().now() + timedelta(hours=2)) == 1
    assert blobs(store) == [] and _cleanup_rows(o) == []


def test_intimacao_descartada_durante_o_upload_nao_publica_e_remove_o_blob(files_app, azurite):
    container, store = azurite
    holder = {}

    def discard_now():
        o, ana, i = holder["o"], holder["ana"], holder["i"]
        r = o.http.post(f"{API}/intimations/{i['id']}/discard", headers=ana.headers, json={"version": i["version"]})
        assert r.status_code == 200

    o = OrgClient(files_app(file_store=FailingPut(AzureBlobStore(AZ, container, 10), before_return=discard_now)))
    ana = o.person("ana")
    i = personal(o, ana)
    holder.update(o=o, ana=ana, i=i)
    r = put_pdf(o, ana, i["id"], synthetic_pdf())
    assert (r.status_code, r.json()["error"]["code"]) == (409, "invalid_state")
    after = o.http.get(f"{API}/intimations/{i['id']}", headers=ana.headers).json()
    assert after["status"] == "discarded" and after["file"]["storage"] == "not_stored"
    assert blobs(store) == []                            # removido na compensação


def test_fluxo_completo_upload_revisao_confirmacao_prazo_e_download(files_app, azurite):
    o = OrgClient(files_app())
    ana = o.person("ana")
    i = personal(o, ana)
    data = synthetic_pdf(b"% fluxo completo")
    v = put_pdf(o, ana, i["id"], data).json()["version"]
    # preenchimento manual (rascunho) e confirmação explícita
    d = o.http.patch(f"{API}/intimations/{i['id']}", headers=ana.headers,
                     json={"version": v, "title": "Contestação manual"}).json()
    r = confirm(o, ana, i["id"], d["version"], title="Contestação manual")
    assert r.status_code == 201, r.text
    deadline = r.json()["deadline"]
    again = confirm(o, ana, i["id"], d["version"], title="Contestação manual")
    assert again.status_code == 200 and again.json()["created"] is False
    assert again.json()["deadline"]["id"] == deadline["id"]
    listed = o.http.get(f"{API}/deadlines", headers=ana.headers, params={"scope": "personal"}).json()
    assert listed["total"] == 1                                               # sem duplicação
    linked = o.http.get(f"{API}/deadlines/{deadline['id']}/intimation", headers=ana.headers)
    assert linked.status_code == 200 and linked.json()["id"] == i["id"]
    assert get_pdf(o, ana, linked.json()["id"]).content == data
    # o arquivo continua disponível depois da revisão; não aceita outro
    assert put_pdf(o, ana, i["id"], synthetic_pdf(b"%novo")).status_code == 409
    # outra conta não descobre o vínculo
    bia = o.person("bia")
    assert o.http.get(f"{API}/deadlines/{deadline['id']}/intimation", headers=bia.headers).status_code == 404


def test_ciclo_de_vida_expurgo_da_descartada_remove_o_blob(files_app, azurite):
    from app.core.clock import SystemClock
    from app.core.config import Settings
    from app.files.cleanup import run_file_cleanup
    from app.maintenance.purge import MaintenanceLimits, RetentionPolicy, run_maintenance

    _, store = azurite
    o = OrgClient(files_app())
    ana = o.person("ana")
    i = personal(o, ana)
    v = put_pdf(o, ana, i["id"], synthetic_pdf()).json()["version"]
    assert o.http.post(f"{API}/intimations/{i['id']}/discard", headers=ana.headers,
                       json={"version": v}).status_code == 200
    assert len(blobs(store)) == 1                                   # descartada: arquivo mantido na retenção
    engine = o.app.state.auth.engine
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    later = SystemClock().now() + timedelta(seconds=settings.intimations_discard_retention_seconds + 60)

    class Later:
        def now(self):
            return later

    result = run_maintenance(engine, Later(), RetentionPolicy.from_settings(settings),
                             MaintenanceLimits.from_settings(settings), categories=("intimations_discarded",))
    assert result.removed.get("intimations_discarded") == 1
    assert [row.reason for row in _cleanup_rows(o)] == ["intimation_deleted"]      # gatilho na mesma transação
    assert run_file_cleanup(engine, store, later) == 1
    assert blobs(store) == [] and _cleanup_rows(o) == []


def test_readiness_e_container_publico(files_app, azurite):
    container, store = azurite
    o = OrgClient(files_app())
    ready = o.http.get(f"{API}/health/ready")
    assert ready.status_code == 200 and ready.json()["checks"]["files"] == "ok"
    store._container.set_container_access_policy(signed_identifiers={}, public_access="blob")
    r = o.http.get(f"{API}/health/ready")
    assert r.status_code == 503 and r.json()["checks"]["files"] == "fail"
    assert "devstoreaccount1" not in r.text and container not in r.text


def test_armazenamento_desligado_responde_503(make_app):
    o = OrgClient(make_app(password_hasher=fast_hasher()))
    ana = o.person("ana")
    i = personal(o, ana)
    r = put_pdf(o, ana, i["id"], synthetic_pdf())
    assert (r.status_code, r.json()["error"]["code"]) == (503, "file_storage_unavailable")
    assert get_pdf(o, ana, i["id"]).status_code == 503


def test_configuracao_de_arquivos():
    from app.core.config import Settings

    with pytest.raises(ValueError, match="STORAGE=postgres"):
        Settings(_env_file=None, FILE_STORAGE="azure_blob", AZURE_STORAGE_CONNECTION_STRING="x")  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="AZURE_STORAGE_CONNECTION_STRING"):
        Settings(_env_file=None, FILE_STORAGE="azure_blob", STORAGE="postgres")  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="FILE_STORAGE"):
        Settings(_env_file=None, FILE_STORAGE="disco-local")  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="AZURE_STORAGE_CONTAINER"):
        Settings(_env_file=None, AZURE_STORAGE_CONTAINER="Container_Publico")  # type: ignore[call-arg]


def test_cli_check_e_create_container(azurite, tmp_path):
    import subprocess
    import sys
    from pathlib import Path

    container, store = azurite
    backend = Path(__file__).resolve().parents[1]
    env = {"PATH": os.environ.get("PATH", ""), "ENVIRONMENT": "test", "STORAGE": "postgres",
           "FILE_STORAGE": "azure_blob", "AZURE_STORAGE_CONNECTION_STRING": AZ, "AZURE_STORAGE_CONTAINER": container}
    run = lambda *a: subprocess.run([sys.executable, "-m", "app.files", *a], cwd=backend, env={**os.environ, **env},  # noqa: E731
                                    capture_output=True, text=True, timeout=60)
    out = run("check")
    assert out.returncode == 0, out.stderr
    assert "AccountKey" not in out.stdout + out.stderr
    out = run("create-container")
    assert out.returncode == 0 and "já existia" in out.stdout
    store._container.set_container_access_policy(signed_identifiers={}, public_access="container")
    out = run("check")
    assert out.returncode == 4 and "público" in out.stderr


def test_limpeza_nao_apaga_upload_em_andamento_nem_arquivo_vinculado(files_app, azurite):
    from app.core.clock import SystemClock
    from app.files.cleanup import run_file_cleanup

    container, store = azurite
    holder = {}

    def cleanup_now():                               # limpeza concorrente, com a reserva AINDA vigente
        holder["removed_during"] = run_file_cleanup(holder["engine"], store, SystemClock().now())
        holder["rows_during"] = _cleanup_rows(holder["o"])

    o = OrgClient(files_app(file_store=FailingPut(AzureBlobStore(AZ, container, 10), before_return=cleanup_now)))
    holder.update(o=o, engine=o.app.state.auth.engine)
    ana = o.person("ana")
    i = personal(o, ana)
    data = synthetic_pdf(b"% em andamento")
    assert put_pdf(o, ana, i["id"], data).status_code == 200
    assert holder["removed_during"] == 0 and [r.reason for r in holder["rows_during"]] == ["upload_pending"]
    assert _cleanup_rows(o) == []                                    # reserva consumida na publicação
    # arquivo vinculado: nenhuma entrada de limpeza, nem com o relógio muito adiante
    far = SystemClock().now() + timedelta(days=3650)
    assert run_file_cleanup(holder["engine"], store, far) == 0
    assert len(blobs(store)) == 1 and get_pdf(o, ana, i["id"]).content == data


def test_reserva_consumida_pela_limpeza_durante_o_upload_impede_a_publicacao(files_app, azurite):
    from app.core.clock import SystemClock
    from app.files.cleanup import run_file_cleanup

    container, store = azurite
    holder = {}

    def expired_cleanup():                           # a reserva venceu (upload lento demais) e a limpeza rodou
        holder["removed"] = run_file_cleanup(holder["engine"], store, SystemClock().now() + timedelta(hours=2))

    o = OrgClient(files_app(file_store=FailingPut(AzureBlobStore(AZ, container, 10), before_return=expired_cleanup)))
    holder["engine"] = o.app.state.auth.engine
    ana = o.person("ana")
    i = personal(o, ana)
    r = put_pdf(o, ana, i["id"], synthetic_pdf())
    assert holder["removed"] == 1
    assert (r.status_code, r.json()["error"]["code"]) == (503, "file_storage_unavailable")
    after = o.http.get(f"{API}/intimations/{i['id']}", headers=ana.headers).json()
    assert after["file"]["storage"] == "not_stored"                  # nunca aponta para blob removível
    assert blobs(store) == [] and _cleanup_rows(o) == []

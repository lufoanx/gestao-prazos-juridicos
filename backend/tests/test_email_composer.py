"""E1 — composição do e-mail de recuperação: link com fragmento, datas, sem dados jurídicos."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.email.composer import SUBJECT, PasswordResetComposer
from app.email.message import OutgoingEmail

TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345-_"
ISSUED = datetime(2026, 11, 13, 15, 0, tzinfo=timezone.utc)
EXPIRES = datetime(2026, 11, 13, 15, 30, tzinfo=timezone.utc)


def test_link_com_fragmento_na_origem_configurada():
    c = PasswordResetComposer("https://app.exemplo.com/")
    assert c.link(TOKEN) == f"https://app.exemplo.com/redefinir-senha#{TOKEN}"


@pytest.mark.parametrize("bad", ["curto", "com espaço" * 3, "a" * 257, "x/../y" * 4, "tok\r\nen" * 3])
def test_token_em_formato_invalido_recusado(bad):
    with pytest.raises(ValueError):
        PasswordResetComposer("https://app.exemplo.com").link(bad)


def test_mensagem_completa_e_datas_no_fuso():
    m = PasswordResetComposer("https://app.exemplo.com").compose("Ana@Exemplo.com", TOKEN, ISSUED, EXPIRES)
    assert isinstance(m, OutgoingEmail) and m.subject == SUBJECT and m.to == "Ana@exemplo.com"
    assert f"https://app.exemplo.com/redefinir-senha#{TOKEN}" in m.text
    assert "Gerado em: 13/11/2026 12:00 (America/Sao_Paulo)" in m.text
    assert "Válido até: 13/11/2026 12:30 (America/Sao_Paulo)" in m.text
    assert "apenas o link gerado por último funciona" in m.text
    for proibido in ("processo", "intimação", "tribunal", "vencimento"):
        assert proibido not in m.text.lower()                        # sem dados jurídicos
    assert TOKEN not in repr(m) and "Ana" not in repr(m)


def test_destinatario_com_cr_lf_ou_multiplos_recusado():
    c = PasswordResetComposer("https://app.exemplo.com")
    for bad in ("a@x.com\r\nBcc: b@y.com", "a@x.com, b@y.com", "nada"):
        with pytest.raises(ValueError):
            c.compose(bad, TOKEN, ISSUED, EXPIRES)


def test_instantes_sem_fuso_recusados():
    with pytest.raises(ValueError):
        PasswordResetComposer("https://app.exemplo.com").compose("a@x.com", TOKEN, ISSUED.replace(tzinfo=None), EXPIRES)

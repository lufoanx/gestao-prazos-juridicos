"""Processo FILHO do envio SMTP (doc 21, §4.6). Executado por caminho absoluto, com `python -I`.

Regras:
- NÃO importa nada de `app` (nenhum banco, repositório, engine ou configuração da aplicação);
- recebe configuração, credenciais e mensagem SÓ pela entrada padrão (JSON, tamanho limitado);
- desativa core dumps; não configura logging; nunca imprime traceback (stderr é descartado pelo pai,
  e mesmo assim nenhuma exceção é exibida);
- TLS com verificação de certificado e nome; STARTTLS ausente → `tls_error` (sem downgrade);
- escreve na saída padrão SÓ uma categoria conhecida e sai com código 0.
"""
import json
import smtplib
import socket
import ssl
import sys
from email.message import EmailMessage
from email.policy import SMTP as SMTP_POLICY
from email.utils import formataddr, formatdate, make_msgid

MAX_INPUT = 256 * 1024


def _context(ca_file):
    ctx = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def _message(cfg, msg):
    m = EmailMessage(policy=SMTP_POLICY)              # recusa CR/LF em cabeçalhos
    m["From"] = formataddr((cfg["from_display"], cfg["from_address"]))
    m["To"] = msg["to"]
    m["Subject"] = msg["subject"]
    m["Date"] = formatdate(localtime=False)
    m["Message-ID"] = make_msgid(domain=cfg["from_address"].split("@", 1)[1])
    m.set_content(msg["text"])
    return m


def _send(cfg, msg):
    timeout = float(cfg["timeout"])
    security = cfg["security"]
    if security == "tls":
        client = smtplib.SMTP_SSL(cfg["host"], int(cfg["port"]), timeout=timeout, context=_context(cfg["ca_file"]))
    else:
        client = smtplib.SMTP(cfg["host"], int(cfg["port"]), timeout=timeout)
    try:
        client.ehlo()
        if security == "starttls":
            if not client.has_extn("starttls"):
                return "tls_error"                    # sem downgrade silencioso
            client.starttls(context=_context(cfg["ca_file"]))
            client.ehlo()
        if cfg.get("username"):
            client.login(cfg["username"], cfg["password"])
        client.send_message(_message(cfg, msg), from_addr=cfg["from_address"], to_addrs=[msg["to"]])
        return "accepted"
    finally:
        try:
            client.quit()
        except Exception:                             # noqa: BLE001
            client.close()


def main():
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except Exception:                                 # noqa: BLE001
        pass
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            category = "error"
        else:
            payload = json.loads(raw)
            category = _send(payload["config"], payload["message"])
    except smtplib.SMTPAuthenticationError:
        category = "auth_error"
    except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError):
        category = "refused"
    except (ssl.SSLError, ssl.CertificateError, smtplib.SMTPNotSupportedError):
        category = "tls_error"
    except (socket.timeout, TimeoutError):
        category = "timeout"
    except smtplib.SMTPServerDisconnected as exc:     # o smtplib embrulha o timeout de leitura
        category = "timeout" if isinstance(exc.__context__, (socket.timeout, TimeoutError)) else "error"
    except BaseException:                             # noqa: BLE001 — nada é exibido
        category = "error"
    sys.stdout.write(category + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()

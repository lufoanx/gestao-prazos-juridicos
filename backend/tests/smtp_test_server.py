"""Servidor SMTP LOCAL e controlado para testes (só 127.0.0.1; nada sai da máquina).

Suporta EHLO, STARTTLS, TLS implícito, AUTH PLAIN, MAIL/RCPT/DATA, recusa de destinatário,
saudação retida até um evento (coordenação determinística) e STARTTLS que trava o handshake.
"""
from __future__ import annotations

import base64
import socketserver
import ssl
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ServerOptions:
    advertise_starttls: bool = False
    implicit_tls: bool = False
    cert: tuple[str, str] | None = None              # (cert, key)
    auth: tuple[str, str] | None = None
    refuse_rcpt: set[str] = field(default_factory=set)
    hold_greeting: threading.Event | None = None     # saudação só depois do evento
    stall_starttls: threading.Event | None = None    # responde 220 e não negocia até o evento
    connected: threading.Event = field(default_factory=threading.Event)
    messages: list[bytes] = field(default_factory=list)


class _Handler(socketserver.StreamRequestHandler):
    def _send(self, line: str) -> None:
        self.wfile.write((line + "\r\n").encode())
        self.wfile.flush()

    def _wrap(self) -> None:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(*self.server.opts.cert)
        self.connection = ctx.wrap_socket(self.connection, server_side=True)
        self.rfile = self.connection.makefile("rb")
        self.wfile = self.connection.makefile("wb")

    def handle(self) -> None:
        o: ServerOptions = self.server.opts
        o.connected.set()
        try:
            if o.implicit_tls:
                self._wrap()
            if o.hold_greeting is not None:
                o.hold_greeting.wait(30)
            self._send("220 teste ESMTP")
            tls = o.implicit_tls
            while True:
                raw = self.rfile.readline()
                if not raw:
                    return
                line = raw.decode(errors="replace").rstrip("\r\n")
                cmd = line.split(" ", 1)[0].upper()
                if cmd in ("EHLO", "HELO"):
                    ext = []
                    if o.advertise_starttls and not tls:
                        ext.append("STARTTLS")
                    if o.auth:
                        ext.append("AUTH PLAIN")
                    lines = ["teste"] + ext
                    for i, e in enumerate(lines):
                        self._send(("250 " if i == len(lines) - 1 else "250-") + e)
                elif cmd == "STARTTLS":
                    self._send("220 pronto")
                    if o.stall_starttls is not None:
                        o.stall_starttls.wait(30)
                        return
                    self._wrap()
                    tls = True
                elif cmd == "AUTH":
                    data = line.split(" ", 2)[2] if line.count(" ") >= 2 else ""
                    _, user, pwd = base64.b64decode(data).decode().split("\x00")
                    self._send("235 ok" if (user, pwd) == o.auth else "535 credenciais inválidas")
                elif cmd == "MAIL":
                    self._send("250 ok")
                elif cmd == "RCPT":
                    addr = line.split(":", 1)[1].strip().strip("<>")
                    self._send("550 recusado" if addr in o.refuse_rcpt else "250 ok")
                elif cmd == "DATA":
                    self._send("354 envie")
                    body = b""
                    while True:
                        chunk = self.rfile.readline()
                        if chunk in (b".\r\n", b""):
                            break
                        body += chunk
                    o.messages.append(body)
                    self._send("250 aceito")
                elif cmd == "QUIT":
                    self._send("221 tchau")
                    return
                else:
                    self._send("250 ok")
        except (OSError, ssl.SSLError, ValueError):
            return


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class SmtpTestServer:
    def __init__(self, opts: ServerOptions) -> None:
        self.opts = opts
        self._srv = _Server(("127.0.0.1", 0), _Handler)
        self._srv.opts = opts
        self.port = self._srv.server_address[1]
        self._t = threading.Thread(target=self._srv.serve_forever, daemon=True)

    def __enter__(self) -> SmtpTestServer:
        self._t.start()
        return self

    def __exit__(self, *exc) -> None:
        for ev in (self.opts.hold_greeting, self.opts.stall_starttls):
            if ev is not None:
                ev.set()
        self._srv.shutdown()
        self._srv.server_close()


def make_certs(directory: Path) -> dict[str, str]:
    """CA de teste + certificado para localhost/127.0.0.1 + certificado com nome errado (openssl)."""
    d = str(directory)

    def run(*args: str) -> None:
        subprocess.run(["openssl", *args], check=True, capture_output=True, cwd=d)

    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=CA de teste",
        "-keyout", "ca.key", "-out", "ca.pem")
    for name, san in (("good", "DNS:localhost,IP:127.0.0.1"), ("wrong", "DNS:outro.invalid")):
        run("req", "-newkey", "rsa:2048", "-nodes", "-subj", f"/CN={name}", "-keyout", f"{name}.key",
            "-out", f"{name}.csr")
        (directory / f"{name}.ext").write_text(f"subjectAltName={san}\n")
        run("x509", "-req", "-in", f"{name}.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
            "-days", "2", "-extfile", f"{name}.ext", "-out", f"{name}.pem")
    return {"ca": f"{d}/ca.pem", "good": (f"{d}/good.pem", f"{d}/good.key"),
            "wrong": (f"{d}/wrong.pem", f"{d}/wrong.key")}

"""Tokens: access token JWT (PyJWT, HS256) e tokens opacos (refresh/recuperação).

- Access token: assinatura, algoritmo explícito, expiração, emissor, audiência e
  finalidade (`typ="access"`) validados. A expiração usa o relógio injetado.
- Refresh e recuperação: valores aleatórios opacos (`secrets`), armazenados apenas
  como SHA-256 (alta entropia dispensa hash lento). Não são JWT e, portanto, nunca
  passam na validação de access token.
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

import jwt

from app.core.clock import Clock

ALGORITHM = "HS256"
ACCESS_TYPE = "access"
_REQUIRED_CLAIMS = ["exp", "iat", "iss", "aud", "sub", "sid", "jti", "typ"]


class InvalidAccessTokenError(Exception):
    """Token ausente de requisitos, adulterado, expirado ou com finalidade incorreta."""


@dataclass(frozen=True)
class AccessClaims:
    user_id: str
    session_id: str
    expires_at: datetime


def new_opaque_token() -> str:
    return secrets.token_urlsafe(32)


def hash_opaque_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class AccessTokenCodec:
    def __init__(self, secret: str, issuer: str, audience: str, ttl_seconds: int, clock: Clock) -> None:
        if len(secret.encode("utf-8")) < 32:
            raise ValueError("Segredo de assinatura curto demais.")
        self._secret = secret
        self._issuer = issuer
        self._audience = audience
        self._ttl = ttl_seconds
        self._clock = clock

    @property
    def ttl_seconds(self) -> int:
        return self._ttl

    def issue(self, user_id: str, session_id: str) -> str:
        now = self._clock.now()
        payload = {
            "iss": self._issuer,
            "aud": self._audience,
            "sub": user_id,
            "sid": session_id,
            "jti": uuid.uuid4().hex,
            "typ": ACCESS_TYPE,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=self._ttl)).timestamp()),
        }
        return jwt.encode(payload, self._secret, algorithm=ALGORITHM)

    def decode(self, token: str) -> AccessClaims:
        try:
            header = jwt.get_unverified_header(token)
            if header.get("alg") != ALGORITHM:
                raise InvalidAccessTokenError()
            payload = jwt.decode(
                token,
                self._secret,
                algorithms=[ALGORITHM],  # lista explícita: rejeita "none" e outros algoritmos
                audience=self._audience,
                issuer=self._issuer,
                # exp/iat são conferidos abaixo com o relógio injetado (testável sem sleep).
                options={"require": _REQUIRED_CLAIMS, "verify_exp": False, "verify_iat": False},
            )
        except jwt.PyJWTError as exc:
            raise InvalidAccessTokenError() from exc
        if payload.get("typ") != ACCESS_TYPE:
            raise InvalidAccessTokenError()
        exp, iat, sub, sid = payload.get("exp"), payload.get("iat"), payload.get("sub"), payload.get("sid")
        if not isinstance(exp, int) or not isinstance(iat, int):
            raise InvalidAccessTokenError()
        if not isinstance(sub, str) or not sub or not isinstance(sid, str) or not sid:
            raise InvalidAccessTokenError()
        now_ts = self._clock.now().timestamp()
        if now_ts >= exp or iat > now_ts + 5:
            raise InvalidAccessTokenError()
        return AccessClaims(
            user_id=sub, session_id=sid, expires_at=datetime.fromtimestamp(exp, tz=self._clock.now().tzinfo)
        )

"""Verificação do ID token do Google ("Entrar com Google").

Quem garante a identidade é o BACKEND, não o BFF nem o navegador: o BFF só repassa o ID token que
recebeu do Google na troca do código (servidor a servidor) e o nonce que ele mesmo gerou.

Regras (OpenID Connect Core §3.1.3.7 e documentação do Google):
- assinatura RS256 verificada com as chaves públicas do Google (JWKS, com cache);
- `iss` = accounts.google.com (com ou sem https://); `aud` = o client id do PrazoAI;
- `exp` e `iat` obrigatórios e válidos (pequena tolerância de relógio);
- `nonce` igual ao gerado pelo BFF para ESTA tentativa (comparação em tempo constante);
- `email_verified` verdadeiro — sem e-mail verificado não há identidade a vincular.
Nenhum token, e-mail ou `sub` aparece em logs ou mensagens de erro.
"""
from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Any, Protocol

import jwt

GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")
_MAX_TOKEN_LEN = 8192
_LEEWAY_SECONDS = 60


class InvalidGoogleTokenError(Exception):
    """Token recusado (assinatura, emissor, público, validade, nonce ou e-mail não verificado)."""


class GoogleKeysUnavailableError(Exception):
    """Não foi possível obter as chaves públicas do Google (rede/indisponibilidade)."""


@dataclass(frozen=True)
class GoogleIdentity:
    subject: str
    email: str            # como veio do Google; a normalização é feita por quem usa
    name: str | None

    def __repr__(self) -> str:   # nunca expõe e-mail ou sub em logs
        return "GoogleIdentity(<oculto>)"


class SigningKeyResolver(Protocol):
    def get_signing_key_from_jwt(self, token: str) -> Any: ...


class GoogleIdTokenVerifier:
    def __init__(
        self,
        client_id: str,
        *,
        jwks_url: str = GOOGLE_JWKS_URL,
        issuers: tuple[str, ...] = GOOGLE_ISSUERS,
        key_resolver: SigningKeyResolver | None = None,
    ) -> None:
        if not client_id:
            raise ValueError("client id do Google ausente")
        self._client_id = client_id
        self._issuers = issuers
        self._keys = key_resolver or jwt.PyJWKClient(jwks_url, cache_keys=True, lifespan=3600, timeout=5)

    def verify(self, id_token: str, expected_nonce: str) -> GoogleIdentity:
        if not id_token or len(id_token) > _MAX_TOKEN_LEN or not expected_nonce:
            raise InvalidGoogleTokenError("formato")
        try:
            signing_key = self._keys.get_signing_key_from_jwt(id_token)
        except jwt.PyJWKClientConnectionError as exc:
            raise GoogleKeysUnavailableError("jwks") from exc
        except (jwt.PyJWKClientError, jwt.DecodeError) as exc:
            raise InvalidGoogleTokenError("chave") from exc
        key = getattr(signing_key, "key", signing_key)
        try:
            claims = jwt.decode(
                id_token,
                key,
                algorithms=["RS256"],
                audience=self._client_id,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
                leeway=_LEEWAY_SECONDS,
            )
        except jwt.PyJWTError as exc:
            raise InvalidGoogleTokenError("claims") from exc
        if claims.get("iss") not in self._issuers:
            raise InvalidGoogleTokenError("emissor")
        nonce = claims.get("nonce")
        if not isinstance(nonce, str) or not hmac.compare_digest(nonce.encode(), expected_nonce.encode()):
            raise InvalidGoogleTokenError("nonce")
        if claims.get("email_verified") not in (True, "true"):
            raise InvalidGoogleTokenError("email_nao_verificado")
        email, sub = claims.get("email"), claims.get("sub")
        if not isinstance(email, str) or not email or not isinstance(sub, str) or not sub:
            raise InvalidGoogleTokenError("identidade")
        name = claims.get("name")
        return GoogleIdentity(subject=sub, email=email, name=name if isinstance(name, str) else None)

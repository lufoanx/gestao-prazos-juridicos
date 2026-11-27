"""Casos de uso de autenticação e perfil (Etapa 2, armazenamento em memória).

Regras centrais:
- senha com Argon2id; usuário inexistente também paga uma verificação (custo similar);
- login emite access token (JWT curto) + refresh token opaco ligado a uma sessão;
- refresh gira o token a cada uso; reutilização revoga a família (sessão);
- access token só vale se a sessão no servidor estiver ativa (logout/reset revogam);
- recuperação (E2, doc 21): a requisição só valida, aplica os limites por IP e por e-mail e
  ENFILEIRA no RecoveryDispatcher (sem banco, sem token, sem transporte) e responde 202 neutro;
  o worker emite o token (aleatório, uso único, apenas hash guardado, no máximo um ativo por
  usuário) e entrega depois do COMMIT. Indisponível → 503 `password_recovery_unavailable`;
- redefinição revoga tokens de recuperação pendentes e TODAS as sessões do usuário.

Consistência com credenciais (versão da credencial):
- cada usuário tem `credential_version`, incrementada atomicamente na redefinição;
- o login lê (hash, versão), verifica a senha FORA de qualquer lock e só cria a sessão
  se a versão ainda for a mesma (operação condicional atômica no repositório);
- o rehash também é condicional à versão: não sobrescreve uma senha recém-redefinida;
- authenticate/refresh rejeitam sessões cuja versão difere da atual (defesa extra).

Operações públicas caras (Argon2) só rodam depois dos limites de taxa e, na
redefinição, depois de uma pré-validação do token (revalidado atomicamente depois).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol

from app.core.clock import Clock
from app.core.errors import AppError
from app.core.logging import get_logger
from app.domain.auth import AuthSession, User
from app.repositories.auth import (
    EmailAlreadyRegisteredError,
    PasswordResetRepository,
    RotationResult,
    SessionRepository,
    UserRepository,
)
from app.security.google_id_token import (
    GoogleIdTokenVerifier,
    GoogleKeysUnavailableError,
    InvalidGoogleTokenError,
)
from app.security.passwords import PasswordHasher
from app.security.rate_limit import RateLimiter
from app.security.tokens import (
    AccessTokenCodec,
    InvalidAccessTokenError,
    hash_opaque_token,
    new_opaque_token,
)

logger = get_logger("prazoai.auth")

_BEARER = {"WWW-Authenticate": "Bearer"}


def _unauthorized(code: str = "not_authenticated", message: str = "Não autenticado.") -> AppError:
    return AppError(401, code, message, headers=_BEARER)


def _rate_limited(retry: int, message: str = "Muitas tentativas. Tente novamente mais tarde.") -> AppError:
    return AppError(429, "rate_limited", message, headers={"Retry-After": str(retry)})


def _invalid_credentials() -> AppError:
    return _unauthorized("invalid_credentials", "E-mail ou senha inválidos.")


def _recovery_unavailable() -> AppError:
    return AppError(503, "password_recovery_unavailable", "Recuperação de senha indisponível no momento.")


class RecoveryAdmission(Protocol):
    """Admissão do RecoveryDispatcher (só memória; nunca banco, token ou transporte)."""

    @property
    def available(self) -> bool: ...

    def submit(self, email: str) -> object: ...


def _google_unavailable() -> AppError:
    return AppError(503, "google_login_unavailable", "Entrar com Google indisponível no momento.")


def _google_rejected() -> AppError:
    return _unauthorized("invalid_google_token", "Não foi possível confirmar o login com o Google.")


def _invalid_reset_token() -> AppError:
    return AppError(400, "invalid_reset_token", "Token de recuperação inválido ou expirado.")


@dataclass(frozen=True)
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int


@dataclass(frozen=True)
class AuthenticatedUser:
    user: User
    session_id: str


class AuthService:
    def __init__(
        self,
        *,
        users: UserRepository,
        sessions: SessionRepository,
        resets: PasswordResetRepository,
        hasher: PasswordHasher,
        tokens: AccessTokenCodec,
        clock: Clock,
        login_limiter: RateLimiter,
        forgot_limiter: RateLimiter,
        forgot_ip_limiter: RateLimiter,
        register_limiter: RateLimiter,
        reset_limiter: RateLimiter,
        refresh_ttl_seconds: int,
    ) -> None:
        self._users = users
        self._sessions = sessions
        self._resets = resets
        self._hasher = hasher
        self._tokens = tokens
        self._clock = clock
        self._recovery: RecoveryAdmission | None = None   # ligado pela composição (E2); None = desabilitada
        self._google: GoogleIdTokenVerifier | None = None  # ligado pela composição; None = desligado
        self._login_limiter = login_limiter
        self._forgot_limiter = forgot_limiter
        self._forgot_ip_limiter = forgot_ip_limiter
        self._register_limiter = register_limiter
        self._reset_limiter = reset_limiter
        self._refresh_ttl = timedelta(seconds=refresh_ttl_seconds)

    # --- Cadastro -------------------------------------------------------------
    def register(self, name: str, email: str, password: str, client_ip: str = "unknown") -> User:
        retry = self._register_limiter.check_and_hit(client_ip)  # antes de qualquer Argon2
        if retry is not None:
            raise _rate_limited(retry, "Muitos cadastros. Tente novamente mais tarde.")
        # Pré-checagem barata: e-mail já cadastrado não paga Argon2. A unicidade continua
        # garantida atomicamente em `add` (corrida entre dois cadastros novos).
        if self._users.get_by_email(email) is not None:
            raise AppError(409, "email_already_registered", "E-mail já cadastrado.")
        user = User(
            id=uuid.uuid4().hex,
            name=name,
            email=email,
            password_hash=self._hasher.hash(password),  # fora de qualquer lock
            created_at=self._clock.now(),
        )
        try:
            self._users.add(user)
        except EmailAlreadyRegisteredError:
            raise AppError(409, "email_already_registered", "E-mail já cadastrado.") from None
        logger.info("auth_registered user_id=%s", user.id)
        return user

    # --- Login ------------------------------------------------------------------
    def login(self, email: str, password: str, client_ip: str) -> tuple[TokenPair, User]:
        key = f"{client_ip}|{email}"
        # Atômico: conta a tentativa antes de verificar; sucesso zera o contador.
        retry = self._login_limiter.check_and_hit(key)
        if retry is not None:
            raise _rate_limited(retry)
        user = self._users.get_by_email(email)  # instantâneo: hash + versão lidos juntos
        if user is None:
            self._hasher.verify_dummy(password)
            logger.info("auth_login_failed")
            raise _invalid_credentials()
        if not self._hasher.verify(user.password_hash, password):  # Argon2 fora do lock
            logger.info("auth_login_failed")
            raise _invalid_credentials()
        # Cria a sessão SOMENTE se a credencial verificada ainda é a atual.
        pair = self._start_session(user)
        if pair is None:
            logger.info("auth_login_stale_credentials")
            raise _invalid_credentials()
        self._login_limiter.reset(key)
        if self._hasher.needs_rehash(user.password_hash):
            new_hash = self._hasher.hash(password)  # fora do lock
            # Condicional: se houve redefinição no meio, não sobrescreve a senha nova.
            self._users.update_password_hash_if_version(user.id, new_hash, user.credential_version)
        logger.info("auth_login_succeeded user_id=%s", user.id)
        return pair, user

    # --- Entrar com Google -------------------------------------------------------
    def attach_google(self, verifier: GoogleIdTokenVerifier | None) -> None:
        self._google = verifier

    @property
    def google_available(self) -> bool:
        return self._google is not None

    def login_with_google(self, id_token: str, nonce: str, client_ip: str) -> tuple[TokenPair, User, bool]:
        """Login (ou cadastro) a partir do ID token do Google, verificado AQUI.

        Vínculo pelo e-mail verificado pelo Google: quem controla o e-mail já controla a conta (a
        recuperação de senha também é por e-mail). Conta nova recebe uma senha aleatória descartada
        (inutilizável); se quiser senha, a pessoa usa "Esqueci minha senha".
        """
        if self._google is None:
            raise _google_unavailable()
        key = f"{client_ip}|google"
        retry = self._login_limiter.check_and_hit(key)            # antes de rede e de Argon2
        if retry is not None:
            raise _rate_limited(retry)
        try:
            identity = self._google.verify(id_token, nonce)
        except GoogleKeysUnavailableError:
            logger.warning("auth_google_keys_unavailable")
            raise _google_unavailable() from None
        except InvalidGoogleTokenError as exc:
            logger.info("auth_google_rejected reason=%s", exc)     # só o motivo técnico, nunca dados
            raise _google_rejected() from None
        from app.schemas.auth import normalize_email, validate_name

        try:
            email = normalize_email(identity.email)
        except ValueError:
            raise _google_rejected() from None
        created = False
        user = self._users.get_by_email(email)
        if user is None:
            try:
                name = validate_name(identity.name or email.split("@", 1)[0])
            except ValueError:
                name = validate_name(email.split("@", 1)[0])
            candidate = User(
                id=uuid.uuid4().hex,
                name=name,
                email=email,
                password_hash=self._hasher.hash(new_opaque_token()),   # aleatória e descartada
                created_at=self._clock.now(),
            )
            try:
                self._users.add(candidate)
                user, created = candidate, True
            except EmailAlreadyRegisteredError:                       # corrida: outro cadastro venceu
                user = self._users.get_by_email(email)
                if user is None:
                    raise _google_rejected() from None
        pair = self._start_session(user)
        if pair is None:                                              # credencial trocada no meio
            raise _google_rejected()
        self._login_limiter.reset(key)
        logger.info("auth_google_login user_id=%s created=%s", user.id, str(created).lower())
        return pair, user, created

    def _start_session(self, user: User) -> TokenPair | None:
        now = self._clock.now()
        refresh = new_opaque_token()
        session = AuthSession(
            id=uuid.uuid4().hex,
            user_id=user.id,
            created_at=now,
            expires_at=now + self._refresh_ttl,
            current_refresh_hash=hash_opaque_token(refresh),
            credential_version=user.credential_version,
        )
        if not self._sessions.add_if_credentials_current(session):
            return None
        return TokenPair(self._tokens.issue(user.id, session.id), refresh, self._tokens.ttl_seconds)

    # --- Refresh ----------------------------------------------------------------
    def refresh(self, refresh_token: str) -> TokenPair:
        new_refresh = new_opaque_token()
        result, session = self._sessions.rotate_refresh(
            hash_opaque_token(refresh_token), hash_opaque_token(new_refresh), self._clock.now()
        )
        if result is RotationResult.REUSED:
            logger.warning("auth_refresh_reuse_detected session_revoked=true")
            raise _unauthorized("invalid_refresh_token", "Refresh token inválido.")
        if result is RotationResult.LIMIT_REACHED:
            logger.info("auth_refresh_rotation_limit session_revoked=true")
            raise _unauthorized(
                "session_rotation_limit_reached", "Sessão encerrada por limite de renovações. Faça login novamente."
            )
        if result is not RotationResult.ROTATED or session is None:
            raise _unauthorized("invalid_refresh_token", "Refresh token inválido.")
        return TokenPair(self._tokens.issue(session.user_id, session.id), new_refresh, self._tokens.ttl_seconds)

    # --- Autenticação de requisição ------------------------------------------------
    def authenticate(self, access_token: str) -> AuthenticatedUser:
        try:
            claims = self._tokens.decode(access_token)
        except InvalidAccessTokenError:
            raise _unauthorized("invalid_token", "Token inválido ou expirado.") from None
        # Sessão e usuário lidos de forma CONSISTENTE (um único instante), sem bloqueio.
        found = self._sessions.get_with_user(claims.session_id)
        now = self._clock.now()
        if found is None:
            raise _unauthorized("invalid_token", "Token inválido ou expirado.")
        session, user = found
        if session.revoked or session.user_id != claims.user_id or now >= session.expires_at:
            raise _unauthorized("invalid_token", "Token inválido ou expirado.")
        if user.credential_version != session.credential_version:   # sessão anterior a um reset
            raise _unauthorized("invalid_token", "Token inválido ou expirado.")
        return AuthenticatedUser(user=user, session_id=session.id)

    def logout(self, auth: AuthenticatedUser) -> None:
        self._sessions.revoke(auth.session_id, self._clock.now())
        logger.info("auth_logout user_id=%s", auth.user.id)

    # --- Perfil -------------------------------------------------------------------
    def update_name(self, user_id: str, name: str) -> User:
        user = self._users.update_name(user_id, name)
        if user is None:
            raise _unauthorized("invalid_token", "Token inválido ou expirado.")
        return user

    # --- Recuperação de senha -------------------------------------------------------
    def attach_recovery(self, recovery: RecoveryAdmission | None) -> None:
        self._recovery = recovery

    @property
    def recovery_available(self) -> bool:
        return self._recovery is not None and self._recovery.available

    def request_password_recovery(self, email: str, client_ip: str) -> None:
        """Caminho PÚBLICO (E2): só memória — disponibilidade, limites e `put_nowait`.

        Não consulta usuário, não abre conexão SQL, não emite token e não chama o transporte. A
        resposta é a mesma para e-mail existente, inexistente ou fila cheia (descarte contado).
        """
        recovery = self._recovery
        if recovery is None or not recovery.available:          # desabilitada, worker morto ou parando
            raise _recovery_unavailable()
        retry = self._forgot_ip_limiter.check_and_hit(client_ip)   # limite por IP primeiro
        if retry is not None:
            raise _rate_limited(retry, "Muitas solicitações. Tente novamente mais tarde.")
        retry = self._forgot_limiter.check_and_hit(email)          # limite por e-mail (destinatário)
        if retry is not None:
            raise _rate_limited(retry, "Muitas solicitações. Tente novamente mais tarde.")
        if getattr(recovery.submit(email), "value", None) == "unavailable":   # parada concorrente
            raise _recovery_unavailable()

    def reset_password(self, token: str, new_password: str, client_ip: str = "unknown") -> None:
        retry = self._reset_limiter.check_and_hit(client_ip)  # antes de qualquer Argon2
        if retry is not None:
            raise _rate_limited(retry, "Muitas tentativas. Tente novamente mais tarde.")
        token_hash = hash_opaque_token(token)
        # Pré-validação barata (não consome): token inexistente/expirado/usado não paga Argon2.
        if not self._resets.is_active(token_hash, self._clock.now()):
            raise _invalid_reset_token()
        new_hash = self._hasher.hash(new_password)  # fora de qualquer lock
        # Revalida e conclui atomicamente: consumo + credencial (versão+1) + demais tokens + sessões.
        user_id = self._resets.complete_reset(token_hash, new_hash, self._clock.now())
        if user_id is None:
            raise _invalid_reset_token()
        logger.info("auth_password_reset user_id=%s sessions_revoked=true", user_id)

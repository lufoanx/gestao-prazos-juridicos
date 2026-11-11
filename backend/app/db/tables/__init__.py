"""Ponto ÚNICO de importação das tabelas do PrazoAI (P2).

Importar este pacote registra as 14 tabelas no único `MetaData` (`app.db.metadata.metadata`),
organizadas por domínio. NÃO é importado pela aplicação web: nenhum serviço usa o banco nesta
entrega (STORAGE=memory).
"""
from app.db.metadata import metadata
from app.db.tables.deadlines import deadline_comments, deadline_history, deadlines
from app.db.tables.identity import auth_sessions, auth_used_refresh_hashes, password_reset_tokens, users
from app.db.tables.intimations import intimation_events, intimations
from app.db.tables.notifications import notifications
from app.db.tables.org import invitations, join_requests, memberships, offices

TABLE_NAMES = (
    "users", "auth_sessions", "auth_used_refresh_hashes", "password_reset_tokens",
    "offices", "memberships", "invitations", "join_requests",
    "deadlines", "deadline_comments", "deadline_history",
    "intimations", "intimation_events", "notifications",
)

__all__ = [
    "metadata", "TABLE_NAMES",
    "users", "auth_sessions", "auth_used_refresh_hashes", "password_reset_tokens",
    "offices", "memberships", "invitations", "join_requests",
    "deadlines", "deadline_comments", "deadline_history",
    "intimations", "intimation_events", "notifications",
]

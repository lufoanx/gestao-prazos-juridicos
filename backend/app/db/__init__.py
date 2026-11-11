"""Fundação da persistência (P1).

Contém apenas a infraestrutura de conexão (configuração, engine, metadados) usada por comandos
explícitos — migrations Alembic e `python -m app.db check` — e pelos testes de fundação.
A aplicação NÃO importa este pacote no startup e continua usando somente memória.
"""

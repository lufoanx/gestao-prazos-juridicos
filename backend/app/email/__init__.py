"""E-mail transacional (E1 do doc 21): configuração, composição e transporte isolado.

Importar este pacote NÃO carrega nada exclusivo de Linux (sinais, grupos de processos, `resource`);
isso fica em `smtp_subprocess` e no script do filho, usados só com EMAIL_TRANSPORT=smtp.
Nada aqui está ligado à recuperação de senha nesta entrega (E2 pendente).
"""

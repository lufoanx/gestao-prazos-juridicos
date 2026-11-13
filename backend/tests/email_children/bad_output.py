"""Filho de TESTE: escreve algo fora das categorias conhecidas."""
import sys

sys.stdin.buffer.read()
sys.stdout.write(sys.argv[1] if len(sys.argv) > 1 else "categoria-desconhecida\n")

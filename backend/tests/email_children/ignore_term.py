"""Filho de TESTE: ignora SIGTERM e espera (força o escalonamento para SIGKILL)."""
import signal
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
time.sleep(60)

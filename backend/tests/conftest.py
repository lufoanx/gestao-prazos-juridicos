import os
import sys

# Garante que "app" seja importável (raiz do backend no sys.path).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

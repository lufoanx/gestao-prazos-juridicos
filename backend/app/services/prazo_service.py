from datetime import datetime, timedelta


class EntradaPrazoInvalidaError(ValueError):
    """Entrada inválida para o cálculo de prazo (Issue #3).

    Defesa na camada de serviço: a mesma regra vale para qualquer chamador, não só
    para a rota HTTP. `campo` identifica o parâmetro inválido.
    """

    def __init__(self, campo: str, mensagem: str) -> None:
        super().__init__(mensagem)
        self.campo = campo
        self.mensagem = mensagem


FORMATO_DATA = "%d/%m/%Y"
_DIGITOS = frozenset("0123456789")


def validar_data_inicial(data_inicial: str) -> datetime:
    """Exige o formato DD/MM/AAAA e uma data civil existente."""
    texto = data_inicial if isinstance(data_inicial, str) else ""
    formato_ok = (
        len(texto) == 10
        and texto[2] == "/"
        and texto[5] == "/"
        and all(c in _DIGITOS for c in texto[:2] + texto[3:5] + texto[6:])
    )
    if not formato_ok:
        raise EntradaPrazoInvalidaError("data_inicial", "data_inicial deve estar no formato DD/MM/AAAA.")
    try:
        return datetime.strptime(texto, FORMATO_DATA)
    except ValueError as exc:
        raise EntradaPrazoInvalidaError("data_inicial", "data_inicial não é uma data válida.") from exc


def validar_dias(dias: int) -> int:
    """Exige um número inteiro de dias maior ou igual a 1 (sem limite máximo arbitrário)."""
    if isinstance(dias, bool) or not isinstance(dias, int) or dias < 1:
        raise EntradaPrazoInvalidaError("dias", "dias deve ser um número inteiro maior ou igual a 1.")
    return dias


def calcular_prazo(data_inicial: str, dias: int) -> str:
    """Soma `dias` dias úteis a `data_inicial` (DD/MM/AAAA). Não é cálculo processual oficial."""
    inicio = validar_data_inicial(data_inicial)
    validar_dias(dias)
    # Condição necessária (não é limite arbitrário): cada dia útil consome ao menos
    # um dia de calendário, e o calendário suportado termina em 31/12/9999.
    if dias > (datetime.max - inicio).days:
        raise EntradaPrazoInvalidaError("dias", "dias resulta em data fora do intervalo suportado.")
    try:
        return _somar_dias_uteis(inicio, dias)
    except OverflowError as exc:
        raise EntradaPrazoInvalidaError("dias", "dias resulta em data fora do intervalo suportado.") from exc


def _somar_dias_uteis(data: datetime, dias: int) -> str:
    dias_adicionados = 0

    while dias_adicionados < dias:
        data += timedelta(days=1)

        if data.weekday() < 5:
            dias_adicionados += 1

    return data.strftime("%d/%m/%Y")

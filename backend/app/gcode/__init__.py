"""G-code interpretation package.

lexer        -> controller-neutral tokenizer
controllers  -> dialect tables (FANUC now; Siemens/Mitsubishi later)
interpreter  -> modal state machine producing motions + diagnostics
"""

from .interpreter import InterpretResult, Interpreter, interpret
from .model import InterpreterSettings

__all__ = ["InterpretResult", "Interpreter", "InterpreterSettings", "interpret"]

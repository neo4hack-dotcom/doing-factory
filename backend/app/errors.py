"""Domain errors. The API layer maps them to HTTP responses (see app/main.py exception handlers)."""
from __future__ import annotations


class FactoryError(Exception):
    """Base error. `status_code` is used by the API exception handler."""
    status_code = 400

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.message = message
        if status_code is not None:
            self.status_code = status_code


class NotFound(FactoryError):
    status_code = 404


class Conflict(FactoryError):
    status_code = 409


class Forbidden(FactoryError):
    status_code = 403


class NotConfigured(FactoryError):
    """A dependency (LLM, connector, operation) is not configured. Message must say where to fix it."""
    status_code = 424


class EngineError(FactoryError):
    status_code = 400


class LLMError(FactoryError):
    status_code = 502


class LLMNotConfigured(LLMError, NotConfigured):
    status_code = 424

    def __init__(self, message: str = "No LLM configured — open Settings › AI Model to connect Ollama or an OpenAI-compatible server."):
        super().__init__(message)


class MCPError(FactoryError):
    status_code = 502


class TemplateError(FactoryError):
    status_code = 422

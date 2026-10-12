"""Deployment settings: every knob that belongs to the machine, not to the user, with one
env prefix (FACTORY_) and `backend/.env`.

Nothing here is required. The Factory boots with an empty `.env`, the whole UI loads, and
only the feature whose dependency is missing fails — with a message that names the fix.
Preferences an admin changes at runtime (LLM, engine, scheduler…) live in the `settings`
singleton of the store (models.AppSettings), not here; the optional FACTORY_LLM_* values
below only seed that singleton on a first boot so a scripted deployment comes up connected.
"""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

VERSION = "1.0.0"
BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    # UTF-8 whatever the OS locale; `-sig` absorbs the BOM some Windows editors add.
    model_config = SettingsConfigDict(env_prefix="FACTORY_", env_file=str(BACKEND_DIR / ".env"),
                                      env_file_encoding="utf-8-sig", extra="ignore")

    # Loopback by default: reachable from other machines only when the deployment says so.
    host: str = "127.0.0.1"
    port: int = 3071

    # Relative paths are resolved against backend/, never the current directory, so
    # `python -m app`, uvicorn and pytest all land on the same files.
    data_dir: str = "data"
    db_path: str = "data/factory.db"
    static_dir: str = ""                 # "" = auto-detect ../frontend/dist

    # Scheduler loop + boot-time connector check. Off for tests and one-off scripts that
    # import the app without wanting watchers to start polling real systems.
    background_jobs: bool = True

    # First-boot seed for Settings › AI Model (ignored once settings were saved in the UI).
    llm_provider: str = ""               # "ollama" | "openai" ("" = ollama)
    llm_base_url: str = ""               # e.g. http://127.0.0.1:11434 (Ollama, no /v1)
    llm_model: str = ""                  # e.g. qwen3.5:4b
    llm_api_key: str = ""

    def resolve(self, value: str) -> Path:
        path = Path(value).expanduser()
        return path if path.is_absolute() else (BACKEND_DIR / path).resolve()

    @property
    def db_file(self) -> Path:
        return self.resolve(self.db_path)

    @property
    def data_path(self) -> Path:
        return self.resolve(self.data_dir)

    @property
    def static_path(self) -> Path:
        if self.static_dir:
            return self.resolve(self.static_dir)
        return BACKEND_DIR.parent / "frontend" / "dist"


settings = Settings()

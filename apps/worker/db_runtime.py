#!/usr/bin/env python3
"""DB runtime helpers for sqlite/neon worker execution."""

from __future__ import annotations

import os
import sqlite3
from typing import Any, Iterable


DEFAULT_NEON_DSN_ENV = "NEON_DATABASE_URL"
DEFAULT_NEON_CONNECT_TIMEOUT_S = 15


def _require_psycopg():
    try:
        import psycopg  # type: ignore[import-not-found]
        from psycopg.rows import dict_row  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - depends on local env
        raise SystemExit(
            "psycopg is not installed. install with: pip install 'psycopg[binary]'"
        ) from exc
    return psycopg, dict_row


def is_sqlite_conn(conn: Any) -> bool:
    return isinstance(conn, sqlite3.Connection)


def resolve_neon_dsn(neon_dsn: str | None, neon_dsn_env: str) -> str:
    if neon_dsn:
        return neon_dsn
    env_value = os.environ.get(neon_dsn_env)
    if env_value:
        return env_value
    raise SystemExit(
        f"--neon-dsn is required when --backend neon (or set env: {neon_dsn_env})"
    )


def open_connection(
    *,
    backend: str,
    db: str | None,
    neon_dsn: str | None,
    neon_dsn_env: str,
    neon_connect_timeout: int,
):
    if backend == "sqlite":
        if not db:
            raise SystemExit("--db is required when --backend sqlite")
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        return conn

    if backend == "neon":
        dsn = resolve_neon_dsn(neon_dsn, neon_dsn_env)
        psycopg, dict_row = _require_psycopg()
        try:
            return psycopg.connect(
                dsn,
                connect_timeout=neon_connect_timeout,
                row_factory=dict_row,
            )
        except Exception as exc:  # pragma: no cover - external infra
            raise SystemExit(f"failed to connect to Neon: {exc}") from exc

    raise SystemExit(f"unsupported backend: {backend}")


def _adapt_sqlite_query(query: str) -> str:
    return query.replace("%s", "?")


def fetch_all(conn: Any, query: str, params: Iterable[Any] = ()) -> list[Any]:
    if is_sqlite_conn(conn):
        return list(conn.execute(_adapt_sqlite_query(query), tuple(params)))
    with conn.cursor() as cur:
        cur.execute(query, tuple(params))
        return list(cur.fetchall())


def fetch_one(conn: Any, query: str, params: Iterable[Any] = ()) -> Any | None:
    if is_sqlite_conn(conn):
        return conn.execute(_adapt_sqlite_query(query), tuple(params)).fetchone()
    with conn.cursor() as cur:
        cur.execute(query, tuple(params))
        return cur.fetchone()


def exec_write(conn: Any, query: str, params: Iterable[Any] = ()) -> int:
    if is_sqlite_conn(conn):
        cur = conn.execute(_adapt_sqlite_query(query), tuple(params))
        return cur.rowcount
    with conn.cursor() as cur:
        cur.execute(query, tuple(params))
        return cur.rowcount


def now_expr(conn: Any) -> str:
    if is_sqlite_conn(conn):
        return "datetime('now')"
    return "now()"


def epoch_expr(conn: Any) -> str:
    if is_sqlite_conn(conn):
        return "'1970-01-01'"
    return "'1970-01-01'::timestamptz"


def to_text_datetime(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    iso = getattr(value, "isoformat", None)
    if callable(iso):
        return str(iso())
    return str(value)

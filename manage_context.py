# -*- coding: utf-8 -*-
"""
Utility script for managing context switching, notification logs, and AI reminders.

This script mirrors the CLI pattern used by manage_log.py but targets a dedicated
SQLite database (notify_state.db) so that study log data remains isolated.

Usage:
    python manage_context.py [--api-mode] execute '<json_payload>'

All commands accept/return JSON to make it easy for both the Node server and the
Gemini agent to interact through shell tool calls.
"""

from __future__ import annotations

import datetime
import re
import json
import logging
import os
import sqlite3
import sys
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover (Python <3.9 not expected, but fallback)
    ZoneInfo = None  # type: ignore


# ---------------------------------------------------------------------------
# Constants & basic helpers
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(SCRIPT_DIR, 'notify_state.db')
LOG_PATH = os.path.join(SCRIPT_DIR, 'manage_context.log')
TZ = ZoneInfo("Asia/Tokyo") if ZoneInfo else None


def now_ts() -> str:
    """Return current timestamp in ISO 8601 format with timezone offset."""
    if TZ:
        return datetime.datetime.now(TZ).isoformat(timespec='seconds')
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


ISO_TZ_PATTERN = re.compile(r'([zZ])|([+-]\d{2}:?\d{2})$')


def ensure_iso_timestamp(value: Optional[str]) -> Optional[str]:
    if not value or not isinstance(value, str):
        return value
    if 'T' in value and ISO_TZ_PATTERN.search(value):
        try:
            return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat(timespec='seconds')
        except ValueError:
            return value
    # Legacy format without timezone (assume TZ if available, else UTC)
    try:
        dt = datetime.datetime.strptime(value, '%Y-%m-%d %H:%M:%S')
        tz = TZ or datetime.timezone.utc
        dt = dt.replace(tzinfo=tz)
        return dt.isoformat(timespec='seconds')
    except ValueError:
        return value


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def get_connection() -> sqlite3.Connection:
    ensure_dir(os.path.dirname(DB_PATH))
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(',', ':'))


def json_loads(data: Optional[str], fallback: Any) -> Any:
    if not data:
        return fallback
    try:
        return json.loads(data)
    except Exception:
        return fallback


# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------

logger = logging.getLogger(__name__)


def setup_logging(api_mode: bool = False) -> None:
    logger.setLevel(logging.INFO)
    if logger.hasHandlers():
        logger.handlers.clear()

    file_handler = logging.FileHandler(LOG_PATH, encoding='utf-8')
    file_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    logger.addHandler(file_handler)

    if not api_mode:
        stream_handler = logging.StreamHandler(sys.stderr)
        stream_handler.setFormatter(logging.Formatter('%(message)s'))
        logger.addHandler(stream_handler)


# ---------------------------------------------------------------------------
# Schema management
# ---------------------------------------------------------------------------

def create_tables() -> None:
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS context_modes (
                mode_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                description TEXT,
                ai_notes TEXT,
                knowledge_refs TEXT,
                presentation TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS context_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                active_mode_id TEXT NOT NULL,
                manual_override_mode_id TEXT,
                active_since TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(active_mode_id) REFERENCES context_modes(mode_id)
            )
            """
        )

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS context_pending (
                id TEXT PRIMARY KEY,
                mode_id TEXT NOT NULL,
                source TEXT,
                payload_json TEXT,
                entered_at TEXT NOT NULL,
                expires_at TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                resolved_at TEXT,
                resolution TEXT,
                FOREIGN KEY(mode_id) REFERENCES context_modes(mode_id)
            )
            """
        )

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_context_pending_status
            ON context_pending(status)
            """
        )

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS context_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                mode_id TEXT,
                payload_json TEXT,
                source TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(mode_id) REFERENCES context_modes(mode_id)
            )
            """
        )

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_context_events_created_at
            ON context_events(created_at DESC)
            """
        )

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS notify_log_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                decision TEXT,
                reason TEXT,
                source TEXT,
                mode_id TEXT,
                payload_json TEXT NOT NULL,
                context_json TEXT,
                triggered_at TEXT,
                created_at TEXT NOT NULL,
                resend_of INTEGER,
                test INTEGER NOT NULL DEFAULT 0,
                manual_send INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(resend_of) REFERENCES notify_log_entries(id)
            )
            """
        )

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_notify_log_created_at
            ON notify_log_entries(created_at DESC)
            """
        )

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_notify_log_user
            ON notify_log_entries(user_id)
            """
        )

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_reminders (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'local',
                fire_at TEXT NOT NULL,
                status TEXT NOT NULL,
                context_json TEXT,
                purpose TEXT,
                created_by TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                meta_json TEXT
            )
            """
        )

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_ai_reminders_fire_status
            ON ai_reminders(status, fire_at)
            """
        )

        # Seed defaults if necessary
        seed_defaults(cur)
        conn.commit()


def seed_defaults(cur: sqlite3.Cursor) -> None:
    cur.execute("SELECT 1 FROM context_modes WHERE mode_id = ?", ('default',))
    if cur.fetchone() is None:
        now = now_ts()
        cur.execute(
            """
            INSERT INTO context_modes (
                mode_id, display_name, description, ai_notes,
                knowledge_refs, presentation, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                'default',
                'デフォルト',
                '通知の基本シーンです。',
                '基本モード。特別な制限はありません。',
                json_dumps([]),
                json_dumps({}),
                now,
                now,
            ),
        )

    cur.execute("SELECT 1 FROM context_state WHERE id = 1")
    if cur.fetchone() is None:
        now = now_ts()
        cur.execute(
            """
            INSERT INTO context_state (
                id, active_mode_id, manual_override_mode_id, active_since, updated_at
            ) VALUES (1, ?, NULL, ?, ?)
            """,
            ('default', now, now),
        )


# ---------------------------------------------------------------------------
# Rows -> dict helpers
# ---------------------------------------------------------------------------

def row_to_mode(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        'mode_id': row['mode_id'],
        'display_name': row['display_name'],
        'description': row['description'],
        'ai_notes': row['ai_notes'],
        'knowledge_refs': json_loads(row['knowledge_refs'], []),
        'presentation': json_loads(row['presentation'], {}),
        'created_at': ensure_iso_timestamp(row['created_at']),
        'updated_at': ensure_iso_timestamp(row['updated_at']),
    }


def row_to_pending(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        'id': row['id'],
        'mode_id': row['mode_id'],
        'source': row['source'],
        'payload': json_loads(row['payload_json'], None),
        'entered_at': ensure_iso_timestamp(row['entered_at']),
        'expires_at': ensure_iso_timestamp(row['expires_at']),
        'status': row['status'],
        'resolved_at': ensure_iso_timestamp(row['resolved_at']),
        'resolution': row['resolution'],
    }


def row_to_event(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        'id': row['id'],
        'event_type': row['event_type'],
        'mode_id': row['mode_id'],
        'payload': json_loads(row['payload_json'], None),
        'source': row['source'],
        'created_at': ensure_iso_timestamp(row['created_at']),
    }


def row_to_notify_entry(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        'id': row['id'],
        'user_id': row['user_id'],
        'decision': row['decision'],
        'reason': row['reason'],
        'source': row['source'],
        'mode_id': row['mode_id'],
        'payload': json_loads(row['payload_json'], {}),
        'context': json_loads(row['context_json'], None),
        'triggered_at': ensure_iso_timestamp(row['triggered_at']),
        'created_at': ensure_iso_timestamp(row['created_at']),
        'resend_of': row['resend_of'],
        'test': bool(row['test']),
        'manual_send': bool(row['manual_send']),
    }


def row_to_reminder(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        'id': row['id'],
        'user_id': row['user_id'],
        'fire_at': ensure_iso_timestamp(row['fire_at']),
        'status': row['status'],
        'context': json_loads(row['context_json'], None),
        'purpose': row['purpose'],
        'created_by': row['created_by'],
        'created_at': ensure_iso_timestamp(row['created_at']),
        'updated_at': ensure_iso_timestamp(row['updated_at']),
        'meta': json_loads(row['meta_json'], None),
    }


# ---------------------------------------------------------------------------
# Action implementations
# ---------------------------------------------------------------------------


def action_context_mode_list(params: Dict[str, Any]) -> Dict[str, Any]:
    with get_connection() as conn:
        cur = conn.execute("SELECT * FROM context_modes ORDER BY display_name")
        modes = [row_to_mode(r) for r in cur.fetchall()]
    return {'modes': modes}


def action_context_mode_get(params: Dict[str, Any]) -> Dict[str, Any]:
    mode_id = params.get('mode_id')
    if not mode_id:
        raise ValueError('mode_id required')
    with get_connection() as conn:
        cur = conn.execute("SELECT * FROM context_modes WHERE mode_id = ?", (mode_id,))
        row = cur.fetchone()
    if not row:
        return {'mode': None}
    return {'mode': row_to_mode(row)}


def action_context_mode_upsert(params: Dict[str, Any]) -> Dict[str, Any]:
    mode = params.get('mode') or params
    mode_id = mode.get('mode_id')
    display_name = (mode.get('display_name') or '').strip()
    if not display_name:
        raise ValueError('display_name required')
    description = mode.get('description')
    ai_notes = mode.get('ai_notes')
    knowledge_refs = mode.get('knowledge_refs') or []
    presentation = mode.get('presentation') or {}
    now = now_ts()

    if mode_id is None or str(mode_id).strip() == '':
        mode_id = str(uuid.uuid4())

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM context_modes WHERE mode_id = ?", (mode_id,))
        exists = cur.fetchone() is not None
        if exists:
            cur.execute(
                """
                UPDATE context_modes
                SET display_name = ?, description = ?, ai_notes = ?,
                    knowledge_refs = ?, presentation = ?, updated_at = ?
                WHERE mode_id = ?
                """,
                (
                    display_name,
                    description,
                    ai_notes,
                    json_dumps(knowledge_refs),
                    json_dumps(presentation),
                    now,
                    mode_id,
                ),
            )
        else:
            cur.execute(
                """
                INSERT INTO context_modes (
                    mode_id, display_name, description, ai_notes,
                    knowledge_refs, presentation, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mode_id,
                    display_name,
                    description,
                    ai_notes,
                    json_dumps(knowledge_refs),
                    json_dumps(presentation),
                    now,
                    now,
                ),
            )
        conn.commit()

    return action_context_mode_get({'mode_id': mode_id})


def action_context_mode_delete(params: Dict[str, Any]) -> Dict[str, Any]:
    mode_id = params.get('mode_id')
    if not mode_id:
        raise ValueError('mode_id required')
    if mode_id == 'default':
        raise ValueError('default mode cannot be deleted')

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT active_mode_id, manual_override_mode_id FROM context_state WHERE id = 1")
        state = cur.fetchone()
        if state:
            if state['active_mode_id'] == mode_id:
                raise ValueError('cannot delete active mode')
            if state['manual_override_mode_id'] == mode_id:
                raise ValueError('cannot delete mode in manual override')
        cur.execute("DELETE FROM context_modes WHERE mode_id = ?", (mode_id,))
        deleted = cur.rowcount
        conn.commit()

    return {'deleted': bool(deleted)}


def action_context_state_get(params: Dict[str, Any]) -> Dict[str, Any]:
    with get_connection() as conn:
        cur = conn.execute("SELECT * FROM context_state WHERE id = 1")
        state_row = cur.fetchone()
        if not state_row:
            raise RuntimeError('context state not initialized')
        state = {
            'active_mode_id': state_row['active_mode_id'],
            'manual_override_mode_id': state_row['manual_override_mode_id'],
            'active_since': ensure_iso_timestamp(state_row['active_since']),
            'updated_at': ensure_iso_timestamp(state_row['updated_at']),
        }

        pending_cur = conn.execute(
            "SELECT * FROM context_pending WHERE status = 'open' ORDER BY entered_at"
        )
        pending = [row_to_pending(r) for r in pending_cur.fetchall()]

    return {'state': state, 'pending': pending}


def action_context_state_set(params: Dict[str, Any]) -> Dict[str, Any]:
    mode_id = params.get('mode_id')
    if not mode_id:
        raise ValueError('mode_id required')
    manual_override = params.get('manual_override')
    now = now_ts()

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM context_modes WHERE mode_id = ?", (mode_id,))
        if cur.fetchone() is None:
            raise ValueError(f'mode not found: {mode_id}')

        cur.execute(
            """
            UPDATE context_state
               SET active_mode_id = ?,
                   active_since = ?,
                   updated_at = ?,
                   manual_override_mode_id = CASE
                       WHEN ? THEN ?
                       ELSE manual_override_mode_id
                   END
            WHERE id = 1
            """,
            (
                mode_id,
                now,
                now,
                1 if manual_override is True else 0,
                mode_id,
            ),
        )

        if manual_override is False:
            cur.execute(
                "UPDATE context_state SET manual_override_mode_id = NULL, updated_at = ? WHERE id = 1",
                (now,),
            )

        conn.commit()

    return action_context_state_get({})


def action_context_pending_create(params: Dict[str, Any]) -> Dict[str, Any]:
    mode_id = params.get('mode_id')
    if not mode_id:
        raise ValueError('mode_id required')
    pending_id = params.get('id') or str(uuid.uuid4())
    source = params.get('source')
    payload = params.get('payload')
    entered_at = params.get('entered_at') or now_ts()
    expires_at = params.get('expires_at')
    status = params.get('status') or 'open'

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM context_modes WHERE mode_id = ?", (mode_id,))
        if cur.fetchone() is None:
            raise ValueError(f'mode not found: {mode_id}')
        cur.execute(
            """
            INSERT OR REPLACE INTO context_pending (
                id, mode_id, source, payload_json, entered_at,
                expires_at, status, resolved_at, resolution
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                pending_id,
                mode_id,
                source,
                json_dumps(payload) if payload is not None else None,
                entered_at,
                expires_at,
                status,
                params.get('resolved_at'),
                params.get('resolution'),
            ),
        )
        conn.commit()

    return {'pending': row_to_pending(fetch_pending_row(pending_id))}


def fetch_pending_row(pending_id: str) -> sqlite3.Row:
    with get_connection() as conn:
        cur = conn.execute("SELECT * FROM context_pending WHERE id = ?", (pending_id,))
        row = cur.fetchone()
    if not row:
        raise ValueError(f'pending not found: {pending_id}')
    return row


def action_context_pending_update(params: Dict[str, Any]) -> Dict[str, Any]:
    pending_id = params.get('id')
    if not pending_id:
        raise ValueError('id required')

    updates = {}
    payload = params.get('payload')
    for key in ['mode_id', 'source', 'entered_at', 'expires_at', 'status', 'resolved_at', 'resolution']:
        if key in params and params[key] is not None:
            updates[key] = params[key]
    if payload is not None:
        updates['payload_json'] = json_dumps(payload)

    if not updates:
        return {'pending': row_to_pending(fetch_pending_row(pending_id))}

    set_clause = ', '.join(f"{col} = ?" for col in updates.keys())
    values = list(updates.values())
    values.append(pending_id)

    with get_connection() as conn:
        conn.execute(f"UPDATE context_pending SET {set_clause} WHERE id = ?", values)
        conn.commit()

    return {'pending': row_to_pending(fetch_pending_row(pending_id))}


def action_context_pending_list(params: Dict[str, Any]) -> Dict[str, Any]:
    status = params.get('status')
    mode_id = params.get('mode_id')
    limit = params.get('limit') or 50
    offset = params.get('offset') or 0
    clauses = []
    values: List[Any] = []
    if status:
        clauses.append('status = ?')
        values.append(status)
    if mode_id:
        clauses.append('mode_id = ?')
        values.append(mode_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ''

    with get_connection() as conn:
        cur = conn.execute(
            f"SELECT * FROM context_pending {where} ORDER BY entered_at DESC LIMIT ? OFFSET ?",
            (*values, limit, offset),
        )
        rows = cur.fetchall()
    return {'pending': [row_to_pending(r) for r in rows]}


def action_context_events_append(params: Dict[str, Any]) -> Dict[str, Any]:
    event_type = params.get('event_type')
    if not event_type:
        raise ValueError('event_type required')
    mode_id = params.get('mode_id')
    payload = params.get('payload')
    source = params.get('source')
    now = now_ts()

    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO context_events (event_type, mode_id, payload_json, source, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                event_type,
                mode_id,
                json_dumps(payload) if payload is not None else None,
                source,
                now,
            ),
        )
        conn.commit()

    return {'ok': True}


def action_context_events_recent(params: Dict[str, Any]) -> Dict[str, Any]:
    limit = params.get('limit') or 100
    with get_connection() as conn:
        cur = conn.execute(
            "SELECT * FROM context_events ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
        rows = cur.fetchall()
    return {'events': [row_to_event(r) for r in rows]}


def action_notify_log_append(params: Dict[str, Any]) -> Dict[str, Any]:
    user_id = params.get('user_id') or 'local'
    payload = params.get('payload')
    if payload is None:
        raise ValueError('payload required')
    decision = params.get('decision')
    reason = params.get('reason')
    source = params.get('source')
    mode_id = params.get('mode_id')
    context = params.get('context')
    triggered_at = params.get('triggered_at')
    resend_of = params.get('resend_of')
    test = 1 if params.get('test') else 0
    manual_send = 1 if params.get('manual_send') else 0
    created_at = params.get('created_at') or now_ts()

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO notify_log_entries (
                user_id, decision, reason, source, mode_id,
                payload_json, context_json, triggered_at, created_at,
                resend_of, test, manual_send
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                decision,
                reason,
                source,
                mode_id,
                json_dumps(payload),
                json_dumps(context) if context is not None else None,
                triggered_at,
                created_at,
                resend_of,
                test,
                manual_send,
            ),
        )
        inserted_id = cur.lastrowid
        conn.commit()

    return action_notify_log_get({'id': inserted_id})


def action_notify_log_get(params: Dict[str, Any]) -> Dict[str, Any]:
    entry_id = params.get('id')
    if entry_id is None:
        raise ValueError('id required')
    with get_connection() as conn:
        cur = conn.execute("SELECT * FROM notify_log_entries WHERE id = ?", (entry_id,))
        row = cur.fetchone()
    if not row:
        return {'entry': None}
    return {'entry': row_to_notify_entry(row)}


def action_notify_log_list(params: Dict[str, Any]) -> Dict[str, Any]:
    user_id = params.get('user_id') or 'local'
    limit = int(params.get('limit') or 10)
    offset = int(params.get('offset') or 0)
    search = params.get('search')
    decision = params.get('decision')
    mode_id = params.get('mode_id')
    source = params.get('source')

    clauses = ['user_id = ?']
    values: List[Any] = [user_id]
    if decision:
        clauses.append('decision = ?')
        values.append(decision)
    if mode_id:
        clauses.append('mode_id = ?')
        values.append(mode_id)
    if source:
        clauses.append('source = ?')
        values.append(source)
    if search:
        clauses.append("(COALESCE(reason, '') LIKE ? OR COALESCE(payload_json, '') LIKE ?)")
        search_term = f'%{search}%'
        values.extend([search_term, search_term])

    where_clause = 'WHERE ' + ' AND '.join(clauses)

    with get_connection() as conn:
        cur = conn.execute(
            f"SELECT COUNT(*) FROM notify_log_entries {where_clause}",
            tuple(values),
        )
        total = cur.fetchone()[0]

        cur = conn.execute(
            f"""
            SELECT * FROM notify_log_entries
            {where_clause}
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            tuple(values + [limit, offset]),
        )
        rows = cur.fetchall()

    return {
        'entries': [row_to_notify_entry(r) for r in rows],
        'total': total,
        'limit': limit,
        'offset': offset,
    }


def action_notify_log_today_stats(params: Dict[str, Any]) -> Dict[str, Any]:
    user_id = params.get('user_id') or 'local'
    date = params.get('date')
    if date:
        target_date = datetime.datetime.strptime(date, '%Y-%m-%d').date()
    else:
        target_date = datetime.datetime.now(TZ).date() if TZ else datetime.datetime.utcnow().date()
    tz = TZ or datetime.timezone.utc
    day_start = datetime.datetime.combine(target_date, datetime.time.min).replace(tzinfo=tz)
    day_end = datetime.datetime.combine(target_date, datetime.time.max).replace(tzinfo=tz)
    start_str = day_start.isoformat(timespec='seconds')
    end_str = day_end.isoformat(timespec='seconds')

    legacy_start = day_start.strftime('%Y-%m-%d %H:%M:%S')
    legacy_end = day_end.strftime('%Y-%m-%d %H:%M:%S')

    with get_connection() as conn:
        cur = conn.execute(
            """
            SELECT COUNT(*)
              FROM notify_log_entries
             WHERE user_id = ?
               AND decision = 'send'
               AND test = 0
               AND manual_send = 0
               AND (
                    created_at BETWEEN ? AND ?
                 OR created_at BETWEEN ? AND ?
               )
            """,
            (user_id, start_str, end_str, legacy_start, legacy_end),
        )
        count = cur.fetchone()[0]

    return {'user_id': user_id, 'date': target_date.isoformat(), 'count': count}


def action_notify_log_mark_test(params: Dict[str, Any]) -> Dict[str, Any]:
    user_id = params.get('user_id') or 'local'
    date = params.get('date')
    if date:
        target_date = datetime.datetime.strptime(date, '%Y-%m-%d').date()
    else:
        target_date = datetime.datetime.now(TZ).date() if TZ else datetime.datetime.utcnow().date()
    tz = TZ or datetime.timezone.utc
    day_start = datetime.datetime.combine(target_date, datetime.time.min).replace(tzinfo=tz).isoformat(timespec='seconds')
    day_end = datetime.datetime.combine(target_date, datetime.time.max).replace(tzinfo=tz).isoformat(timespec='seconds')

    legacy_start = datetime.datetime.combine(target_date, datetime.time.min).strftime('%Y-%m-%d %H:%M:%S')
    legacy_end = datetime.datetime.combine(target_date, datetime.time.max).strftime('%Y-%m-%d %H:%M:%S')

    with get_connection() as conn:
        cur = conn.execute(
            """
            UPDATE notify_log_entries
               SET test = 1
             WHERE user_id = ?
               AND (
                    created_at BETWEEN ? AND ?
                 OR created_at BETWEEN ? AND ?
               )
            """,
            (user_id, day_start, day_end, legacy_start, legacy_end),
        )
        changed = cur.rowcount
        conn.commit()

    return {'changed': changed}


def action_ai_reminder_create(params: Dict[str, Any]) -> Dict[str, Any]:
    reminder_id = params.get('id') or str(uuid.uuid4())
    user_id = params.get('user_id') or 'local'
    fire_at = ensure_iso_timestamp(params.get('fire_at'))
    if not fire_at:
        raise ValueError('fire_at required')
    status = params.get('status') or 'scheduled'
    context = params.get('context')
    purpose = params.get('purpose')
    created_by = params.get('created_by')
    meta = params.get('meta')
    now = now_ts()

    created_at = ensure_iso_timestamp(params.get('created_at')) or now
    updated_at = ensure_iso_timestamp(params.get('updated_at')) or now

    with get_connection() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO ai_reminders (
                id, user_id, fire_at, status, context_json,
                purpose, created_by, created_at, updated_at, meta_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                reminder_id,
                user_id,
                fire_at,
                status,
                json_dumps(context) if context is not None else None,
                purpose,
                created_by,
                created_at,
                updated_at,
                json_dumps(meta) if meta is not None else None,
            ),
        )
        conn.commit()

    return action_ai_reminder_get({'id': reminder_id})


def action_ai_reminder_get(params: Dict[str, Any]) -> Dict[str, Any]:
    reminder_id = params.get('id')
    if not reminder_id:
        raise ValueError('id required')
    with get_connection() as conn:
        cur = conn.execute("SELECT * FROM ai_reminders WHERE id = ?", (reminder_id,))
        row = cur.fetchone()
    if not row:
        return {'reminder': None}
    return {'reminder': row_to_reminder(row)}


def action_ai_reminder_update(params: Dict[str, Any]) -> Dict[str, Any]:
    reminder_id = params.get('id')
    if not reminder_id:
        raise ValueError('id required')

    updates: Dict[str, Any] = {}
    for key in ['status', 'purpose', 'created_by']:
        if key in params and params[key] is not None:
            updates[key] = params[key]
    if 'fire_at' in params and params['fire_at'] is not None:
        fire_at = ensure_iso_timestamp(params['fire_at'])
        if not fire_at:
            raise ValueError('invalid fire_at')
        updates['fire_at'] = fire_at
    if 'context' in params:
        updates['context_json'] = json_dumps(params['context']) if params['context'] is not None else None
    if 'meta' in params:
        updates['meta_json'] = json_dumps(params['meta']) if params['meta'] is not None else None
    if not updates:
        return action_ai_reminder_get({'id': reminder_id})

    updates['updated_at'] = now_ts()

    set_clause = ', '.join(f"{col} = ?" for col in updates.keys())
    values = list(updates.values())
    values.append(reminder_id)

    with get_connection() as conn:
        conn.execute(f"UPDATE ai_reminders SET {set_clause} WHERE id = ?", values)
        conn.commit()

    return action_ai_reminder_get({'id': reminder_id})


def action_ai_reminder_delete(params: Dict[str, Any]) -> Dict[str, Any]:
    reminder_id = params.get('id')
    if not reminder_id:
        raise ValueError('id required')
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM ai_reminders WHERE id = ?", (reminder_id,))
        deleted = cur.rowcount
        conn.commit()
    return {'deleted': bool(deleted)}


def action_ai_reminder_list(params: Dict[str, Any]) -> Dict[str, Any]:
    user_id = params.get('user_id') or 'local'
    status = params.get('status')
    since = params.get('since')
    until = params.get('until')
    limit = params.get('limit') or 100
    offset = params.get('offset') or 0

    clauses = ['user_id = ?']
    values: List[Any] = [user_id]
    if status:
        clauses.append('status = ?')
        values.append(status)
    if since:
        clauses.append('fire_at >= ?')
        values.append(since)
    if until:
        clauses.append('fire_at <= ?')
        values.append(until)

    where = 'WHERE ' + ' AND '.join(clauses)

    with get_connection() as conn:
        cur = conn.execute(
            f"""
            SELECT * FROM ai_reminders
            {where}
            ORDER BY fire_at ASC
            LIMIT ? OFFSET ?
            """,
            (*values, limit, offset),
        )
        rows = cur.fetchall()

    return {'reminders': [row_to_reminder(r) for r in rows]}


def action_ai_reminder_due(params: Dict[str, Any]) -> Dict[str, Any]:
    user_id = params.get('user_id') or 'local'
    before = params.get('before') or now_ts()
    limit = params.get('limit') or 50
    with get_connection() as conn:
        cur = conn.execute(
            """
            SELECT * FROM ai_reminders
             WHERE user_id = ?
               AND status = 'scheduled'
               AND datetime(fire_at) <= datetime(?)
             ORDER BY fire_at ASC
             LIMIT ?
            """,
            (user_id, before, limit),
        )
        rows = cur.fetchall()
    return {'reminders': [row_to_reminder(r) for r in rows]}


# ---------------------------------------------------------------------------
# CLI handling
# ---------------------------------------------------------------------------


def print_help() -> None:
    message = (
        "Usage: python manage_context.py [--api-mode] execute '<json_payload>'\n\n"
        "Examples:\n"
        "  python manage_context.py execute '{\"action\": \"context.mode_list\"}'\n"
        "  python manage_context.py --api-mode execute '{\"action\": \"notify.log_list\", \"params\": {\"limit\": 5}}'\n"
    )
    print(message)


ACTION_HANDLERS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    'context.mode_list': action_context_mode_list,
    'context.mode_get': action_context_mode_get,
    'context.mode_upsert': action_context_mode_upsert,
    'context.mode_delete': action_context_mode_delete,
    'context.state_get': action_context_state_get,
    'context.state_set': action_context_state_set,
    'context.pending_create': action_context_pending_create,
    'context.pending_update': action_context_pending_update,
    'context.pending_list': action_context_pending_list,
    'context.events_append': action_context_events_append,
    'context.events_recent': action_context_events_recent,
    'notify.log_append': action_notify_log_append,
    'notify.log_get': action_notify_log_get,
    'notify.log_list': action_notify_log_list,
    'notify.log_today_stats': action_notify_log_today_stats,
    'notify.log_mark_test': action_notify_log_mark_test,
    'ai.reminder_create': action_ai_reminder_create,
    'ai.reminder_get': action_ai_reminder_get,
    'ai.reminder_update': action_ai_reminder_update,
    'ai.reminder_delete': action_ai_reminder_delete,
    'ai.reminder_list': action_ai_reminder_list,
    'ai.reminder_due': action_ai_reminder_due,
}


def handle_execute(json_string: str) -> None:
    try:
        data = json.loads(json_string)
    except json.JSONDecodeError as exc:
        print(json.dumps({'status': 'error', 'message': f'Invalid JSON payload: {exc}'}))
        sys.exit(1)

    action = data.get('action')
    params = data.get('params')
    if params is None:
        # Allow top-level fields (besides action/params) to be treated as parameters
        params = {
            key: value
            for key, value in data.items()
            if key not in ('action', 'params')
        }
    if not isinstance(params, dict):
        print(json.dumps({'status': 'error', 'message': "'params' must be an object"}))
        sys.exit(1)
    if not action:
        print(json.dumps({'status': 'error', 'message': "Missing 'action' field"}))
        sys.exit(1)

    handler = ACTION_HANDLERS.get(action)
    if not handler:
        print(json.dumps({'status': 'error', 'message': f'Unknown action: {action}'}))
        sys.exit(1)

    try:
        result = handler(params)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        logger.exception("Action %s failed", action)
        print(json.dumps({'status': 'error', 'message': str(exc)}), end='')
        sys.exit(1)


def main() -> None:
    api_mode = '--api-mode' in sys.argv
    if api_mode:
        sys.argv.remove('--api-mode')

    setup_logging(api_mode=api_mode)
    create_tables()

    if len(sys.argv) < 2 or sys.argv[1] in ('--help', '-h'):
        print_help()
        sys.exit(0)

    command = sys.argv[1]
    if command != 'execute' or len(sys.argv) != 3:
        print_help()
        sys.exit(1)

    handle_execute(sys.argv[2])


if __name__ == '__main__':
    main()

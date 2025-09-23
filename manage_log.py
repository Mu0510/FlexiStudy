# -*- coding: utf-8 -*-

import sqlite3
import datetime
import os
import sys
import shutil
import json
import uuid
import logging
from zoneinfo import ZoneInfo

# --- 定数 ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(SCRIPT_DIR, 'study_log.db')
LOG_FILE_PATH = os.path.join(SCRIPT_DIR, 'manage_log.log')
BACKUP_DIR = os.path.join(SCRIPT_DIR, 'db_backups')
BACKUP_LOG_PATH = os.path.join(BACKUP_DIR, 'backup_log.txt')
MAX_BACKUPS = 100
LONG_TERM_BACKUP_DIR = os.path.join(SCRIPT_DIR, 'db_long_term_backups')
MAX_LONG_TERM_BACKUPS = 30
REDO_BACKUP_DIR = os.path.join(SCRIPT_DIR, 'db_redo_backups')
MAX_REDO_BACKUPS = 10
JST = ZoneInfo("Asia/Tokyo")

# --- ロギング設定 ---
logger = logging.getLogger(__name__)

def setup_logging(api_mode=False):
    """ロギングを設定する"""
    logger.setLevel(logging.INFO)
    
    # 既存のハンドラをクリア
    if logger.hasHandlers():
        logger.handlers.clear()

    # ファイルハンドラ (常にログファイルに記録)
    file_handler = logging.FileHandler(LOG_FILE_PATH, encoding='utf-8')
    file_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    file_handler.setFormatter(file_formatter)
    logger.addHandler(file_handler)

    # APIモードでない場合のみ、コンソールにも出力
    if not api_mode:
        stream_handler = logging.StreamHandler(sys.stderr)
        stream_formatter = logging.Formatter('%(message)s')
        stream_handler.setFormatter(stream_formatter)
        logger.addHandler(stream_handler)

# --- データベース接続 ---
def get_connection():
    db_dir = os.path.dirname(DB_PATH)
    if not os.path.exists(db_dir):
        os.makedirs(db_dir)
    conn = sqlite3.connect(DB_PATH)
    conn.text_factory = str
    return conn

def print_help():
    """ヘルプメッセージを表示する"""
    help_text = """
Usage: python manage_log.py [--api-mode] execute '<json_payload>'

Gemini CLIのための学習ログ管理ツール。
すべての操作はJSONペイロードを引数とする `execute` コマンド経由で行います。

Options:
  --api-mode    JSON出力以外のコンソールメッセージを抑制します。

--- JSON Payload Structure ---
{
  "action": "group.action_name",
  "params": {
    "key1": "value1",
    "key2": "value2"
  }
}

--- Available Actions ---

[log]
  - log.create: 新しい学習セッションを開始
    - params: {"subject": "str", "content": "str", "memo": "str" (optional), "impression": "str" (optional)}
  - log.break: 現在のセッションを一時停止
    - params: {"break_content": "str" (optional)}
  - log.resume: 一時停止したセッションを再開
    - params: {"memo": "str" (optional), "impression": "str" (optional)}
  - log.end_session: 現在の学習セッションを終了
  - log.get: 指定した日付の全ログをJSONで取得
    - params: {"date": "YYYY-MM-DD"}
  - log.get_entry: 特定のログエントリの詳細を取得
    - params: {"id": int}
  - log.update_entry: ログエントリの特定のフィールドを更新
    - params: {"id": int, "field": "str", "value": "any"}
  - log.update_end_time: ログエントリの終了時刻を更新
    - params: {"id": int, "end_time": "YYYY-MM-DD HH:MM:SS"}
  - log.delete: ログエントリを削除
    - params: {"id": int}

[session]
  - session.merge: 2つの学習セッションを結合
    - params: {"session1_id": int, "session2_id": int}
    - (注) 結合する2つのセッションのサマリーが一致している必要があります。
  - session.active: 現在アクティブな学習セッションがあるかを返す（BREAKは除外）
    - params: {}

[summary]
  - summary.session_update: セッションの概要を追加・更新
    - params: {"text": "str", "session_id": int (optional)}
  - summary.daily_update: 特定の日の概要を追加・更新
    - params: {"text": "str", "date": "YYYY-MM-DD" (optional)}

[goal]
  - goal.daily_update: 特定の日の目標をJSONで一括設定・更新
    - params: {"goal_json": "json_string", "date": "YYYY-MM-DD" (optional)}
  - goal.add_to_date: 特定の日に新しい目標を1つ追加
    - params: {"goal_json": "json_string", "date": "YYYY-MM-DD"}
  - goal.get: IDで指定した目標の詳細を取得
    - params: {"id": "str"}
  - goal.update: IDで指定した目標の特定フィールドを更新
    - params: {"id": "str", "field": "str", "value": "any"}
  - goal.delete: IDで指定した目標を削除
    - params: {"id": "str"}

[data]
  - data.dashboard: Webダッシュボード用のデータを取得
    - params: {"days": int (optional)}
  - data.unique_subjects: 記録されている全ての教科名をリスト表示
  - data.study_time_by_subject: 教科ごとの合計学習時間を取得

[db] (⚠️ 注意/危険)
  - db.backup: 手動でDBバックアップを作成
  - db.undo: 直前のDB操作を取り消し
  - db.redo: 直前の'undo'操作をやり直し
  - db.consolidate_break: 最後のBREAKを直前のRESUMEに統合
  - db.recalculate_durations: 全てのログのdurationを再計算
  - db.restore: ⚠️ 指定したバックアップファイルからDBを復元
    - params: {"backup_path": "str"}
  - db.reconstruct: ⚠️ JSONデータからDBを完全に再構築
    - params: {"json_data": "json_string"}
"""
    print(help_text)

# --- テーブル作成・更新 ---
def create_tables():
    """必要なテーブルをすべて作成する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        # 学習ログテーブル
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS study_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                subject TEXT,
                content TEXT,
                start_time TEXT NOT NULL,
                end_time TEXT,
                duration_minutes INTEGER,
                summary TEXT,
                memo TEXT,
                impression TEXT
            )
        """)
        # 日ごとの概要テーブル
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS daily_summaries (
                date TEXT PRIMARY KEY,
                summary TEXT
            )
        """)
        # goalsテーブル
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS goals (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                task TEXT NOT NULL,
                completed INTEGER NOT NULL,
                subject TEXT,
                total_problems INTEGER,
                completed_problems INTEGER,
                tags TEXT,
                details TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.commit()

def ensure_study_log_columns():
    """study_logsテーブルに必要なカラムが存在しない場合に追加する"""
    optional_columns = {
        'summary': "ALTER TABLE study_logs ADD COLUMN summary TEXT",
        'memo': "ALTER TABLE study_logs ADD COLUMN memo TEXT",
        'impression': "ALTER TABLE study_logs ADD COLUMN impression TEXT"
    }

    try:
        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("PRAGMA table_info(study_logs)")
            existing_columns = {row[1] for row in cursor.fetchall()}

            added_columns = []
            for column_name, alter_sql in optional_columns.items():
                if column_name not in existing_columns:
                    cursor.execute(alter_sql)
                    added_columns.append(column_name)

            if added_columns:
                conn.commit()
                for column_name in added_columns:
                    logger.info("データベースに '{}' カラムを追加しました。".format(column_name))
    except Exception as e:
        logger.error("study_logsテーブルのカラム追加中にエラーが発生しました: {}".format(e))

# --- バックアップ関連 ---
def backup_database(description="Regular backup", backup_type="short_term"):
    if backup_type == "long_term":
        target_dir = LONG_TERM_BACKUP_DIR
    elif backup_type == "redo":
        target_dir = REDO_BACKUP_DIR
    else:
        target_dir = BACKUP_DIR

    if not os.path.exists(target_dir):
        os.makedirs(target_dir)
    timestamp = datetime.datetime.now(JST).strftime("%Y%m%d_%H%M%S_%f")
    backup_filename = "study_log_{}.db".format(timestamp)
    backup_path = os.path.join(target_dir, backup_filename)
    try:
        shutil.copy2(DB_PATH, backup_path)
        logger.info("データベースをバックアップしました: {}".format(backup_path))
        with open(BACKUP_LOG_PATH, "a", encoding="utf-8") as f:
            log_entry = "{}: {}".format(backup_filename, description)
            f.write(log_entry + "\n")
        if backup_type == "long_term":
            manage_long_term_backups()
        elif backup_type == "redo":
            manage_redo_backups()
        else:
            manage_backups()
    except Exception as e:
        logger.error("データベースのバックアップ中にエラーが発生しました: {}".format(e))

def backup_now():
    """手動バックアップを実行する"""
    backup_database("Manual backup")


def manage_backups():
    try:
        backup_files = sorted(
            [os.path.join(BACKUP_DIR, f) for f in os.listdir(BACKUP_DIR) if f.startswith("study_log_") and f.endswith(".db")],
            key=os.path.getmtime
        )
        while len(backup_files) > MAX_BACKUPS:
            os.remove(backup_files.pop(0))
    except Exception as e:
        logger.error("バックアップの管理中にエラーが発生しました: {}".format(e))

def manage_long_term_backups():
    try:
        backup_files = sorted(
            [os.path.join(LONG_TERM_BACKUP_DIR, f) for f in os.listdir(LONG_TERM_BACKUP_DIR) if f.startswith("study_log_") and f.endswith(".db")],
            key=os.path.getmtime
        )
        while len(backup_files) > MAX_LONG_TERM_BACKUPS:
            os.remove(backup_files.pop(0))
    except Exception as e:
        logger.error("長期バックアップの管理中にエラーが発生しました: {}".format(e))

def manage_redo_backups():
    try:
        redo_files = sorted(
            [os.path.join(REDO_BACKUP_DIR, f) for f in os.listdir(REDO_BACKUP_DIR) if f.startswith("study_log_") and f.endswith(".db")],
            key=os.path.getmtime
        )
        while len(redo_files) > MAX_REDO_BACKUPS:
            os.remove(redo_files.pop(0))
    except Exception as e:
        logger.error("Redoバックアップの管理中にエラーが発生しました: {}".format(e))

def restore_database(backup_file_path, description="Restored from backup"):
    """指定されたバックアップファイルからデータベースを復元し、結果を返す"""
    try:
        shutil.copy2(backup_file_path, DB_PATH)
        message = f"データベースを復元しました: {backup_file_path} から"
        with open(BACKUP_LOG_PATH, "a", encoding="utf-8") as f:
            log_entry = f"{os.path.basename(backup_file_path)}: {description}"
            f.write(log_entry + "\n")
        return {"status": "success", "message": message}
    except Exception as e:
        return {"status": "error", "message": f"データベースの復元中にエラーが発生しました: {e}"}

def get_latest_backup_file(directory):
    backup_files = sorted(
        [os.path.join(directory, f) for f in os.listdir(directory) if f.startswith("study_log_") and f.endswith(".db")],
        key=os.path.getmtime,
        reverse=True
    )
    return backup_files[0] if backup_files else None

def move_file(source_path, destination_dir):
    if not os.path.exists(destination_dir):
        os.makedirs(destination_dir)
    shutil.move(source_path, destination_dir)

# --- 学習ログ操作 ---
def get_now():
    return datetime.datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S')

def get_last_active_log_id():
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id FROM study_logs WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1"
        )
        result = cursor.fetchone()
        return result[0] if result else None

def undo_last_operation():
    """直前の操作を取り消し、データベースを一つ前の状態に戻す"""
    latest_backup = get_latest_backup_file(BACKUP_DIR)
    if latest_backup:
        # 現在のDBをredo用に移動
        backup_database("For Redo", backup_type="redo")
        # 最新のバックアップから復元
        restore_database(latest_backup, "Undo operation")
        # 使用したバックアップファイルを削除
        os.remove(latest_backup)
        logger.info("直前の操作を取り消しました。")
    else:
        logger.warning("取り消せる操作がありません。")

def redo_last_undo():
    """undo操作を元に戻す"""
    latest_redo_backup = get_latest_backup_file(REDO_BACKUP_DIR)
    if latest_redo_backup:
        # 現在のDBを通常のバックアップとして保存
        backup_database("For Undo (Redo operation)")
        # redo用バックアップから復元
        restore_database(latest_redo_backup, "Redo operation")
        # 使用したredoバックアップファイルを削除
        os.remove(latest_redo_backup)
        logger.info("直前のundo操作を元に戻しました。")
    else:
        logger.warning("元に戻せるundo操作がありません。")

def get_latest_log_entry():
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM study_logs ORDER BY id DESC LIMIT 1")
        return cursor.fetchone()

def get_second_latest_log_entry():
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM study_logs ORDER BY id DESC LIMIT 1 OFFSET 1")
        return cursor.fetchone()

def consolidate_last_break_into_resume():
    backup_database("Before consolidating last BREAK into RESUME.")
    latest_log = get_latest_log_entry()
    second_latest_log = get_second_latest_log_entry()

    if not latest_log or not second_latest_log:
        logger.error("エラー: ログエントリが不足しています。")
        return

    if latest_log['event_type'] == 'BREAK' and second_latest_log['event_type'] == 'RESUME':
        with get_connection() as conn:
            cursor = conn.cursor()
            # RESUMEのcontentにBREAKのcontentを追記
            new_content = second_latest_log['content']
            if latest_log['content']:
                if new_content:
                    new_content += " " + latest_log['content']
                else:
                    new_content = latest_log['content']
            
            # RESUMEのend_timeをBREAKのend_timeに更新
            new_end_time = latest_log['end_time']

            cursor.execute(
                "UPDATE study_logs SET content = ?, end_time = ? WHERE id = ?",
                (new_content, new_end_time, second_latest_log['id'])
            )
            # BREAKイベントを削除
            cursor.execute("DELETE FROM study_logs WHERE id = ?", (latest_log['id'],))
            conn.commit()
        logger.info("最後のBREAKイベントを直前のRESUMEイベントに統合しました。")
    else:
        logger.error("エラー: 最後のイベントがBREAK、その前のイベントがRESUMEではありません。")

def update_end_time(log_id, end_time):
    """指定されたログIDの終了時刻を更新し、結果を返す"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT start_time FROM study_logs WHERE id = ?", (log_id,))
        start_time_result = cursor.fetchone()
        if not start_time_result:
            return {"status": "error", "message": f"ログID {log_id} が見つかりません。"}
        start_time_str = start_time_result[0]
        
        start_time = datetime.datetime.strptime(start_time_str, '%Y-%m-%d %H:%M:%S')
        end_time_dt = datetime.datetime.strptime(end_time, '%Y-%m-%d %H:%M:%S')
        
        duration = end_time_dt - start_time
        duration_minutes = int(duration.total_seconds() / 60)
        
        cursor.execute(
            "UPDATE study_logs SET end_time = ?, duration_minutes = ? WHERE id = ?",
            (end_time, duration_minutes, log_id)
        )
        conn.commit()
        return {"status": "success", "message": f"ログID {log_id} の終了時刻を更新しました。"}

def get_goal_by_id_global(goal_id):
    """指定されたIDの目標を取得し、結果を返す"""
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM goals WHERE id = ?", (goal_id,))
        goal = cursor.fetchone()
        if goal:
            return {"status": "success", "goal": dict(goal)}
        else:
            return {"status": "error", "message": f"目標ID {goal_id} が見つかりません。"}

def update_goal_by_id_global(goal_id, field, value):
    """指定されたIDの目標の特定のフィールドを更新し、結果を返す"""
    backup_database("Before updating goal by global ID.")
    with get_connection() as conn:
        cursor = conn.cursor()
        
        cursor.execute("SELECT id FROM goals WHERE id = ?", (goal_id,))
        if cursor.fetchone() is None:
            return {"status": "error", "message": f"目標ID {goal_id} が見つかりません。"}

        set_clause = ""
        param_value = value

        if field == "completed":
            param_value = 1 if str(value).lower() in ("true", "1") else 0
            set_clause = "completed = ?"
        elif field in ["total_problems", "completed_problems"]:
            try:
                param_value = int(value)
                set_clause = f"{field} = ?"
            except ValueError:
                return {"status": "error", "message": f"{field} は整数である必要があります。"}
        elif field == "tags":
            try:
                json.loads(value)
                param_value = value
                set_clause = "tags = ?"
            except json.JSONDecodeError:
                return {"status": "error", "message": "tags は有効なJSON文字列である必要があります。"}
        elif field in ["details", "task", "subject"]:
            param_value = value
            set_clause = f"{field} = ?"
        else:
            return {"status": "error", "message": f"無効なフィールド名 '{field}' です。"}

        now = datetime.datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S')
        query = f"UPDATE goals SET {set_clause}, updated_at = ? WHERE id = ?"
        params = (param_value, now, goal_id)
        cursor.execute(query, params)
        conn.commit()
        return {"status": "success", "message": f"目標ID {goal_id} の {field} を更新しました。"}

def delete_goal_by_id_global(goal_id):
    """指定されたIDの目標を削除し、結果を返す"""
    backup_database("Before deleting goal by global ID.")
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
        if cursor.rowcount > 0:
            conn.commit()
            return {"status": "success", "message": f"目標ID {goal_id} を削除しました。"}
        else:
            return {"status": "error", "message": f"目標ID {goal_id} が見つかりません。"}

def update_log_entry(log_id, **kwargs):
    """ログエントリの特定のフィールドを更新し、結果を返す"""
    backup_database("Before updating log entry.")
    with get_connection() as conn:
        cursor = conn.cursor()
        set_clauses = []
        params = []
        for key, value in kwargs.items():
            if key in ["memo", "impression", "content", "subject", "summary", "event_type", "start_time", "end_time", "duration_minutes"]:
                set_clauses.append(f"{key} = ?")
                params.append(value)
            else:
                return {"status": "error", "message": f"無効なフィールド名 '{key}' です。"}
        
        if not set_clauses:
            return {"status": "error", "message": "更新するフィールドが指定されていません。"}

        params.append(log_id)
        query = "UPDATE study_logs SET {} WHERE id = ?".format(", ".join(set_clauses))
        cursor.execute(query, tuple(params))
        conn.commit()
        return {"status": "success", "message": f"ログID {log_id} を更新しました。"}

def get_log_entry_by_id(log_id):
    """指定されたIDのログエントリを取得し、結果を返す"""
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM study_logs WHERE id = ?", (log_id,))
        log_entry = cursor.fetchone()
        if log_entry:
            return {"status": "success", "entry": dict(log_entry)}
        else:
            return {"status": "error", "message": f"ログID {log_id} が見つかりません。"}

def start_session(subject, content, memo=None, impression=None):
    if not is_today_log_exists():
        backup_database("Daily auto backup before first study session.", backup_type="long_term")
    backup_database("Before start session.")
    now = get_now()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO study_logs (event_type, subject, content, start_time, memo, impression) VALUES (?, ?, ?, ?, ?, ?)",
            ('START', subject, content, now, memo, impression)
        )
    logger.info("学習を開始しました: {} - {}".format(subject, content))

def end_session():
    backup_database("Before ending session.")
    last_active_id = get_last_active_log_id()
    if last_active_id:
        now = get_now()
        update_end_time(last_active_id, now)
        logger.info("学習セッションを終了しました。")
    else:
        logger.error("エラー: 開始中のセッションがありません。")

def break_session(break_content=None):
    """現在のセッションを一時停止し、BREAKイベントを記録する。"""
    backup_database("Before break session.")
    last_active_id = get_last_active_log_id()

    if not last_active_id:
        logger.error("エラー: 開始中のセッションがありません。")
        return {"status": "error", "message": "エラー: 開始中のセッションがありません。"}

    try:
        now = get_now()
        # 進行中のセッションを終了させる
        update_end_time(last_active_id, now)

        # 新しいBREAKイベントを記録
        with get_connection() as conn:
            conn.execute(
                "INSERT INTO study_logs (event_type, content, start_time) VALUES (?, ?, ?)",
                ('BREAK', break_content, now)
            )
        
        logger.info(f"学習を休憩しました。")
        return {"status": "success", "message": "学習を休憩しました。"}

    except Exception as e:
        logger.error(f"休憩処理中にエラーが発生しました: {e}", exc_info=True)
        return {"status": "error", "message": f"処理中にエラーが発生しました: {e}"}

def merge_sessions(session1_id, session2_id):
    """2つの学習セッションを結合する"""
    backup_database("Before merging sessions.")
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # セッション1と2のSTARTログを取得
        cursor.execute("SELECT * FROM study_logs WHERE id = ? AND event_type = 'START'", (session1_id,))
        session1_start = cursor.fetchone()
        cursor.execute("SELECT * FROM study_logs WHERE id = ? AND event_type = 'START'", (session2_id,))
        session2_start = cursor.fetchone()

        if not session1_start or not session2_start:
            return {"status": "error", "message": "指定されたIDのSTARTログが見つかりません。"}

        # サマリーの一致を確認
        if session1_start['summary'] != session2_start['summary']:
            return {"status": "error", "message": "セッションサマリーが一致しません。まず手動で内容を統一してください。"}

        # セッション1の最後のログを取得
        cursor.execute("SELECT * FROM study_logs WHERE id >= ? and id < ? ORDER BY start_time DESC, id DESC LIMIT 1", (session1_id, session2_id))
        session1_last_log = cursor.fetchone()

        if not session1_last_log or not session1_last_log['end_time']:
            return {"status": "error", "message": "セッション1の終了時刻が見つかりません。"}

        break_start_time = session1_last_log['end_time']
        break_end_time = session2_start['start_time']

        # BREAKイベントを挿入
        cursor.execute(
            "INSERT INTO study_logs (event_type, subject, content, start_time, end_time) VALUES (?, ?, ?, ?, ?)",
            ('BREAK', session1_start['subject'], 'セッション結合による自動挿入', break_start_time, break_end_time)
        )

        # セッション2のSTARTをRESUMEに更新
        cursor.execute(
            "UPDATE study_logs SET event_type = ?, summary = NULL WHERE id = ?",
            ('RESUME', session2_id)
        )

        conn.commit()
        return {"status": "success", "message": f"セッション {session1_id} と {session2_id} を結合しました。"}

def resume_session(memo=None, impression=None):
    backup_database("Before resume session.")
    last_active_id = get_last_active_log_id()
    if last_active_id:
        now = get_now()
        update_end_time(last_active_id, now)
        with get_connection() as conn:
            # 最後のSTARTイベントのsubjectとcontentを取得
            cursor = conn.cursor()
            cursor.execute(
                "SELECT subject, content FROM study_logs WHERE event_type = 'START' ORDER BY start_time DESC LIMIT 1"
            )
            result = cursor.fetchone()
            subject = result[0] if result else None
            # RESUMEイベントのcontentは、STARTイベントのcontentをそのまま引き継ぐ
            actual_content = result[1] if result else None

            conn.execute(
                "INSERT INTO study_logs (event_type, subject, content, start_time, memo, impression) VALUES (?, ?, ?, ?, ?, ?)",
                ('RESUME', subject, actual_content, now, memo, impression)
            )
        logger.info("学習を再開しました。")
    else:
        logger.error("エラー: 休憩中のセッションがありません。")

def add_or_update_daily_summary(summary_text, date_str=None):
    """日ごとの概要を追加または更新し、結果を返す"""
    backup_database("Before daily summary update.")
    if not date_str:
        date_str = datetime.date.today().strftime('%Y-%m-%d')
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT date FROM daily_summaries WHERE date = ?", (date_str,))
        if cursor.fetchone():
            cursor.execute(
                "UPDATE daily_summaries SET summary = ? WHERE date = ?",
                (summary_text, date_str)
            )
            message = f"日付 {date_str} の概要を更新しました。"
        else:
            cursor.execute(
                "INSERT INTO daily_summaries (date, summary) VALUES (?, ?)",
                (date_str, summary_text)
            )
            message = f"日付 {date_str} の概要を新規作成しました。"
        conn.commit()
    return {"status": "success", "message": message}

def add_or_update_daily_goal(goal_json_str, date_str=None):
    """日ごとの目標を追加または更新し、結果を返す"""
    backup_database("Before daily goal update.")
    if not date_str:
        date_str = datetime.date.today().strftime('%Y-%m-%d')
    try:
        goals_data = json.loads(goal_json_str)
        if not isinstance(goals_data, list):
            raise ValueError("Goal data must be a JSON array.")
        
        with get_connection() as conn:
            cursor = conn.cursor()
            for goal_entry in goals_data:
                # 必須フィールドのチェック
                if not all(k in goal_entry for k in ["task", "completed", "subject"]):
                    raise ValueError("Each goal entry must contain 'task', 'completed', 'subject'.")
                
                # idの生成または保持
                if "id" not in goal_entry or not goal_entry["id"]:
                    goal_entry["id"] = str(uuid.uuid4())
                
                # problemsの型チェックとデフォルト値
                if "total_problems" in goal_entry and goal_entry["total_problems"] is not None:
                    if not isinstance(goal_entry["total_problems"], (int, type(None))):
                        raise ValueError("total_problems must be an integer or null.")
                else:
                    goal_entry["total_problems"] = None

                if "completed_problems" in goal_entry and goal_entry["completed_problems"] is not None:
                    if not isinstance(goal_entry["completed_problems"], (int, type(None))):
                        raise ValueError("completed_problems must be an integer or null.")
                else:
                    goal_entry["completed_problems"] = None

                # tagsの型チェックとデフォルト値
                if "tags" in goal_entry and not isinstance(goal_entry["tags"], list):
                    raise ValueError("Tags must be a list.")
                elif "tags" not in goal_entry:
                    goal_entry["tags"] = []

                # detailsのデフォルト値
                if "details" not in goal_entry:
                    goal_entry["details"] = None

                # created_at, updated_atの自動設定
                now = datetime.datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S')
                if "created_at" not in goal_entry or not goal_entry["created_at"]:
                    goal_entry["created_at"] = now
                goal_entry["updated_at"] = now

                # goalsテーブルに挿入または更新
                sql = """
                    INSERT OR REPLACE INTO goals (id, date, task, completed, subject, total_problems, completed_problems, tags, details, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """
                params = (
                    goal_entry["id"], date_str, goal_entry["task"], 1 if goal_entry["completed"] else 0,
                    goal_entry["subject"], goal_entry["total_problems"], goal_entry["completed_problems"],
                    json.dumps(goal_entry["tags"], ensure_ascii=False), goal_entry["details"],
                    goal_entry["created_at"], goal_entry["updated_at"]
                )
                cursor.execute(sql, params)
            conn.commit()
        return {"status": "success", "message": f"日付 {date_str} の目標を更新しました。"}

    except json.JSONDecodeError as e:
        return {"status": "error", "message": f"目標は有効なJSON形式である必要があります。{e}"}
    except ValueError as ve:
        return {"status": "error", "message": f"目標データの構造が不正です。{ve}"}
    except Exception as e:
        return {"status": "error", "message": f"目標の更新中に予期せぬエラーが発生しました。{e}"}

def add_goal_to_date(goal_json_str, date_str):
    """指定された日付に新しい目標を1つ追加し、結果を返す"""
    backup_database("Before adding a goal to a specific date.")
    try:
        new_goal = json.loads(goal_json_str)
        # 新しい目標のIDを再生成し、未完了状態にする
        new_goal['id'] = str(uuid.uuid4())
        new_goal['completed'] = False
        # total_problemsとcompleted_problemsのデフォルト値を設定
        if 'total_problems' not in new_goal or new_goal['total_problems'] is None:
            new_goal['total_problems'] = None
        else:
            try:
                new_goal['total_problems'] = int(new_goal['total_problems'])
            except (ValueError, TypeError):
                new_goal['total_problems'] = None

        if 'completed_problems' not in new_goal or new_goal['completed_problems'] is None:
            if new_goal.get('total_problems') is not None:
                new_goal['completed_problems'] = 0
            else:
                new_goal['completed_problems'] = None
        now = datetime.datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S')
        new_goal['created_at'] = now
        new_goal['updated_at'] = now

        # 必須フィールドのチェック
        if not all(k in new_goal for k in ["task", "completed", "subject"]):
            raise ValueError("Each goal entry must contain 'task', 'completed', 'subject'.")

        # tagsの型チェックとデフォルト値
        if "tags" in new_goal and not isinstance(new_goal["tags"], list):
            raise ValueError("Tags must be a list.")
        elif "tags" not in new_goal:
            new_goal["tags"] = []

        # detailsのデフォルト値
        if "details" not in new_goal:
            new_goal["details"] = None

        with get_connection() as conn:
            cursor = conn.cursor()
            sql = """
                INSERT INTO goals (id, date, task, completed, subject, total_problems, completed_problems, tags, details, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """
            params = (
                new_goal["id"], date_str, new_goal["task"], 1 if new_goal["completed"] else 0,
                new_goal["subject"], new_goal["total_problems"], new_goal["completed_problems"],
                json.dumps(new_goal["tags"], ensure_ascii=False), new_goal["details"],
                new_goal["created_at"], new_goal["updated_at"]
            )
            cursor.execute(sql, params)
            conn.commit()

        return {"status": "success", "message": f"日付 {date_str} に目標「{new_goal.get('task', '')}」を追加しました。"}

    except json.JSONDecodeError as e:
        return {"status": "error", "message": f"追加する目標データが有効なJSON形式ではありません。{e}"}
    except ValueError as ve:
        return {"status": "error", "message": f"目標データの構造が不正です。{ve}"}
    except Exception as e:
        return {"status": "error", "message": f"目標データの処理中にエラーが発生しました。{e}"}

def add_or_update_session_summary(summary_text, session_id=None):
    """セッションの概要を追加または更新する"""
    backup_database("Before session summary update.")
    with get_connection() as conn:
        cursor = conn.cursor()
        target_id = session_id
        if not target_id:
            cursor.execute("SELECT MAX(id) FROM study_logs WHERE event_type = 'START'")
            result = cursor.fetchone()
            if result: target_id = result[0]
        
        if not target_id:
            logger.error("エラー: 対象セッションが見つかりません。")
            return

        cursor.execute("UPDATE study_logs SET summary = ? WHERE id = ?", (summary_text, target_id))
        if cursor.rowcount > 0:
            logger.info("セッションID {} の概要を更新しました。".format(target_id))
        else:
            logger.error("エラー: セッションID {} が見つかりません。".format(target_id))

# --- ログ表示・計算 ---
def get_chat_messages(limit=5, before_id=None):
    """チャットメッセージを取得する（ページング対応）"""
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        query = """
            SELECT id, event_type, subject, content, start_time, end_time, summary
            FROM study_logs
            WHERE event_type IN ('START', 'RESUME', 'BREAK')
        """
        params = []
        if before_id:
            query += " AND id < ?"
            params.append(before_id)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        cursor.execute(query, tuple(params))
        messages = cursor.fetchall()
        return [dict(m) for m in messages]

def get_logs_json_for_date(date_str):
    """指定された日付のログと概要をJSONで返す"""
    output_data = {
        "daily_summary": {
            "date": date_str,
            "summary": None,
            "goals": [],
            "total_duration": 0,
            "subjects": []
        },
        "total_day_study_minutes": 0,
        "subjects_studied": [],
        "sessions": [],
        "all_entries": []
    }
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute("SELECT summary FROM daily_summaries WHERE date = ?", (date_str,))
        daily_row = cursor.fetchone()
        if daily_row:
            output_data["daily_summary"]["summary"] = daily_row["summary"]

        # goalsテーブルから目標を取得
        cursor.execute("SELECT * FROM goals WHERE date = ? ORDER BY created_at", (date_str,))
        goals_raw = cursor.fetchall()
        goals_list = []
        for goal_row in goals_raw:
            goal_dict = dict(goal_row)
            # tagsはJSON文字列として保存されているのでパースする
            if goal_dict['tags']:
                try:
                    goal_dict['tags'] = json.loads(goal_dict['tags'])
                except json.JSONDecodeError:
                    goal_dict['tags'] = []
            goals_list.append(goal_dict)
        output_data["daily_summary"]["goals"] = goals_list

        cursor.execute("""
            SELECT id, event_type, subject, content, start_time, end_time, duration_minutes, summary, memo, impression
            FROM study_logs WHERE DATE(start_time) = ? ORDER BY start_time
        """, (date_str,))
        logs = cursor.fetchall()

    if logs:
        output_data["all_entries"] = [dict(log) for log in logs]
        current_session = None
        for log in logs:
            log_dict = dict(log)
            if log_dict["event_type"] == 'START':
                if current_session: output_data["sessions"].append(current_session)
                current_session = {
                    "session_id": log_dict["id"], "subject": log_dict["subject"],
                    "summary": log_dict["summary"], "session_start_time": "",
                    "session_end_time": "", "total_study_minutes": 0, "details": []
                }
            if current_session:
                start_dt = datetime.datetime.strptime(log_dict["start_time"], "%Y-%m-%d %H:%M:%S")
                end_dt = datetime.datetime.strptime(log_dict["end_time"], "%Y-%m-%d %H:%M:%S") if log_dict["end_time"] else start_dt
                duration_minutes = int((end_dt - start_dt).total_seconds() / 60)
                if log_dict["event_type"] in ('START', 'RESUME'):
                    current_session["total_study_minutes"] += duration_minutes
                detail_entry = {
                    "id": log_dict["id"],
                    "event_type": log_dict["event_type"], "content": log_dict["content"],
                    "start_time": start_dt.strftime("%H:%M"),
                    "end_time": end_dt.strftime(" %H:%M") if log_dict["end_time"] else "",
                    "duration_minutes": duration_minutes
                }
                if log_dict["memo"] is not None and log_dict["memo"] != '':
                    detail_entry["memo"] = log_dict["memo"]
                if log_dict["impression"] is not None and log_dict["impression"] != '':
                    detail_entry["impression"] = log_dict["impression"]
                current_session["details"].append(detail_entry)
                if not current_session["session_start_time"]:
                     current_session["session_start_time"] = start_dt.strftime("%H:%M")
                current_session["session_end_time"] = end_dt.strftime(" %H:%M") if log_dict["end_time"] else start_dt.strftime(" %H:%M")
        if current_session: output_data["sessions"].append(current_session)

    # セッション情報から日次サマリー情報を計算
    if output_data["sessions"]:
        total_minutes = sum(s['total_study_minutes'] for s in output_data['sessions'])
        subjects = sorted(list(set(s['subject'] for s in output_data['sessions'])))
        output_data['total_day_study_minutes'] = total_minutes
        output_data['subjects_studied'] = subjects
        output_data['daily_summary']['total_duration'] = total_minutes
        output_data['daily_summary']['subjects'] = subjects

    return output_data

def get_all_unique_subjects():
    """すべての学習ログからユニークな教科のリストを取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT DISTINCT subject FROM study_logs WHERE subject IS NOT NULL AND subject != '' ORDER BY subject")
        subjects = [row[0] for row in cursor.fetchall()]
        return subjects

def get_study_time_by_subject():
    """教科ごとの合計学習時間を取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT subject, SUM(duration_minutes) as total_minutes
            FROM study_logs
            WHERE event_type IN ('START', 'RESUME') AND subject IS NOT NULL AND duration_minutes IS NOT NULL
            GROUP BY subject
            HAVING SUM(duration_minutes) > 0
            ORDER BY total_minutes DESC
        """)
        data = cursor.fetchall()
        return [{"subject": row[0], "minutes": row[1]} for row in data]

def get_weekly_study_time():
    """過去7日間の日ごとの合計学習時間を取得する"""
    today = datetime.date.today()
    data = []
    with get_connection() as conn:
        cursor = conn.cursor()
        for i in range(7):
            day = today - datetime.timedelta(days=i)
            day_str = day.strftime('%Y-%m-%d')
            # JSTに変換してから曜日を取得
            day_name_en = day.strftime('%a')
            day_map = {'Sun': '日', 'Mon': '月', 'Tue': '火', 'Wed': '水', 'Thu': '木', 'Fri': '金', 'Sat': '土'}
            day_name_ja = day_map.get(day_name_en, '')

            cursor.execute(
                "SELECT SUM(duration_minutes) FROM study_logs WHERE DATE(start_time) = ? AND event_type IN ('START', 'RESUME')",
                (day_str,)
            )
            total_minutes = cursor.fetchone()[0] or 0
            data.append({"day": day_name_ja, "time": total_minutes})
    return data[::-1] # 曜日順に並べるため逆順にする

# ---- Event tracking for fine-grained UI diffs ----
def ensure_event_triggers():
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              table_name TEXT,
              op TEXT,
              row_id INTEGER,
              snapshot TEXT,
              ts TEXT DEFAULT (datetime('now'))
            )
        """)

        # study_logs triggers: only recreate if 'summary' is missing
        def trigger_has_summary(name: str) -> bool:
            try:
                cursor.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", (name,))
                row = cursor.fetchone()
                if not row or not row[0]:
                    return False
                return 'summary' in row[0]
            except Exception:
                return False

        for trig_name in (
            'trg_study_logs_insert',
            'trg_study_logs_update',
            'trg_study_logs_delete',
        ):
            if not trigger_has_summary(trig_name):
                try:
                    cursor.execute(f"DROP TRIGGER IF EXISTS {trig_name}")
                except Exception:
                    pass
        cursor.executescript("""
            CREATE TRIGGER IF NOT EXISTS trg_study_logs_insert AFTER INSERT ON study_logs BEGIN
              INSERT INTO events(table_name,op,row_id,snapshot)
              VALUES('study_logs','insert',NEW.id,
                json_object('id',NEW.id,'event_type',NEW.event_type,'subject',NEW.subject,'content',NEW.content,'start_time',NEW.start_time,'end_time',NEW.end_time,'duration_minutes',NEW.duration_minutes,'summary',NEW.summary));
            END;
            CREATE TRIGGER IF NOT EXISTS trg_study_logs_update AFTER UPDATE ON study_logs BEGIN
              INSERT INTO events(table_name,op,row_id,snapshot)
              VALUES('study_logs','update',NEW.id,
                json_object('id',NEW.id,'event_type',NEW.event_type,'subject',NEW.subject,'content',NEW.content,'start_time',NEW.start_time,'end_time',NEW.end_time,'duration_minutes',NEW.duration_minutes,'summary',NEW.summary));
            END;
            CREATE TRIGGER IF NOT EXISTS trg_study_logs_delete AFTER DELETE ON study_logs BEGIN
              INSERT INTO events(table_name,op,row_id,snapshot)
              VALUES('study_logs','delete',OLD.id,
                json_object('id',OLD.id,'event_type',OLD.event_type,'subject',OLD.subject,'content',OLD.content,'start_time',OLD.start_time,'end_time',OLD.end_time,'duration_minutes',OLD.duration_minutes,'summary',OLD.summary));
            END;
        """)
        # goals triggers
        cursor.executescript("""
            CREATE TRIGGER IF NOT EXISTS trg_goals_insert AFTER INSERT ON goals BEGIN
              INSERT INTO events(table_name,op,row_id,snapshot)
              VALUES('goals','insert',NEW.id,
                json_object('id',NEW.id,'date',NEW.date,'task',NEW.task,'completed',NEW.completed,'subject',NEW.subject,'total_problems',NEW.total_problems,'completed_problems',NEW.completed_problems,'tags',NEW.tags,'details',NEW.details));
            END;
            CREATE TRIGGER IF NOT EXISTS trg_goals_update AFTER UPDATE ON goals BEGIN
              INSERT INTO events(table_name,op,row_id,snapshot)
              VALUES('goals','update',NEW.id,
                json_object('id',NEW.id,'date',NEW.date,'task',NEW.task,'completed',NEW.completed,'subject',NEW.subject,'total_problems',NEW.total_problems,'completed_problems',NEW.completed_problems,'tags',NEW.tags,'details',NEW.details));
            END;
            CREATE TRIGGER IF NOT EXISTS trg_goals_delete AFTER DELETE ON goals BEGIN
              INSERT INTO events(table_name,op,row_id,snapshot)
              VALUES('goals','delete',OLD.id,
                json_object('id',OLD.id,'date',OLD.date,'task',OLD.task,'completed',OLD.completed,'subject',OLD.subject,'total_problems',OLD.total_problems,'completed_problems',OLD.completed_problems,'tags',OLD.tags,'details',OLD.details));
            END;
            -- daily_summaries triggers
            CREATE TRIGGER IF NOT EXISTS trg_daily_summaries_insert AFTER INSERT ON daily_summaries BEGIN
              INSERT INTO events(table_name,op,row_id,snapshot)
              VALUES('daily_summaries','insert',0,
                json_object('date',NEW.date,'summary',NEW.summary));
            END;
            CREATE TRIGGER IF NOT EXISTS trg_daily_summaries_update AFTER UPDATE ON daily_summaries BEGIN
              INSERT INTO events(table_name,op,row_id,snapshot)
              VALUES('daily_summaries','update',0,
                json_object('date',NEW.date,'summary',NEW.summary));
            END;
            CREATE TRIGGER IF NOT EXISTS trg_daily_summaries_delete AFTER DELETE ON daily_summaries BEGIN
              INSERT INTO events(table_name,op,row_id,snapshot)
              VALUES('daily_summaries','delete',0,
                json_object('date',OLD.date,'summary',OLD.summary));
            END;
        """)

def action_data_events_since(params):
    since = int((params or {}).get('since', 0))
    limit = int((params or {}).get('limit', 100))
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?", (since, limit))
        rows = [dict(r) for r in cur.fetchall()]
        return { 'events': rows, 'last': rows[-1]['id'] if rows else since }

# Ensure event triggers are present at import time
try:
    ensure_event_triggers()
except Exception as _e:
    pass

def get_dashboard_data(weekly_period_days=None):
    """ダッシュボード用のデータを取得して返す"""
    today = datetime.date.today()
    today_str = today.strftime('%Y-%m-%d')
    
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # 今日の学習時間
        cursor.execute(
            "SELECT SUM(duration_minutes) FROM study_logs WHERE DATE(start_time) = ? AND event_type IN ('START', 'RESUME')",
            (today_str,)
        )
        today_time = cursor.fetchone()[0] or 0

        # 週の学習時間
        if weekly_period_days:
            start_of_period = today - datetime.timedelta(days=int(weekly_period_days) - 1)
            weekly_time_query = "SELECT SUM(duration_minutes) FROM study_logs WHERE DATE(start_time) >= ? AND event_type IN ('START', 'RESUME')"
            params = (start_of_period.strftime('%Y-%m-%d'),)
        else: # デフォルトは月曜始まりの週
            start_of_week = today - datetime.timedelta(days=today.weekday())
            weekly_time_query = "SELECT SUM(duration_minutes) FROM study_logs WHERE DATE(start_time) >= ? AND event_type IN ('START', 'RESUME')"
            params = (start_of_week.strftime('%Y-%m-%d'),)
        
        cursor.execute(weekly_time_query, params)
        weekly_time = cursor.fetchone()[0] or 0

        # 今月の学習時間
        start_of_month = today.replace(day=1)
        cursor.execute(
            "SELECT SUM(duration_minutes) FROM study_logs WHERE DATE(start_time) >= ? AND event_type IN ('START', 'RESUME')",
            (start_of_month.strftime('%Y-%m-%d'),)
        )
        monthly_time = cursor.fetchone()[0] or 0

        # 目標達成率 (1日平均6時間)
        start_of_week_for_rate = today - datetime.timedelta(days=today.weekday())
        days_in_week = (today - start_of_week_for_rate).days + 1
        avg_daily_minutes = weekly_time / days_in_week if days_in_week > 0 else 0
        daily_goal_minutes = 6 * 60
        goal_achievement_rate = (avg_daily_minutes / daily_goal_minutes) * 100 if daily_goal_minutes > 0 else 0

        # 連続学習日数
        cursor.execute("SELECT DISTINCT DATE(start_time) FROM study_logs ORDER BY DATE(start_time) DESC")
        dates = [datetime.datetime.strptime(row[0], '%Y-%m-%d').date() for row in cursor.fetchall()]
        streak = 0
        if dates:
            current_date = today
            if current_date in dates:
                streak = 1
                while (current_date - datetime.timedelta(days=1)) in dates:
                    streak += 1
                    current_date -= datetime.timedelta(days=1)

        # 今日の目標
        cursor.execute("SELECT * FROM goals WHERE date = ?", (today_str,))
        today_goals_raw = cursor.fetchall()
        today_goals = []
        completed_goals = 0
        total_goals = len(today_goals_raw)
        for goal_row in today_goals_raw:
            goal_dict = dict(goal_row)
            if goal_dict['tags']:
                try:
                    goal_dict['tags'] = json.loads(goal_dict['tags'])
                except json.JSONDecodeError:
                    goal_dict['tags'] = []
            today_goals.append(goal_dict)
            if (goal_dict.get('completed', False) or 
               (goal_dict.get('total_problems') is not None and 
                goal_dict.get('completed_problems') is not None and 
                goal_dict['total_problems'] > 0 and 
                goal_dict['completed_problems'] >= goal_dict['total_problems'])):
                completed_goals += 1

        # 最近の学習セッション (直近2件)
        cursor.execute("""
            SELECT subject, content, start_time, end_time, duration_minutes
            FROM study_logs 
            WHERE event_type IN ('START', 'RESUME')
            ORDER BY start_time DESC 
            LIMIT 2
        """ )
        recent_sessions_raw = cursor.fetchall()
        recent_sessions = []
        for row in recent_sessions_raw:
            start_time = datetime.datetime.strptime(row['start_time'], '%Y-%m-%d %H:%M:%S')
            end_time = datetime.datetime.strptime(row['end_time'], '%Y-%m-%d %H:%M:%S') if row['end_time'] else start_time
            # 相対日付ラベル（今日/昨日/◯日前）
            days_ago = (today - start_time.date()).days
            if days_ago == 0:
                relative = "今日"
            elif days_ago == 1:
                relative = "昨日"
            else:
                relative = f"{days_ago}日前"

            recent_sessions.append({
                'subject': row['subject'],
                'duration': row['duration_minutes'],
                'time': "{}-{}".format(start_time.strftime('%H:%M'), end_time.strftime('%H:%M')),
                'topic': row['content'],
                'date': start_time.strftime('%Y-%m-%d'),
                'relative': relative,
            })

    dashboard_data = {
        "studyStats": {
            "todayTime": today_time,
            "weeklyTime": weekly_time,
            "monthlyTime": monthly_time,
            "streak": streak,
            "goalAchievementRate": goal_achievement_rate,
            "completedGoals": completed_goals,
            "totalGoals": total_goals
        },
        "todayGoals": today_goals,
        "recentSessions": recent_sessions
    }
    
    return dashboard_data

def recalculate_all_durations():
    """すべてのログのduration_minutesを再計算する"""
    backup_database("Before recalculating all durations.")
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, start_time, end_time FROM study_logs WHERE end_time IS NOT NULL")
        logs = cursor.fetchall()
        
        for log_id, start_time_str, end_time_str in logs:
            try:
                start_time = datetime.datetime.strptime(start_time_str, '%Y-%m-%d %H:%M:%S')
                end_time = datetime.datetime.strptime(end_time_str, '%Y-%m-%d %H:%M:%S')
                duration = end_time - start_time
                duration_minutes = int(duration.total_seconds() / 60)
                
                conn.execute(
                    "UPDATE study_logs SET duration_minutes = ? WHERE id = ?",
                    (duration_minutes, log_id)
                )
            except (ValueError, TypeError) as e:
                logger.error("Could not process log ID {}: {}".format(log_id, e))
        conn.commit()
    logger.info("すべてのログの学習時間を再計算しました。")


# --- タグ抽出・検索（新規） ---
import re
import unicodedata

# 半角/全角シャープの両方を許可
HASHTAG_RE = re.compile(r"[#＃]([\w\u0080-\uFFFF\-]+)")

def _extract_hashtags_from_text(text):
    if not text:
        return []
    return [m.group(1) for m in HASHTAG_RE.finditer(text)]

def _make_preview(*fields, max_len=80):
    for f in fields:
        if f and isinstance(f, str):
            s = f.strip()
            if s:
                return (s[:max_len] + ("…" if len(s) > max_len else ""))
    return ""

# --- 検索スニペット生成（改良） ---
def _norm(s: str) -> str:
    if not s:
        return ""
    try:
        return unicodedata.normalize('NFKC', s).lower()
    except Exception:
        return s.lower() if isinstance(s, str) else ""

def _first_match_index(text: str, terms_norm):
    """正規化テキストで最初に見つかる語のインデックスを返す（なければ-1）。"""
    if not text:
        return -1
    hay = _norm(text)
    best = -1
    for t in terms_norm:
        if not t:
            continue
        idx = hay.find(t)
        if idx != -1:
            if best == -1 or idx < best:
                best = idx
    return best

def _make_centered_snippet(text: str, match_idx: int, match_len: int, max_len: int = 80) -> str:
    if not text:
        return ""
    if match_idx < 0 or match_idx >= len(text):
        # フォールバック：先頭から
        return text[:max_len] + ("…" if len(text) > max_len else "")
    # マッチ中心で切り出し
    half = max_len // 2
    start = max(0, match_idx - half)
    end = min(len(text), match_idx + match_len + half)
    snippet = text[start:end]
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet

def get_all_tags(prefix=None, limit=None):
    """goals.tags と各テキストフィールドからハッシュタグを集計して返す。
    返却: {"tags": [{"name": str, "source": "goal"|"entry"|"summary", "count": int} ...]}
    """
    prefix = (prefix or "").strip()
    try:
        limit_val = int(limit) if (limit is not None and str(limit).isdigit()) else None
    except Exception:
        limit_val = None

    counts = {}
    sources = {}

    with get_connection() as conn:
        cursor = conn.cursor()
        # goals.tags（JSON配列）
        cursor.execute("SELECT tags FROM goals WHERE tags IS NOT NULL AND tags != ''")
        for (tags_json,) in cursor.fetchall():
            try:
                arr = json.loads(tags_json)
                if isinstance(arr, list):
                    for t in arr:
                        name = str(t).strip()
                        if not name:
                            continue
                        counts[name] = counts.get(name, 0) + 1
                        sources[name] = 'goal'
            except Exception:
                continue

        # study_logs の text フィールドから #tag を抽出
        cursor.execute("SELECT content, summary, memo, impression FROM study_logs")
        for content, summary, memo, impression in cursor.fetchall():
            text = "\n".join([x for x in [content, summary, memo, impression] if x])
            for name in _extract_hashtags_from_text(text):
                counts[name] = counts.get(name, 0) + 1
                sources.setdefault(name, 'entry')

        # daily_summaries.summary から #tag 抽出
        cursor.execute("SELECT summary FROM daily_summaries WHERE summary IS NOT NULL AND summary != ''")
        for (summary,) in cursor.fetchall():
            for name in _extract_hashtags_from_text(summary):
                counts[name] = counts.get(name, 0) + 1
                sources.setdefault(name, 'summary')

    items = []
    for name, cnt in counts.items():
        if prefix and not name.startswith(prefix):
            continue
        items.append({
            "name": name,
            "source": sources.get(name, 'entry'),
            "count": cnt
        })

    # count desc, then name asc
    items.sort(key=lambda x: (-x["count"], x["name"]))
    if limit_val is not None and limit_val >= 0:
        items = items[:limit_val]
    return {"tags": items}

def _within_range(date_str, start=None, end=None):
    if not date_str:
        return False
    try:
        d = datetime.datetime.strptime(date_str, '%Y-%m-%d').date()
    except Exception:
        try:
            d = datetime.datetime.strptime(date_str, '%Y-%m-%d %H:%M:%S').date()
        except Exception:
            return False
    if start and d < start:
        return False
    if end and d > end:
        return False
    return True

def search_data(params):
    """全期間/範囲・タイプ・テキスト・タグで横断検索する。
    params: {
      from: 'YYYY-MM-DD' | None,
      to: 'YYYY-MM-DD' | None,
      type: 'all'|'entry'|'goal'|'summary',
      q: str | None,
      tags: list[str] | comma-separated str | None,
      match: 'all'|'any',
      limit: int (default 20),
      offset: int (default 0)
    }
    返却: { total, items, hasMore, nextOffset }
    """
    q = (params.get('q') or '').strip()
    typ = (params.get('type') or 'all').lower()
    match = (params.get('match') or 'all').lower()
    order = (params.get('order') or 'relevance').lower()
    limit = params.get('limit')
    offset = params.get('offset')
    try:
        limit = int(limit) if limit is not None else 20
    except Exception:
        limit = 20
    try:
        offset = int(offset) if offset is not None else 0
    except Exception:
        offset = 0

    # キーワード（半角空白で分割し AND 条件）
    try:
        q_words = [w for w in re.split(r"\s+", q) if w]
    except Exception:
        q_words = [q] if q else []

    # date range
    start = params.get('from') or params.get('start')
    end = params.get('to') or params.get('end')
    start_d = None
    end_d = None
    try:
        if start:
            start_d = datetime.datetime.strptime(start, '%Y-%m-%d').date()
        if end:
            end_d = datetime.datetime.strptime(end, '%Y-%m-%d').date()
    except Exception:
        # 無効な日付は無視
        start_d = start_d
        end_d = end_d

    # tags normalization
    raw_tags = params.get('tags')
    if isinstance(raw_tags, str):
        tag_list = [t.strip() for t in raw_tags.split(',') if t.strip()]
    elif isinstance(raw_tags, list):
        tag_list = [str(t).strip() for t in raw_tags if str(t).strip()]
    else:
        tag_list = []

    items = []

    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # 正規化済み語
        q_words_norm = [_norm(w) for w in q_words]

        def _matches_q(texts):
            # 全フィールドを結合し、正規化でAND判定
            hay = "\n".join([t for t in texts if t])
            hay_n = _norm(hay)
            for w in q_words_norm:
                if w and (hay_n.find(w) == -1):
                    return False
            return True

        def _tags_match_in_text(hay: str) -> bool:
            if not tag_list:
                return True
            tags_in_text = set(_extract_hashtags_from_text(hay))
            if match == 'all':
                return all(t in tags_in_text for t in tag_list)
            else:
                return any(t in tags_in_text for t in tag_list)

        def _tags_match_in_goal(goal_tags) -> bool:
            if not tag_list:
                return True
            if not isinstance(goal_tags, list):
                goal_tags = []
            if match == 'all':
                return all(t in goal_tags for t in tag_list)
            else:
                return any(t in goal_tags for t in tag_list)

        def _append_entry(row):
            # 日付抽出
            date_only = row['start_time'][:10] if row['start_time'] else None
            if not _within_range(date_only, start_d, end_d):
                return
            texts = [row['subject'], row['summary'], row['content'], row['memo'], row['impression']]
            if not _matches_q(texts):
                return
            hay = "\n".join([t for t in texts if t])
            if not _tags_match_in_text(hay):
                return
            # 重み: title > session_summary > body > memo > impression > tags
            weights = {
                'title': 10,
                'session_summary': 8,
                'body': 6,
                'memo': 4,
                'impression': 2,
                'tags': 1,
            }
            fields = {
                'title': row['subject'] or '',
                'session_summary': row['summary'] or '',
                'body': row['content'] or '',
                'memo': row['memo'] or '',
                'impression': row['impression'] or '',
            }
            # マッチ位置取得
            matches = []
            for fname, ftext in fields.items():
                idx = _first_match_index(ftext, q_words_norm)
                if idx != -1:
                    matches.append((fname, idx))
            # スコア算出
            score = 0
            for fname, _ in matches:
                score += weights.get(fname, 0)
            # スニペット（最大2件、重み降順）
            snippets = []
            for fname, idx in sorted(matches, key=lambda x: weights.get(x[0], 0), reverse=True)[:2]:
                # マッチ長は最初の語長で近似
                first_term_len = len(q_words_norm[0]) if q_words_norm else 1
                snippet = _make_centered_snippet(fields[fname], idx, first_term_len, max_len=80)
                snippets.append({'field': fname, 'text': snippet})
            items.append({
                'kind': 'entry',
                'id': row['id'],
                'date': date_only,
                'subject': row['subject'],
                'content': row['content'],
                'type': row['event_type'],
                'preview': _make_preview(row['summary'], row['content'], row['memo'], row['impression']),
                'snippets': snippets,
                'score': score,
            })

        def _append_goal(row):
            date_only = row['date']
            if not _within_range(date_only, start_d, end_d):
                return
            tags_list = []
            if row['tags']:
                try:
                    tags_list = json.loads(row['tags'])
                except Exception:
                    tags_list = []
            texts = [row['subject'], row['task'], row['details']]
            if not _matches_q(texts):
                return
            if not _tags_match_in_goal(tags_list):
                return
            # 重みをエントリに準拠（session_summary/impressionはなし）
            weights = {
                'title': 10,
                'body': 6,  # task
                'memo': 4,  # details
                'tags': 1,
            }
            fields = {
                'title': row['subject'] or '',
                'body': row['task'] or '',
                'memo': row['details'] or '',
            }
            matches = []
            for fname, ftext in fields.items():
                idx = _first_match_index(ftext, q_words_norm)
                if idx != -1:
                    matches.append((fname, idx))
            score = 0
            for fname, _ in matches:
                score += weights.get(fname, 0)
            snippets = []
            for fname, idx in sorted(matches, key=lambda x: weights.get(x[0], 0), reverse=True)[:2]:
                first_term_len = len(q_words_norm[0]) if q_words_norm else 1
                snippet = _make_centered_snippet(fields[fname], idx, first_term_len, max_len=80)
                snippets.append({'field': fname, 'text': snippet})
            items.append({
                'kind': 'goal',
                'id': row['id'],
                'date': date_only,
                'subject': row['subject'],
                'preview': _make_preview(row['task'], row['details']),
                'snippets': snippets,
                'score': score,
            })

        def _append_summary(row):
            date_only = row['date']
            if not _within_range(date_only, start_d, end_d):
                return
            texts = [row['summary']]
            if not _matches_q(texts):
                return
            hay = "\n".join([t for t in texts if t])
            if not _tags_match_in_text(hay):
                return
            weights = {'session_summary': 8}
            fields = {'session_summary': row['summary'] or ''}
            matches = []
            for fname, ftext in fields.items():
                idx = _first_match_index(ftext, q_words_norm)
                if idx != -1:
                    matches.append((fname, idx))
            score = sum(weights.get(fname, 0) for fname, _ in matches)
            snippets = []
            for fname, idx in matches[:2]:
                first_term_len = len(q_words_norm[0]) if q_words_norm else 1
                snippet = _make_centered_snippet(fields[fname], idx, first_term_len, max_len=80)
                snippets.append({'field': fname, 'text': snippet})
            items.append({
                'kind': 'summary',
                'id': row['date'],
                'date': date_only,
                'preview': _make_preview(row['summary']),
                'snippets': snippets,
                'score': score,
            })

        # entry
        if typ in ('all', 'entry'):
            cursor.execute("SELECT id, subject, content, summary, memo, impression, start_time, event_type FROM study_logs")
            for row in cursor.fetchall():
                _append_entry(row)

        # goal
        if typ in ('all', 'goal'):
            cursor.execute("SELECT id, date, subject, task, details, tags FROM goals")
            for row in cursor.fetchall():
                _append_goal(row)

        # summary
        if typ in ('all', 'summary'):
            cursor.execute("SELECT date, summary FROM daily_summaries")
            for row in cursor.fetchall():
                _append_summary(row)

    # 並び順: relevance/newest/oldest
    if order == 'relevance' and q_words:
        # relevance: スコア降順、同点は新しい日付優先
        items.sort(key=lambda x: (x.get('score', 0), x.get('date') or ''), reverse=True)
    elif order == 'oldest':
        items.sort(key=lambda x: (x['date'] or '', x['kind'], str(x['id'])))
    else:  # newest
        items.sort(key=lambda x: (x['date'] or '', x['kind'], str(x['id'])), reverse=True)
    total = len(items)
    sliced = items[offset: offset + limit]
    has_more = (offset + limit) < total
    next_offset = offset + limit if has_more else offset

    return {
        'total': total,
        'items': sliced,
        'hasMore': has_more,
        'nextOffset': next_offset
    }


def reconstruct_from_json(json_data_str):
    """JSONデータからデータベースを再構築し、結果を返す"""
    try:
        data = json.loads(json_data_str)
    except json.JSONDecodeError as e:
        return {"status": "error", "message": f"JSONデータの解析に失敗しました: {e}"}

    with get_connection() as conn:
        cursor = conn.cursor()
        # 既存のデータをクリア
        cursor.execute("DELETE FROM study_logs")
        cursor.execute("DELETE FROM daily_summaries")
        cursor.execute("DELETE FROM goals")
        conn.commit()

        today_date_str = datetime.date.today().strftime('%Y-%m-%d')

        # 日次概要を挿入
        daily_summary_text = data.get("daily_summary")
        if daily_summary_text:
            cursor.execute(
                "INSERT OR REPLACE INTO daily_summaries (date, summary) VALUES (?, ?)",
                (today_date_str, daily_summary_text)
            )
            conn.commit()

        # セッションデータを挿入
        for session in data.get("sessions", []):
            session_summary = session.get("summary")
            session_subject = session.get("subject")
            
            first_event_id = None
            for detail in session.get("details", []):
                event_type = detail.get("event_type")
                content = detail.get("content")
                start_time_str = detail.get("start_time")
                end_time_str = detail.get("end_time")
                duration_minutes = detail.get("duration_minutes")

                if len(start_time_str.split(':')) == 2: # HH:MM format
                    start_time_str += ':00'
                if end_time_str and len(end_time_str.split(':')) == 2: # HH:MM format
                    end_time_str += ':00'

                full_start_time = f"{today_date_str} {start_time_str}"
                full_end_time = f"{today_date_str} {end_time_str}" if end_time_str else None

                cursor.execute(
                    "INSERT INTO study_logs (event_type, subject, content, start_time, end_time, duration_minutes) VALUES (?, ?, ?, ?, ?, ?)",
                    (event_type, session_subject, content, full_start_time, full_end_time, duration_minutes)
                )
                if first_event_id is None and event_type == 'START':
                    first_event_id = cursor.lastrowid
            
            if first_event_id and session_summary:
                cursor.execute(
                    "UPDATE study_logs SET summary = ? WHERE id = ?",
                    (session_summary, first_event_id)
                )
        conn.commit()
        return {"status": "success", "message": "データベースの再構築が完了しました。"}

def is_today_log_exists():
    with get_connection() as conn:
        return conn.execute("SELECT 1 FROM study_logs WHERE DATE(start_time) = ? LIMIT 1", (datetime.date.today().strftime('%Y-%m-%d'),)).fetchone() is not None

# --- メイン処理 ---
def main():
    """コマンドライン引数に応じて各関数を呼び出す"""
    # 引数から --api-mode をチェック
    api_mode = '--api-mode' in sys.argv
    if api_mode:
        sys.argv.remove('--api-mode')

    setup_logging(api_mode=api_mode)
    
    create_tables()
    ensure_study_log_columns()

    if len(sys.argv) < 2 or sys.argv[1] in ('--help', '-h'):
        print_help()
        sys.exit(0)

    command = sys.argv[1]
    
    if command == 'execute':
        if len(sys.argv) != 3: # executeの引数はJSON文字列1つのみ
            logger.error("使用法: python manage_log.py [--api-mode] execute '<json_string>'")
            sys.exit(1)
        handle_execute(sys.argv[2])
    else:
        logger.error(f"エラー: 不明なコマンド '{command}'。'execute' コマンドを使用してください。")
        logger.error("詳細は --help を確認してください。")
        sys.exit(1)


# --- 新しいコマンド体系 ---

def handle_execute(json_string):
    """新しい'execute'コマンドを処理する"""
    try:
        data = json.loads(json_string)
        action = data.get("action")
        params = data.get("params", {})

        if not action:
            # このエラーはJSONとして返す
            print(json.dumps({"status": "error", "message": "JSONデータに'action'キーが含まれていません。"}, indent=2, ensure_ascii=False))
            sys.exit(1)

        # アクションハンドラを呼び出す
        action_handler = ACTION_HANDLERS.get(action)
        if action_handler:
            # backup_databaseのような引数なしで呼び出す必要があるアクションを処理
            if not params and action in ['db.backup', 'db.undo', 'db.redo', 'db.consolidate_break', 'db.recalculate_durations', 'data.unique_subjects', 'log.end_session', 'data.study_time_by_subject', 'data.weekly_study_time']:
                 result = action_handler()
            else:
                 result = action_handler(params)

            if result is not None:
                if isinstance(result, dict):
                    result['reminder'] = {
                        "message": "学習セッションが更新されました。以下の点について確認し、必要であれば更新してください。更新すべきか不明瞭な場合はユーザーに確認してください。",
                        "items_to_check": [
                            "セッションサマリー (summary.session_update)",
                            "日次サマリー (summary.daily_update)",
                            "目標の状態 (goal.update)"
                        ]
                    }
                print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            # このエラーはJSONとして返す
            print(json.dumps({"status": "error", "message": f"不明なアクション '{action}'"}, indent=2, ensure_ascii=False))
            sys.exit(1)

    except json.JSONDecodeError:
        # このエラーはJSONとして返す
        print(json.dumps({"status": "error", "message": "無効なJSON形式です。"}, indent=2, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:
        # このエラーはJSONとして返す
        logger.error(f"ハンドル実行中に予期せぬエラー: {e}", exc_info=True)
        print(json.dumps({"status": "error", "message": f"処理中にエラーが発生しました: {e}"}, indent=2, ensure_ascii=False))
        sys.exit(1)

def action_log_create(params):
    """学習ログを作成する (start_sessionのラッパー)"""
    subject = params.get("subject")
    content = params.get("content")
    memo = params.get("memo")
    impression = params.get("impression")
    if not subject or not content:
        raise ValueError("subjectとcontentは必須です。")
    start_session(subject, content, memo, impression)
    return {"status": "success", "message": "学習セッションを開始しました。"}

def action_log_get(params):
    """指定された日付のログを取得する"""
    date_str = params.get("date")
    if not date_str:
        raise ValueError("dateは必須です。")
    return get_logs_json_for_date(date_str)


def action_log_break(params):
    """学習セッションを休憩する"""
    break_content = params.get("break_content")
    return break_session(break_content=break_content)

def action_log_resume(params):
    """学習セッションを再開する"""
    memo = params.get("memo")
    impression = params.get("impression")
    resume_session(memo, impression)
    return {"status": "success", "message": "学習セッションを再開しました。"}

def action_session_merge(params):
    """2つの学習セッションを結合する"""
    session1_id = params.get("session1_id")
    session2_id = params.get("session2_id")
    if not session1_id or not session2_id:
        raise ValueError("session1_idとsession2_idは必須です。")
    return merge_sessions(session1_id, session2_id)

def action_log_end_session():
    """学習セッションを終了する"""
    return end_session()

def action_data_dashboard(params):
    """ダッシュボードのデータを取得する"""
    days = params.get("days")
    return get_dashboard_data(days)

def action_goal_add_to_date(params):
    """指定した日付に目標を追加する"""
    goal = params.get("goal")
    date = params.get("date")
    if not goal or not date:
        raise ValueError("goalとdateは必須です。")
    # goalオブジェクトをJSON文字列に変換
    goal_json_str = json.dumps(goal, ensure_ascii=False)
    return add_goal_to_date(goal_json_str, date)

def action_data_unique_subjects():
    """ユニークな教科のリストを取得する"""
    return get_all_unique_subjects()

def action_data_study_time_by_subject():
    """教科ごとの合計学習時間を取得する"""
    return get_study_time_by_subject()

def action_data_weekly_study_time():
    """過去7日間の日ごとの合計学習時間を取得する"""
    return get_weekly_study_time()

def get_this_week_study_time(week_start='sunday'):
    """週の開始（日曜または月曜）を起点に、当週7日分の日別学習時間を返す"""
    today = datetime.date.today()
    if str(week_start).lower().startswith('mon'):
        # 月曜始まり: Monday=0 .. Sunday=6
        start_of_week = today - datetime.timedelta(days=today.weekday())
    else:
        # 日曜始まり: Sunday=6（weekday: Mon=0..Sun=6）→ 前の日曜まで戻す
        offset = (today.weekday() + 1) % 7  # Mon(0)->1 ... Sun(6)->0
        start_of_week = today - datetime.timedelta(days=offset)

    data = []
    with get_connection() as conn:
        cursor = conn.cursor()
        for i in range(7):
            day = start_of_week + datetime.timedelta(days=i)
            day_str = day.strftime('%Y-%m-%d')
            day_name_en = day.strftime('%a')
            day_map = {'Sun': '日', 'Mon': '月', 'Tue': '火', 'Wed': '水', 'Thu': '木', 'Fri': '金', 'Sat': '土'}
            day_name_ja = day_map.get(day_name_en, '')
            cursor.execute(
                "SELECT SUM(duration_minutes) FROM study_logs WHERE DATE(start_time) = ? AND event_type IN ('START', 'RESUME')",
                (day_str,)
            )
            total_minutes = cursor.fetchone()[0] or 0
            data.append({"day": day_name_ja, "time": total_minutes})
    return data

def action_data_this_week_study_time(params):
    week_start = (params or {}).get('week_start', 'sunday')
    return get_this_week_study_time(week_start)

def action_log_delete(params):
    """指定されたIDの学習ログを削除する"""
    log_id = params.get("id")
    if not log_id:
        raise ValueError("idは必須です。")
    
    backup_database("Before deleting log entry.")
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM study_logs WHERE id = ?", (log_id,))
        if cursor.rowcount > 0:
            conn.commit()
            return {"status": "success", "message": f"ログID {log_id} を削除しました。"}
        else:
            raise ValueError(f"ログID {log_id} が見つかりません。")


def action_summary_daily_update(params):
    """日次サマリーを更新する"""
    text = params.get("text")
    date = params.get("date")
    if text is None:
        raise ValueError("textは必須です。")
    return add_or_update_daily_summary(text, date)

def action_summary_session_update(params):
    """セッションサマリーを更新する"""
    text = params.get("text")
    session_id = params.get("session_id")
    if text is None:
        raise ValueError("textは必須です。")
    return add_or_update_session_summary(text, session_id)

def action_session_active(params):
    """現在アクティブな学習セッションが存在するか（BREAKを除く）を返す"""
    with get_connection() as conn:
        cur = conn.cursor()
        # end_time が NULL の最新行を確認
        cur.execute("SELECT event_type FROM study_logs WHERE end_time IS NULL ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        if not row:
            return { "status": "success", "active": False, "event_type": None }
        evt = row[0]
        # BREAK は「休憩中」であり、学習継続中ではない扱い
        is_active = (evt is not None and str(evt).upper() != 'BREAK')
        return { "status": "success", "active": bool(is_active), "event_type": evt }

def action_goal_daily_update(params):
    """日次目標を更新する"""
    goal_json = params.get("goal_json")
    date = params.get("date")
    if goal_json is None:
        raise ValueError("goal_jsonは必須です。")
    return add_or_update_daily_goal(goal_json, date)

def action_goal_get(params):
    """IDで指定した目標を取得する"""
    goal_id = params.get("id")
    if not goal_id:
        raise ValueError("idは必須です。")
    return get_goal_by_id_global(goal_id)

def action_goal_update(params):
    """IDで指定した目標を更新する"""
    goal_id = params.get("id")
    field = params.get("field")
    value = params.get("value")
    if not all([goal_id, field, value is not None]):
        raise ValueError("id, field, valueは必須です。")
    return update_goal_by_id_global(goal_id, field, value)

def action_goal_delete(params):
    """IDで指定した目標を削除する"""
    goal_id = params.get("id")
    if not goal_id:
        raise ValueError("idは必須です。")
    return delete_goal_by_id_global(goal_id)

def action_log_get_entry(params):
    """IDで指定したログエントリを取得する"""
    log_id = params.get("id")
    if log_id is None:
        raise ValueError("idは必須です。")
    return get_log_entry_by_id(log_id)

def action_log_update_entry(params):
    """IDで指定したログエントリを更新する"""
    log_id = params.get("id")
    field = params.get("field")
    value = params.get("value")
    if not all([log_id, field, value is not None]):
        raise ValueError("id, field, valueは必須です。")
    return update_log_entry(log_id, **{field: value})

def action_log_update_end_time(params):
    """ログエントリの終了時刻を更新する"""
    log_id = params.get("id")
    end_time = params.get("end_time")
    if not all([log_id, end_time]):
        raise ValueError("id, end_timeは必須です。")
    return update_end_time(log_id, end_time)

def action_db_restore(params):
    """バックアップからデータベースを復元する"""
    backup_path = params.get("backup_path")
    if not backup_path:
        raise ValueError("backup_pathは必須です。")
    return restore_database(backup_path)

def action_db_reconstruct(params):
    """JSONデータからデータベースを再構築する"""
    json_data = params.get("json_data")
    if not json_data:
        raise ValueError("json_dataは必須です。")
    return reconstruct_from_json(json_data)

ACTION_HANDLERS = {
    "log.create": action_log_create,
    "log.get": action_log_get,
    "log.break": action_log_break,
    "log.resume": action_log_resume,
    "log.end_session": action_log_end_session,
    "log.delete": action_log_delete,
    "log.get_entry": action_log_get_entry,
    "log.update_entry": action_log_update_entry,
    "log.update_end_time": action_log_update_end_time,
    "session.merge": action_session_merge,
    "session.active": action_session_active,
    "summary.daily_update": action_summary_daily_update,
    "summary.session_update": action_summary_session_update,
    "goal.daily_update": action_goal_daily_update,
    "data.dashboard": action_data_dashboard,
    "goal.add_to_date": action_goal_add_to_date,
    "goal.get": action_goal_get,
    "goal.update": action_goal_update,
    "goal.delete": action_goal_delete,
    "data.unique_subjects": action_data_unique_subjects,
    "data.study_time_by_subject": action_data_study_time_by_subject,
    "data.weekly_study_time": action_data_weekly_study_time,
    "data.this_week_study_time": action_data_this_week_study_time,
    "data.events_since": action_data_events_since,
    # new: tags + search
    "data.tags": lambda params: get_all_tags(params.get("prefix"), params.get("limit")),
    "data.search": lambda params: search_data(params),
    "db.restore": action_db_restore,
    "db.reconstruct": action_db_reconstruct,
    "db.backup": backup_now,
    "db.undo": undo_last_operation,
    "db.redo": redo_last_undo,
    "db.consolidate_break": consolidate_last_break_into_resume,
    "db.recalculate_durations": recalculate_all_durations,
}

if __name__ == '__main__':
    main()


# -*- coding: utf-8 -*-

import sqlite3
import datetime
import os
import sys
import shutil
import json
import uuid
from zoneinfo import ZoneInfo

# --- 定数 ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(SCRIPT_DIR, 'study_log.db')
BACKUP_DIR = os.path.join(SCRIPT_DIR, 'db_backups')
BACKUP_LOG_PATH = os.path.join(BACKUP_DIR, 'backup_log.txt')
MAX_BACKUPS = 100
LONG_TERM_BACKUP_DIR = os.path.join(SCRIPT_DIR, 'db_long_term_backups')
MAX_LONG_TERM_BACKUPS = 30
REDO_BACKUP_DIR = os.path.join(SCRIPT_DIR, 'db_redo_backups')
MAX_REDO_BACKUPS = 10
JST = ZoneInfo("Asia/Tokyo")

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
Usage: python manage_log.py <command> [arguments]

Gemini CLIのための学習ログ管理ツール。
コマンドは目的別に分類されています。危険なコマンドには警告が付いています。

--- 📖 日常的な記録コマンド (安全) ---
毎日使う、基本的な学習記録用のコマンドです。

  start <subject> "<content>"       新しい学習セッションを開始します。
  break ["<content>"]               現在のセッションを一時停止します。
  resume ["<content>"]              一時停止したセッションを再開します。
  end_session                       現在の学習セッションを休憩なしで終了します。

--- 📊 データの確認・要約コマンド (安全) ---
記録した学習内容を確認・要約するためのコマンドです。

  summary "<text>" [session_id]     セッションの概要を追加・更新します。(Geminiが内容を生成)
  daily_summary "<text>" [YYYY-MM-DD] 特定の日の概要を追加・更新します。(Geminiが内容を生成)
  logs_json_for_date YYYY-MM-DD    特定の日の全ログをJSON形式で取得します。
  dashboard_json [days]             Webダッシュボード用のデータをJSON形式で取得します。
  unique_subjects                   記録されている全ての教科名をリスト表示します。
  get_entry <log_id>                特定のログエントリの詳細を取得します。

  --- 🎯 目標管理コマンド (安全) ---
  daily_goal "<json_string>" [YYYY-MM-DD] 特定の日の目標をJSONで一括設定・更新します。
  add_goal_to_date "<json>" <YYYY-MM-DD> 特定の日に新しい目標を1つ追加します。
  get_goal <goal_id>                IDで指定した目標の詳細を取得します。
  update_goal <id> <field> <value>  IDで指定した目標の特定フィールドを更新します。
  delete_goal <goal_id>             IDで指定した目標を削除します。

--- ⚠️ データベース保守・復旧コマンド (注意/危険) ---
データベースのバックアップや復元、修正を行います。データの損失に繋がる可能性があるため、慎重に使用してください。

  backup                            手動でデータベースのバックアップを作成します。
  undo                              直前のデータベース操作を取り消します。(バックアップから復元)
  redo                              直前の'undo'操作をやり直します。

  consolidate_break                 [状況による] 最後のBREAKを直前のRESUMEに統合します。
                                    (手動でのログ修正が面倒な場合に使用)
  recalculate_durations             [状況による] 全てのログのdurationを再計算します。
                                    (時間計算に不整合が起きた場合に使用)

  ⚠️ restore <backup_file_path>      [危険] 指定したバックアップファイルからデータベースを復元します。
                                    現在のデータは上書きされます。'undo'の方が安全です。

  ⚠️ reconstruct "<json_string>"       [極めて危険] JSONデータからデータベースを完全に再構築します。
                                    >> 全ての既存データ(ログ,概要,目標)が削除されます <<
                                    >> 'undo'では元に戻せません <<
                                    データベースが破損した際の最終手段です。
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
                summary TEXT
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

def add_summary_column_if_not_exists():
    """study_logsテーブルにsummaryカラムが存在しない場合に追加する"""
    try:
        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("PRAGMA table_info(study_logs)")
            columns = [row[1] for row in cursor.fetchall()]
            if 'summary' not in columns:
                cursor.execute("ALTER TABLE study_logs ADD COLUMN summary TEXT")
                conn.commit()
                print("データベースに 'summary' カラムを追加しました。")
    except Exception as e:
        print("カラムの追加中にエラーが発生しました: {}".format(e))

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
        print("データベースをバックアップしました: {}".format(backup_path))
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
        print("データベースのバックアップ中にエラーが発生しました: {}".format(e))

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
        print("バックアップの管理中にエラーが発生しました: {}".format(e))

def manage_long_term_backups():
    try:
        backup_files = sorted(
            [os.path.join(LONG_TERM_BACKUP_DIR, f) for f in os.listdir(LONG_TERM_BACKUP_DIR) if f.startswith("study_log_") and f.endswith(".db")],
            key=os.path.getmtime
        )
        while len(backup_files) > MAX_LONG_TERM_BACKUPS:
            os.remove(backup_files.pop(0))
    except Exception as e:
        print("長期バックアップの管理中にエラーが発生しました: {}".format(e))

def manage_redo_backups():
    try:
        redo_files = sorted(
            [os.path.join(REDO_BACKUP_DIR, f) for f in os.listdir(REDO_BACKUP_DIR) if f.startswith("study_log_") and f.endswith(".db")],
            key=os.path.getmtime
        )
        while len(redo_files) > MAX_REDO_BACKUPS:
            os.remove(redo_files.pop(0))
    except Exception as e:
        print("Redoバックアップの管理中にエラーが発生しました: {}".format(e))

def restore_database(backup_file_path, description="Restored from backup"):
    try:
        shutil.copy2(backup_file_path, DB_PATH)
        print("データベースを復元しました: {} から".format(backup_file_path))
        with open(BACKUP_LOG_PATH, "a", encoding="utf-8") as f:
            log_entry = "{}: {}".format(os.path.basename(backup_file_path), description)
            f.write(log_entry + "\n")
    except Exception as e:
        print("データベースの復元中にエラーが発生しました: {}".format(e))

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
        print("直前の操作を取り消しました。")
    else:
        print("取り消せる操作がありません。")

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
        print("直前のundo操作を元に戻しました。")
    else:
        print("元に戻せるundo操作がありません。")

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
        print("エラー: ログエントリが不足しています。")
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
        print("最後のBREAKイベントを直前のRESUMEイベントに統合しました。")
    else:
        print("エラー: 最後のイベントがBREAK、その前のイベントがRESUMEではありません。")

def update_end_time(log_id, end_time):
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT start_time FROM study_logs WHERE id = ?", (log_id,))
        start_time_str = cursor.fetchone()[0]
        
        start_time = datetime.datetime.strptime(start_time_str, '%Y-%m-%d %H:%M:%S')
        end_time_dt = datetime.datetime.strptime(end_time, '%Y-%m-%d %H:%M:%S')
        
        duration = end_time_dt - start_time
        duration_minutes = int(duration.total_seconds() / 60)
        
        cursor.execute(
            "UPDATE study_logs SET end_time = ?, duration_minutes = ? WHERE id = ?",
            (end_time, duration_minutes, log_id)
        )

def update_log_entry(log_id, event_type=None, subject=None, content=None, start_time=None, end_time=None, duration_minutes=None, summary=None):
    backup_database("Before updating log entry.")




    def get_goal_by_id_global(goal_id):
        with get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM goals WHERE id = ?", (goal_id,))
            return cursor.fetchone()

    def update_goal_by_id_global(goal_id, field, value):
        backup_database("Before updating goal by global ID.")
        with get_connection() as conn:
            cursor = conn.cursor()
            
            # Check if the goal exists
            cursor.execute("SELECT id FROM goals WHERE id = ?", (goal_id,))
            if cursor.fetchone() is None:
                print(f"エラー: 目標ID {goal_id} が見つかりません。")
                return

            set_clause = ""
            param_value = value

            if field == "completed":
                param_value = 1 if value.lower() == "true" else 0
                set_clause = "completed = ?"
            elif field in ["total_problems", "completed_problems"]:
                try:
                    param_value = int(value)
                    set_clause = f"{field} = ?"
                except ValueError:
                    print(f"エラー: {field} は整数である必要があります。")
                    return
            elif field == "tags":
                try:
                    json.loads(value) # Validate if it's a valid JSON string
                    param_value = value
                    set_clause = "tags = ?"
                except json.JSONDecodeError:
                    print(f"エラー: tags は有効なJSON文字列である必要があります。")
                    return
            elif field == "details":
                param_value = value
                set_clause = "details = ?"
            elif field == "task":
                param_value = value
                set_clause = "task = ?"
            elif field == "subject":
                param_value = value
                set_clause = "subject = ?"
            else:
                print(f"エラー: 無効なフィールド名 '{field}' です。")
                return

            now = datetime.datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S')
            cursor.execute(
                f"UPDATE goals SET {set_clause}, updated_at = ? WHERE id = ?",
                (param_value, now, goal_id)
            )
            conn.commit()
        print(f"目標ID {goal_id} の {field} を更新しました。")

    def delete_goal_by_id_global(goal_id):
        backup_database("Before deleting goal by global ID.")
        with get_connection() as conn:
            cursor = conn.cursor()
        cursor.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
        if cursor.rowcount > 0:
            conn.commit()
            print(f"目標ID {goal_id} を削除しました。")
        else:
            print(f"エラー: 目標ID {goal_id} が見つかりません。")

    with get_connection() as conn:
        cursor = conn.cursor()
        set_clauses = []
        params = []
        if event_type is not None:
            set_clauses.append("event_type = ?")
            params.append(event_type)
        if subject is not None:
            set_clauses.append("subject = ?")
            params.append(subject)
        if content is not None:
            set_clauses.append("content = ?")
            params.append(content)
        if start_time is not None:
            set_clauses.append("start_time = ?")
            params.append(start_time)
        if end_time is not None:
            set_clauses.append("end_time = ?")
            params.append(end_time)
        if duration_minutes is not None:
            set_clauses.append("duration_minutes = ?")
            params.append(duration_minutes)
        if summary is not None:
            set_clauses.append("summary = ?")
            params.append(summary)
        
        if not set_clauses:
            print("更新するフィールドが指定されていません。")
            return

        params.append(log_id)
        query = "UPDATE study_logs SET {} WHERE id = ?".format(", ".join(set_clauses))
        cursor.execute(query, tuple(params))
        conn.commit()
        print("ログID {} を更新しました。".format(log_id))

def get_log_entry_by_id(log_id):
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM study_logs WHERE id = ?", (log_id,))
        return cursor.fetchone()
    with get_connection() as conn:
        conn.execute(
            "UPDATE study_logs SET end_time = ? WHERE id = ?",
            (end_time, log_id)
        )

def start_session(subject, content):
    if not is_today_log_exists():
        backup_database("Daily auto backup before first study session.", backup_type="long_term")
    backup_database("Before start session.")
    now = get_now()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO study_logs (event_type, subject, content, start_time) VALUES (?, ?, ?, ?)",
            ('START', subject, content, now)
        )
    print("学習を開始しました: {} - {}".format(subject, content))

def end_session():
    backup_database("Before ending session.")
    last_active_id = get_last_active_log_id()
    if last_active_id:
        now = get_now()
        update_end_time(last_active_id, now)
        print("学習セッションを終了しました。")
    else:
        print("エラー: 開始中のセッションがありません。")

def break_session(content=None):
    backup_database("Before break session.")
    last_active_id = get_last_active_log_id()
    if last_active_id:
        now = get_now()
        update_end_time(last_active_id, now)

        # If user provided content to break, update the last active log's content
        if content:
            update_log_entry(last_active_id, content=content)

        # Get the details of the last active log entry to generate summary
        last_active_log_entry = get_log_entry_by_id(last_active_id)
        generated_summary = ""
        if last_active_log_entry:
            subject = last_active_log_entry['subject'] if last_active_log_entry['subject'] else "不明な教科"
            # Use the potentially updated content for summary generation
            current_content_for_summary = last_active_log_entry['content'] if last_active_log_entry['content'] else "不明な内容"
            generated_summary = "{} {} 完了".format(subject, current_content_for_summary)

        with get_connection() as conn:
            conn.execute(
                "INSERT INTO study_logs (event_type, content, start_time) VALUES (?, ?, ?)",
                ('BREAK', None, now) # BREAKイベントのcontentは空にする
            )
        # セッションの概要を更新
        add_or_update_session_summary(content, last_active_id)
        print("学習を休憩しました。")
    else:
        print("エラー: 開始中のセッションがありません。")

def resume_session(content=None):
    backup_database("Before resume session.")
    last_active_id = get_last_active_log_id()
    if last_active_id:
        now = get_now()
        update_end_time(last_active_id, now)
        if content: # If content is provided to resume, update the content of the last BREAK event
            update_log_entry(last_active_id, content=content)
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
                "INSERT INTO study_logs (event_type, subject, content, start_time) VALUES (?, ?, ?, ?)",
                ('RESUME', subject, actual_content, now)
            )
        print("学習を再開しました。")
    else:
        print("エラー: 休憩中のセッションがありません。")

def add_or_update_daily_summary(summary_text, date_str=None):
    backup_database("Before daily summary update.")
    """日ごとの概要を追加または更新する"""
    if not date_str:
        date_str = datetime.date.today().strftime('%Y-%m-%d')
    with get_connection() as conn:
        cursor = conn.cursor()
        # 既存のレコードがあるか確認
        cursor.execute("SELECT date FROM daily_summaries WHERE date = ?", (date_str,))
        if cursor.fetchone():
            # あればUPDATE
            cursor.execute(
                "UPDATE daily_summaries SET summary = ? WHERE date = ?",
                (summary_text, date_str)
            )
        else:
            # なければINSERT
            cursor.execute(
                "INSERT INTO daily_summaries (date, summary) VALUES (?, ?)",
                (date_str, summary_text)
            )
        conn.commit()
    print(f"Geminiの分析に基づき、日付 {date_str} の概要を更新しました。")

def add_or_update_daily_goal(goal_json_str, date_str=None):
    backup_database("Before daily goal update.")
    """日ごとの目標を追加または更新する"""
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
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO goals (id, date, task, completed, subject, total_problems, completed_problems, tags, details, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (goal_entry["id"], date_str, goal_entry["task"], 1 if goal_entry["completed"] else 0,
                     goal_entry["subject"], goal_entry["total_problems"], goal_entry["completed_problems"],
                     json.dumps(goal_entry["tags"], ensure_ascii=False), goal_entry["details"],
                     goal_entry["created_at"], goal_entry["updated_at"]))
            conn.commit()
        print(f"日付 {date_str} の目標を更新しました。")

    except json.JSONDecodeError as e:
        print(f"エラー: 目標は有効なJSON形式である必要があります。{e}")
        return
    except ValueError as ve:
        print(f"エラー: 目標データの構造が不正です。{ve}")
        return
    except Exception as e:
        print(f"エラー: 目標の更新中に予期せぬエラーが発生しました。{e}")
        return

def add_goal_to_date(goal_json_str, date_str):
    """指定された日付に新しい目標を1つ追加する"""
    backup_database("Before adding a goal to a specific date.")
    try:
        new_goal = json.loads(goal_json_str)
        # 新しい目標のIDを再生成し、未完了状態にする
        new_goal['id'] = str(uuid.uuid4())
        new_goal['completed'] = False
        if 'completed_problems' in new_goal:
            new_goal['completed_problems'] = 0
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
            cursor.execute(
                """
                INSERT INTO goals (id, date, task, completed, subject, total_problems, completed_problems, tags, details, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (new_goal["id"], date_str, new_goal["task"], 1 if new_goal["completed"] else 0,
                 new_goal["subject"], new_goal["total_problems"], new_goal["completed_problems"],
                 json.dumps(new_goal["tags"], ensure_ascii=False), new_goal["details"],
                 new_goal["created_at"], new_goal["updated_at"]))
            conn.commit()

        print(f"日付 {date_str} に目標「{new_goal.get('task', '')}」を追加しました。")

    except json.JSONDecodeError as e:
        print(f"エラー: 追加する目標データが有効なJSON形式ではありません。{e}")
        return
    except ValueError as ve:
        print(f"エラー: 目標データの構造が不正です。{ve}")
        return
    except Exception as e:
        print(f"エラー: 目標データの処理中にエラーが発生しました。{e}")
        return


def add_or_update_session_summary(summary_text, session_id=None):
    backup_database("Before session summary update.")
    """セッションの概要を追加または更新する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        target_id = session_id
        if not target_id:
            cursor.execute("SELECT MAX(id) FROM study_logs WHERE event_type = 'START'")
            result = cursor.fetchone()
            if result: target_id = result[0]
        
        if not target_id:
            print("エラー: 対象セッションが見つかりません。")
            return

        cursor.execute("UPDATE study_logs SET summary = ? WHERE id = ?", (summary_text, target_id))
        if cursor.rowcount > 0:
            print("セッションID {} の概要を更新しました。".format(target_id))
        else:
            print("エラー: セッションID {} が見つかりません。".format(target_id))

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

def show_logs_json_for_date(date_str):
    """指定された日付のログと概要をJSONで出力する"""
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
        "sessions": []
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
            SELECT id, event_type, subject, content, start_time, end_time, summary
            FROM study_logs WHERE DATE(start_time) = ? ORDER BY start_time
        """, (date_str,))
        logs = cursor.fetchall()

    if logs:
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
                current_session["details"].append({
                    "event_type": log_dict["event_type"], "content": log_dict["content"],
                    "start_time": start_dt.strftime("%H:%M"),
                    "end_time": end_dt.strftime("%H:%M") if log_dict["end_time"] else "",
                    "duration_minutes": duration_minutes
                })
                if not current_session["session_start_time"]:
                     current_session["session_start_time"] = start_dt.strftime("%H:%M")
                current_session["session_end_time"] = end_dt.strftime("%H:%M") if log_dict["end_time"] else start_dt.strftime("%H:%M")
        if current_session: output_data["sessions"].append(current_session)

    # セッション情報から日次サマリー情報を計算
    if output_data["sessions"]:
        total_minutes = sum(s['total_study_minutes'] for s in output_data['sessions'])
        subjects = sorted(list(set(s['subject'] for s in output_data['sessions'])))
        output_data['total_day_study_minutes'] = total_minutes
        output_data['subjects_studied'] = subjects
        output_data['daily_summary']['total_duration'] = total_minutes
        output_data['daily_summary']['subjects'] = subjects

    print(json.dumps(output_data, indent=2, ensure_ascii=False))

def get_all_unique_subjects():
    """すべての学習ログからユニークな教科のリストを取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT DISTINCT subject FROM study_logs WHERE subject IS NOT NULL AND subject != '' ORDER BY subject")
        subjects = [row[0] for row in cursor.fetchall()]
        return subjects

def get_dashboard_data(weekly_period_days=None):
    """ダッシュボード用のデータを取得してJSONで出力する"""
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
            if goal_dict.get('completed', False) or \
               (goal_dict.get('total_problems') is not None and goal_dict.get('completed_problems') is not None and \
                goal_dict['total_problems'] > 0 and goal_dict['completed_problems'] >= goal_dict['total_problems']):
                completed_goals += 1

        # 最近の学習セッション (直近2件)
        cursor.execute("""
            SELECT subject, content, start_time, end_time, duration_minutes
            FROM study_logs 
            WHERE event_type IN ('START', 'RESUME')
            ORDER BY start_time DESC 
            LIMIT 2
        """,)
        recent_sessions_raw = cursor.fetchall()
        recent_sessions = []
        for row in recent_sessions_raw:
            start_time = datetime.datetime.strptime(row['start_time'], '%Y-%m-%d %H:%M:%S')
            end_time = datetime.datetime.strptime(row['end_time'], '%Y-%m-%d %H:%M:%S') if row['end_time'] else start_time
            recent_sessions.append({
                'subject': row['subject'],
                'duration': row['duration_minutes'],
                'time': "{}-{}".format(start_time.strftime('%H:%M'), end_time.strftime('%H:%M')),
                'topic': row['content']
            })

    dashboard_data = {
        "studyStats": {
            "todayTime": today_time,
            "weeklyTime": weekly_time,
            "streak": streak,
            "completedGoals": completed_goals,
            "totalGoals": total_goals
        },
        "todayGoals": today_goals,
        "recentSessions": recent_sessions
    }
    
    print(json.dumps(dashboard_data, indent=2, ensure_ascii=False))

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
                print("Could not process log ID {}: {}".format(log_id, e))
        conn.commit()
    print("すべてのログの学習時間を再計算しました。")


def reconstruct_from_json(json_data_str):
    """JSONデータからデータベースを再構築する"""
    try:
        data = json.loads(json_data_str)
    except json.JSONDecodeError as e:
        print("エラー: JSONデータの解析に失敗しました: {}".format(e))
        return

    with get_connection() as conn:
        cursor = conn.cursor()
        # 既存のデータをクリア
        cursor.execute("DELETE FROM study_logs")
        cursor.execute("DELETE FROM daily_summaries")
        cursor.execute("DELETE FROM goals")
        conn.commit()
        print("既存の学習ログ、日次概要、目標をクリアしました。")

        today_date_str = datetime.date.today().strftime('%Y-%m-%d')

        # 日次概要を挿入
        daily_summary_text = data.get("daily_summary")
        if daily_summary_text:
            cursor.execute(
                "INSERT OR REPLACE INTO daily_summaries (date, summary) VALUES (?, ?)",
                (today_date_str, daily_summary_text)
            )
            conn.commit()
            print("日次概要を挿入しました。")

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

                # Add seconds if missing
                if len(start_time_str.split(':')) == 2: # HH:MM format
                    start_time_str += ':00'
                if end_time_str and len(end_time_str.split(':')) == 2: # HH:MM format
                    end_time_str += ':00'

                full_start_time = "{} {}".format(today_date_str, start_time_str)
                full_end_time = "{} {}".format(today_date_str, end_time_str) if end_time_str else None

                cursor.execute(
                    "INSERT INTO study_logs (event_type, subject, content, start_time, end_time, duration_minutes) VALUES (?, ?, ?, ?, ?, ?)",
                    (event_type, session_subject, content, full_start_time, full_end_time, duration_minutes)
                )
                if first_event_id is None and event_type == 'START':
                    first_event_id = cursor.lastrowid
            
            # セッションのサマリーを最初のSTARTイベントに紐づける
            if first_event_id and session_summary:
                cursor.execute(
                    "UPDATE study_logs SET summary = ? WHERE id = ?",
                    (session_summary, first_event_id)
                )
        conn.commit()
        print("データベースの再構築が完了しました。")

def is_today_log_exists():
    with get_connection() as conn:
        return conn.execute("SELECT 1 FROM study_logs WHERE DATE(start_time) = ? LIMIT 1", (datetime.date.today().strftime('%Y-%m-%d'),)).fetchone() is not None

# --- メイン処理 ---
def main():
    """コマンドライン引数に応じて各関数を呼び出す"""
    create_tables()
    add_summary_column_if_not_exists()

    if len(sys.argv) < 2:
        print("エラー: コマンドを指定してください。 --help で利用可能なコマンドを確認できます。")
        sys.exit(1)

    command = sys.argv[1]

    if command == '--help' or command == '-h':
        print_help()
        sys.exit(0)
    
    if command == 'start':
        if len(sys.argv) != 4: print("使用法: start <subject> <content>"); sys.exit(1)
        start_session(sys.argv[2], sys.argv[3])
    elif command == 'break':
        break_session(sys.argv[2] if len(sys.argv) == 3 else None)
    elif command == 'end_session':
        end_session()
    elif command == 'resume':
        resume_session(sys.argv[2] if len(sys.argv) == 3 else None)
    elif command == 'logs_json_for_date':
        if len(sys.argv) != 3: print("使用法: logs_json_for_date YYYY-MM-DD"); sys.exit(1)
        show_logs_json_for_date(sys.argv[2])
    elif command == 'get_chat_history':
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 5
        before_id = int(sys.argv[3]) if len(sys.argv) > 3 else None
        messages = get_chat_messages(limit, before_id)
        print(json.dumps(messages, indent=2, ensure_ascii=False))
    elif command == 'summary':
        if len(sys.argv) < 3 or len(sys.argv) > 4: print("使用法: summary \"<text>\" [session_id]"); sys.exit(1)
        add_or_update_session_summary(sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
    elif command == 'daily_summary':
        if len(sys.argv) < 3 or len(sys.argv) > 4:
            print("使用法: daily_summary \"<text>\" [YYYY-MM-DD]")
            sys.exit(1)
        add_or_update_daily_summary(sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
    elif command == 'daily_goal':
        if len(sys.argv) < 3 or len(sys.argv) > 4:
            print("使用法: daily_goal \"<json_string>\" [YYYY-MM-DD]")
            sys.exit(1)
        add_or_update_daily_goal(sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
    elif command == 'add_goal_to_date':
        if len(sys.argv) != 4:
            print("使用法: add_goal_to_date \"<goal_json>\" <YYYY-MM-DD>")
            sys.exit(1)
        add_goal_to_date(sys.argv[2], sys.argv[3])
    elif command == 'get_goal':
        if len(sys.argv) != 3:
            print("使用法: get_goal <goal_id>")
            sys.exit(1)
        goal_entry = get_goal_by_id_global(sys.argv[2])
        if goal_entry:
            print(json.dumps(dict(goal_entry), indent=2, ensure_ascii=False))
        else:
            print(f"目標ID {sys.argv[2]} が見つかりません。")
    elif command == 'update_goal':
        if len(sys.argv) != 5:
            print("使用法: update_goal <goal_id> <field_name> <new_value>")
            sys.exit(1)
        update_goal_by_id_global(sys.argv[2], sys.argv[3], sys.argv[4])
    elif command == 'delete_goal':
        if len(sys.argv) != 3:
            print("使用法: delete_goal <goal_id>")
            sys.exit(1)
        delete_goal_by_id_global(sys.argv[2])
    elif command == 'backup':
        backup_now()
    elif command == 'undo':
        undo_last_operation()
    elif command == 'redo':
        redo_last_undo()
    elif command == 'reconstruct':
        if len(sys.argv) != 3: print("使用法: reconstruct \"<json_string>\""); sys.exit(1)
        reconstruct_from_json(sys.argv[2])
    elif command == 'consolidate_break':
        consolidate_last_break_into_resume()
    elif command == 'update_log_end_time':
        if len(sys.argv) != 4: print("使用法: update_log_end_time <log_id> <end_time>"); sys.exit(1)
        update_end_time(int(sys.argv[2]), sys.argv[3])
    elif command == 'restore':
        if len(sys.argv) != 3: print("使用法: restore <backup_file_path>"); sys.exit(1)
        restore_database(sys.argv[2])
    elif command == 'update_log_entry_cmd':
        if len(sys.argv) < 5: print("使用法: update_log_entry_cmd <log_id> <field_name> <new_value>"); sys.exit(1)
        update_log_entry(int(sys.argv[2]), **{sys.argv[3]: sys.argv[4]})
    elif command == 'get_entry':
        if len(sys.argv) != 3: print("使用法: get_entry <log_id>"); sys.exit(1)
        log_entry = get_log_entry_by_id(int(sys.argv[2]))
        if log_entry:
            print(json.dumps(dict(log_entry), indent=2, ensure_ascii=False))
        else:
            print("ログID {} が見つかりません。".format(sys.argv[2]))
    elif command == 'unique_subjects':
        subjects = get_all_unique_subjects()
        print(json.dumps(subjects, ensure_ascii=False))
    elif command == 'dashboard_json':
        weekly_period_days = sys.argv[2] if len(sys.argv) > 2 else None
        get_dashboard_data(weekly_period_days)
    elif command == 'recalculate_durations':
        recalculate_all_durations()
    else:
        print("エラー: 不明なコマンド '{}'".format(command))
        sys.exit(1)

if __name__ == '__main__':
    main()

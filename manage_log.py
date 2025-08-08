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

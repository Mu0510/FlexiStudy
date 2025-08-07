# 実行コマンド

## CLIツール

*   **学習開始:** `python3 manage_log.py start <教科> "<内容>"`
*   **学習休憩:** `python3 manage_log.py break ["<内容>"]`
*   **学習再開:** `python3 manage_log.py resume ["<内容>"]`
*   **セッション終了:** `python3 manage_log.py end_session`
*   **セッション概要の追加/更新:** `python3 manage_log.py summary "概要文" [セッションID]`
*   **日次概要の追加/更新:** `python3 manage_log.py daily_summary "概要文" [YYYY-MM-DD]`
*   **目標の一括設定:** `python3 manage_log.py daily_goal "<json_string>" [YYYY-MM-DD]`
*   **目標の追加:** `python3 manage_log.py add_goal_to_date "<json>" <YYYY-MM-DD>`
*   **目標の取得:** `python3 manage_log.py get_goal <goal_id>`
*   **目標の更新:** `python3 manage_log.py update_goal <id> <field> <value>`
*   **目標の削除:** `python3 manage_log.py delete_goal <goal_id>`
*   **ログエントリの取得:** `python3 manage_log.py get_entry <log_id>`
*   **手動バックアップ:** `python3 manage_log.py backup`
*   **操作の取り消し (Undo):** `python3 manage_log.py undo`
*   **Undoのやり直し (Redo):** `python3 manage_log.py redo`
*   **バックアップから復元:** `python3 manage_log.py restore <backup_file_path>`
*   **JSONから再構築:** `python3 manage_log.py reconstruct "<json_string>"`
*   **Webダッシュボード用JSON出力:** `python3 manage_log.py logs_json_for_date YYYY-MM-DD`

## Webダッシュボード

*   **開発サーバー起動:** `cd webnew && npm run dev`
*   **本番サーバー起動:** `cd webnew && npm run start`
*   **ビルド:** `cd webnew && npm run build`
*   **リンティング:** `cd webnew && npm run lint`

## ユーティリティコマンド

*   **ファイルリスト:** `ls -F` (ディレクトリ内のファイルとサブディレクトリをリスト表示)
*   **ディレクトリ変更:** `cd <directory>`
*   **ファイル検索:** `find . -name "<filename_pattern>"`
*   **ファイル内容検索:** `grep -r "<pattern>" .`
*   **Gitステータス:** `git status`
*   **Git差分:** `git diff`
*   **Gitログ:** `git log`
*   **ファイル削除 (安全):** `trash <file_or_directory>` (trash-cliがインストールされている場合)

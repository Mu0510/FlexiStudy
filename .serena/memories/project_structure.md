# プロジェクトのラフな構造

このプロジェクトは、主にCLIツールとWebダッシュボードの2つのコンポーネントで構成されています。

## 主要ディレクトリとファイル

*   `/home/geminicli/GeminiCLI/` (プロジェクトルート)
    *   `manage_log.py`: 学習ログのデータベース操作を管理するPythonスクリプト。CLIツールの主要なロジックが含まれます。
    *   `study_log.db`: 学習ログのSQLiteデータベースファイル。
    *   `GEMINI.md`: プロジェクトの概要、ユーザー情報、学習計画、Webダッシュボードの詳細、トラブルシューティングなどが記載されたメインのメモファイル。
    *   `db_backups/`, `db_long_term_backups/`, `db_redo_backups/`: データベースの自動バックアップが保存されるディレクトリ。
    *   `delete_file.py`: ファイル削除の安全性を確保するためのPythonスクリプト。
    *   `package.json`, `package-lock.json`: プロジェクト全体のNode.js依存関係を管理するファイル。

*   `/home/geminicli/GeminiCLI/webnew/` (Webダッシュボードのルート)
    *   `app/`: Next.jsアプリケーションの主要なコンポーネントとページが含まれます。
        *   `app/api/`: APIエンドポイントの定義。
    *   `components/`: 再利用可能なUIコンポーネント。
    *   `public/`: 静的ファイル（画像、マニフェストなど）。
    *   `styles/`: グローバルなCSSファイル。
    *   `server.js`: Node.js (Express.js) のバックエンドサーバー。
    *   `package.json`: WebダッシュボードのNode.js依存関係とスクリプトを管理するファイル。
    *   `tsconfig.json`: TypeScriptの設定ファイル。
    *   `next.config.mjs`: Next.jsの設定ファイル。

*   `/home/geminicli/GeminiCLI/archive/web/`:
    *   旧Webダッシュボードのコードが含まれている可能性があります。現在は`webnew/`がアクティブなWebダッシュボードです。

*   `/home/geminicli/GeminiCLI/assets/`:
    *   画像などのアセットが保存されるディレクトリ。

## 開発ワークフロー

*   CLIツール (`manage_log.py`) で学習ログを記録し、`study_log.db`に保存します。
*   Webダッシュボード (`webnew/`) は、`manage_log.py`を介して`study_log.db`からデータを取得し、視覚的に表示します。

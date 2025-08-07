# タスク完了時に行うべきコマンド

## TypeScript / Next.js (webnew/)
*   **リンティング:** `npm run lint`
*   **ビルド:** `npm run build`
*   **開発サーバー起動:** `npm run dev` または `npm run start`

## Python
*   **テスト/リンティング:** 明示的なテストやリンティングコマンドは定義されていません。`manage_log.py`などのPythonスクリプトを変更した際は、手動での動作確認が重要です。

## 全体
*   **Gitコミット:** 変更をコミットする際は、`git status`、`git diff HEAD`、`git log -n 3`で変更内容とコミット履歴を確認し、適切なコミットメッセージを作成します。
*   **バックアップ:** データベース操作を行う際は、`manage_log.py`による自動バックアップが機能していることを確認します。必要に応じて`python manage_log.py backup`で手動バックアップも行えます。

### **Gemini CLI - `manage_log.py` 設計見直しプロジェクト 引き継ぎ資料**

**日付:** 2025年8月7日

**現在のプロジェクトディレクトリ:** `/home/geminicli/GeminiCLI`

---

#### **1. これまでの作業概要**

`manage_log.py`のコマンド体系が複雑でAIが扱いにくいという課題に対し、以下のステップで設計見直しを進めています。

*   **フェーズ1: コマンド体系の統一と整理 (進行中)**
    *   **`manage_log.py`の内部変更:**
        *   `show_logs_json_for_date`関数を`get_logs_json_for_date`にリネームし、JSONを直接`print`する代わりにPythonの`dict`を返すように修正しました。
        *   `get_dashboard_data`関数も同様に、JSONを直接`print`する代わりにPythonの`dict`を返すように修正しました。
        *   `main`関数をリファクタリングし、すべてのコマンドライン引数を単一の`execute`コマンド（例: `python manage_log.py execute '{"action": "...", "params": {...}}'`）で処理するように変更しました。
        *   古いコマンド形式（例: `python manage_log.py start ...`）との互換性を保つため、`parse_old_command`関数を新設し、古い形式の引数を新しいJSON形式に変換するレイヤーとして機能させています。
        *   各`action_*`関数は、標準出力に直接書き込むのではなく、処理結果の`dict`を返すように修正しました。
    *   **Webバックエンド (`webnew/app/api/`) の修正:**
        *   `webnew/app/api/logs/[date]/route.ts` を、新しい`execute`コマンド形式（`action: "log.get"`）を使用するように修正しました。
        *   `webnew/app/api/dashboard/route.ts` を、新しい`execute`コマンド形式（`action: "data.dashboard"`）を使用するように修正しました。
        *   `webnew/app/api/subjects/route.ts` の修正中に、インデントと`catch`の型定義の不一致により`replace`ツールが失敗し、現在このファイルの修正を再試行する直前です。

---

#### **2. これから行うべきこと**

*   **2.1. `webnew/app/api/subjects/route.ts`の修正完了:**
    *   現在の作業中断点です。正しいインデントと型定義で`replace`ツールを再試行し、`unique_subjects`コマンドの呼び出しを`execute`コマンド形式（`action: "data.unique_subjects"`）に修正してください。
*   **2.2. その他の呼び出し元の特定と修正:**
    *   プロジェクト内で`manage_log.py`を呼び出している他のファイル（特に`webnew/`以下のAPIルート）がないか再確認し、同様に`execute`コマンド形式に修正してください。
        *   **要確認ファイル:**
            *   `webnew/app/api/logs/route.ts` (GETリクエストで`logs_json_for_date`を呼び出している可能性があります)
            *   `webnew/app/api/goals/move/route.ts` (POSTリクエストで`add_goal_to_date`を呼び出している可能性があります)
            *   `webnew/server.js` (もしあれば、WebSocket経由でのコマンド実行部分を確認)
*   **2.3. `manage_log.py`のヘルプメッセージの更新:**
    *   すべての呼び出し元が新しい`execute`コマンド形式に移行したことを確認した後、`manage_log.py`内の`print_help()`関数を更新し、古いコマンドの記述を削除して新しい`execute`コマンドベースの利用方法のみを記載するようにしてください。
*   **2.4. 古いコマンドハンドラの削除:**
    *   `parse_old_command`関数が不要になった時点で（つまり、すべての呼び出し元が新しい形式に移行し、古いコマンド形式のサポートが不要になったと判断できる段階で）、この関数とそれに関連する古いコマンドハンドラを`manage_log.py`から完全に削除してください。
*   **2.5. テストと動作確認:**
    *   上記全ての変更後、Webダッシュボードが正常に動作するか、CLIからのコマンドが正しく実行されるかを確認してください。特に、データ表示、ログ記録、目標管理の各機能が期待通りに動くことを確認してください。
*   **2.6. 提案2への移行準備:**
    *   フェーズ1が完了し、システムが安定したことを確認した後、次のフェーズである「提案2：ライブラリ化とAPIサーバー化」の計画を立ててください。

---

#### **3. 注意点**

*   **互換性の維持:** Webバックエンドが`manage_log.py`に強く依存しているため、呼び出し元の修正は慎重に行い、JSONの構造や引数の渡し方を間違えないように細心の注意を払ってください。
*   **エラーハンドリング:** `child_process.exec`や`spawn`からのエラーが適切にフロントエンドに伝播されるか、修正後に確認してください。
*   **サーバーの再起動:** Webバックエンドの変更（特にNext.jsのAPIルート）は、Next.jsサーバーの再起動が必要になる場合があります。これはユーザーが担当しますので、必要に応じてユーザーに伝えてください。
*   **Serena系ツールの活用:** ファイル検索 (`serena__search_for_pattern`, `serena__find_file`)、内容読み込み (`serena__read_file`), 正規表現置換 (`serena__replace_regex`) など、Serena系ツールを積極的に活用して効率的に作業を進めてください。

---
# Study Logging & Data Operations

*Last updated: 2025-09-18*

この文書は学習ログ管理とデータ操作の詳細手順をまとめています。CLIが自動で参照する `GEMINI.md` にはサマリーのみ残し、具体的な構文はここから取得します。

## Command Entry Points
- すべての操作は `python3 manage_log.py execute '<json_payload>'` を基本とする。
- `--api-mode` を付与するとログ表示を抑制し、JSONレスポンスのみ返す。
- ペイロードスキーマ:
  ```json
  {
    "action": "group.action_name",
    "params": {
      "key": "value"
    }
  }
  ```

### log.* actions
| Action | 用途 | 主なパラメータ | 補足 |
| --- | --- | --- | --- |
| `log.create` | 学習セッション開始 | `subject`, `content`, 任意 `memo`, `impression` | `content` には目標タスク名のみ。ID等は含めない。 |
| `log.break` | 休憩記録 | 任意 `break_content` | 休憩理由やメモがあれば記述。 |
| `log.resume` | 休憩再開 | 任意 `memo`, `impression` | セッションの主題が変わる場合、`content`再構成を忘れない。 |
| `log.end_session` | 現在のセッション終了 | なし | `BREAK`を残さず終了可能。 |
| `log.get` | 指定日のログ一覧 | `date` | JSONで返却。 |
| `log.get_entry` | 単一ログ取得 | `id` (int) | |
| `log.update_entry` | 任意フィールド更新 | `id`, `field`, `value` | |
| `log.update_end_time` | 終了時刻調整 | `id`, `end_time` | `YYYY-MM-DD HH:MM:SS` |
| `log.delete` | ログ削除 | `id` | 慎重に。 |

### goal.*, summary.*, session.*
- `goal.daily_update` / `goal.add_to_date`: JSON文字列で目標群を更新。タグ・教材名は標準リストから選ぶ。
- `goal.update` / `goal.delete` / `goal.get`: UUID形式のIDを扱う。
- `session.merge`: 2セッションを統合する前に、`summary.session_update`でサマリーを一致させる。
- `summary.session_update` / `summary.daily_update`: セッションや日次の要約テキストを更新。日次と目標でNULL上書きが起きないよう既存値を読み込み、マージ済み。

### data.* / db.*
- `data.dashboard`: Webダッシュボード用データを抽出（`days`指定で期間調整）。
- `data.unique_subjects`: 既存教科一覧を取得し、タグ整備に利用。
- 危険コマンド群は以下を参照。実行前にバックアップ確認必須。
  | Action | 注意点 |
  | --- | --- |
  | `db.backup` | 直近状態の手動バックアップ。 |
  | `db.undo` / `db.redo` | 直前操作の巻き戻し・やり直し。`db_redo_backups`に保存。 |
  | `db.consolidate_break` | 直近`BREAK`を`RESUME`へ統合。 |
  | `db.recalculate_durations` | durations再計算。処理前にバックアップ推奨。 |
  | `db.restore` | 指定バックアップから復元。対話で明示確認を取る。 |
  | `db.reconstruct` | JSONから再構築。最終手段。 |

## Data Model Snapshot
### goals テーブル
- `task` フォーマット:
  1. 参考書・問題集: `【教材名】 範囲` / `details` 空欄。
  2. 模試・過去問: `task` に作業内容、`details` に `【種類】 名称 (年度)`。
  3. その他: `task` に具体作業、`details` 空欄。
- `subject` 標準リスト: `国語`, `数学`, `英語`, `物理`, `化学`, `地学`, `生物`, `地理`, `歴史`, `公民`, `情報`, `その他`。
- `tags` 標準例: `4STEP`, `セミナー物理`, `模試復習`, `過去問演習`, `マーク`, `記述`, `東大実戦`。新規追加はユーザー確認後。

### study_logs テーブル
- `START` content: 目標の `task`/`details` から構造化した主題を生成（例: `【2025 河合】第2回 全統共通テスト模試 (数学② 復習)`）。
- `RESUME`/`BREAK`: 新情報があれば全文をAIで再構成し一貫性を保つ。単純追記は禁止。
- `impression` は感情・気づきの短文、`memo` は事実備忘録を推奨。

### daily_summaries テーブル
- `summary` と `goal` が独立更新されるため、既存レコードを先に読み込み、新内容とマージした上で書き戻す。

## Backup & Safety Protocol
- **短期バックアップ** (`db_backups`, 最大100件): すべてのDB操作前に自動生成。
- **長期バックアップ** (`db_long_term_backups`, 最大30件): 1日の最初のセッション開始前に自動生成。
- **Redoバックアップ** (`db_redo_backups`, 最大10件): `undo` 実行時に生成。
- **削除ポリシー**: `rm`禁止。ファイル削除は `trash-cli` を使用。
- **危険操作チェックリスト**
  1. 対象ファイル・テーブル・件数を口頭で確認。
  2. 最新バックアップの有無を確認。必要なら `db.backup` で即時取得。
  3. ユーザーに内容と影響範囲を説明し同意を得る。
  4. 実行後はログとバックアップ状況を記録。

## Dashboard & Analytics Notes
- CLI内の簡易表示はテキストグラフ（ASCII）を検討中。Web UI化は中期計画。
- `data.dashboard`の出力を`webnew`向けに渡し、必要に応じて`webnew/notify`の設定と連携させる。

## Troubleshooting Highlights
1. **run_shell_commandから直接sqlite3を叩かない**: すべて `manage_log.py` に集約。
2. **Windows互換性**: パス区切りは `/` を推奨。削除はPythonスクリプト経由で。
3. **UTF-8を明示**: ファイルI/Oは `encoding='utf-8'` を指定し `conn.text_factory = str` を設定。
4. **subprocess引数**: リスト渡しを基本。リダイレクトが必要な場合のみ `shell=True`。
5. **ID形式の判別**: 整数 → study_logs、UUID → goals。誤適用を防ぐ。

より詳細なインシデント記録は `docs/operations-incidents.md` を参照。

## Recording Philosophy
> このシステムの最も重要な価値は、単なるデータ入力ツールではない点にあります。ユーザーとの対話から生まれる成果物として学習ログを扱い、感情・文脈・気づきを含む「物語」を未来の自分に残すことを目指します。

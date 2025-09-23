# Notification System Guide

*Last updated: 2025-09-18*

Gemini CLIの通知機構（`webnew/notify`）に関する詳細手順をまとめます。ユーザーから「通知が多い」「通知を調整したい」と要望があった場合、`GEMINI.md` では概要を案内し、ここから詳細を参照します。

## 運用方針
- 目的ベース。intent/typeは廃止し、状況から最適な目的を1件選定。
- 入力材料: 現在時刻、`policy/rules.json`, `schedule/triggers.json`, 直近の送信履歴、必要に応じ`manage_log.py`から取得する学習コンテキスト。
- 出力制約: 純粋なJSON、`title <= 40`, `body <= 120`, 日本語、`action_url`, `tag`, `category` 必須、PII禁止。
- ガード: 静音時間、1日上限、重複抑制、直近ターンの猶予を遵守。

## ファイル構成
```
webnew/notify/config/
├─ policy/rules.json          # 通知ポリシー
├─ schedule/triggers.json     # cron & AIポーリング設定
├─ prompts/notify.system.txt  # 目的/プロンプトの正本
└─ intents/catalog.json       # 参考用（原則非推奨）
```
その他:
- 送信ログ: `webnew/mnt/notifications.json`
- Push購読: `webnew/mnt/push_subscriptions.json`
- VAPID鍵: `webnew/mnt/vapid.json`

## 目的カテゴリ例
- 学習促進 / 休憩フォロー / 試験準備 / 振り返り / 会話継続 / モチベ維持。
- 最新リストは `prompts/notify.system.txt` で管理。ここを正本とし、`GEMINI.md`からリンク。

## APIエンドポイント
- `POST /api/notify/decide` → `{ decision: send|skip, reason?, notification? }`
- `POST /api/notify/send` → `{ userId, notification }` を受け取り、WS通知 + WebPush + ログ保存。
- WebPush専用: `GET /api/push/vapidPublicKey`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`。

## 設定変更手順
1. 対応するJSON/TXTを直接編集するか、ユニファイドdiffを作成。
2. 変更出力形式は以下で統一（Markdown禁止）。
   ```diff
   *** Begin Patch
   *** Update File: webnew/notify/config/schedule/triggers.json
   @@
   -  "cron": "0 20 * * *",
   +  "cron": "0 21 * * *",
   *** End Patch
   ```
3. 複数ファイルも同一 `*** Begin Patch` ブロック内に列挙可能。
4. `triggers.json` はホットリロード対応だが、`rules.json` / プロンプト更新時は適用タイミングを確認。

## よくあるオペレーション
- **通知過多への対応:** `rules.json` の cap/pacing を確認 → 必要時に値を引き下げる。
- **通知が来ない:** 静音時間や `grace_after_last_turn_minutes` を超えているか確認。ログ (`notifications.json`) で送信結果を追跡。
- **新しい目的を追加:** `notify.system.txt` に目的定義を追加、`rules.json` で対象目的の出力ポリシーを設定。

## notify_tool.py（AI自律通知フロー）
- **概要:** `notify_tool.py` は AI が隠蔽プロンプト経由で能動的に通知を送るためのワンショットコマンド。AIはリマインダーが届いた際など、自身の判断でこのツールを用いて通知を自律的に送信できる。標準の `/api/notify/decide` を経由せず、通知本文の作成・送信までを AI が完結させる。
- **呼び出し契機:** リマインダー (`reminder_due` イベント) をサーバーが受信すると、hidden prompt で AI にハンドオフする（本文は `[System] 設定されたリマインダーが届きました。` に続き、リマインダーと現在時刻、そして現行モード情報 `context_state` を含む JSON をそのまま渡すだけ）。必要なネクストアクションはリマインダー作成時点で `context` や `meta` に含めておく。
- **実行と制御:** 順次処理キュー化と Busy 表示 (`notifyBusy.reason = 'reminder'`) は `webnew/server.js` が管理し、ツールの実行可否は AI に委ねる。
- **API と挙動:**
  - コマンドは `/api/notify/tool/send` に POST を行う。必要項目は `origin`, `notification`, `context`。
  - `notification` は従来の JSON 形式（`title`, `body`, `action_url`, `tag`, `category` 等）。文字数制約はなし。
  - `context` には `reminder_id`, `reasoning`, `inputs.fire_at` など判断に使った情報を格納し、ログ (`notify.log_append`) と `ai_reminders.meta.notify_tool` に転記される。
- **失敗時:** コマンドは stdout に `{"ok": false, "error": "..."}` を返し非ゼロ終了。stderr はそのまま AI に届くため、AI がリトライや `ai.reminder_update` の再実行を選択できる。
- **人手でのテスト例:**
  ```bash
  python3 notify_tool.py '{
    "origin": "ai_reminder",
    "notification": {
      "title": "数学模試までの準備チェック",
      "body": "2025-09-25 09:00 実施。公式確認と過去問1回分を今日中に終了。",
      "action_url": "/schedule",
      "tag": "exam",
      "category": "study"
    },
    "context": {
      "reminder_id": "manual-test",
      "reasoning": "リマインダー到来時刻、準備物が未完了"
    }
  }'
  ```
  成功すると JSON レスポンス（`{ ok: true, delivered: ... }`）が返る。
- **備考:**
  - `notify_tool.py` はデフォルトで `https://127.0.0.1:443` → `http://127.0.0.1:3000` の順にエンドポイントを探索。必要なら `NOTIFY_TOOL_ENDPOINT` などの環境変数で上書き。
  - ツール呼び出し中はチャット入力がロックされ、「リマインダーを処理中です…」の文言が表示される。
  - リマインダー送信後はサーバーが `ai.reminder_update` を実行して `status: dispatched` とメタ情報を確定させる。
  - AIが通知内容を生成する際は、会話コンテキスト、現在のモード、関連ドキュメント、そして `manage_log.py` を用いて取得する学習記録など、包括的な情報を考慮し、ユーザーに寄り添ったパーソナライズされたメッセージを作成する。

## 今後のタスク候補
- 目的ごとのKPI計測（送信数・反応率）をダッシュボードへ反映。
- 週次で通知ログを要約し、`GEMINI.md` にミニレポートとして貼れるテンプレ作成。

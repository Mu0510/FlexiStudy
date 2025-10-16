# Background Gemini Limitations and Current Pain Points

このドキュメントでは、バックグラウンド Gemini の現行実装が抱えている制約と、それがプロンプト仕様や運用に与えている影響を整理します。ユーザーから「なぜ許可済みツールを直接呼び出す運用が機能しないのか？」という指摘を受け、現状を冷静に把握するためにまとめました。

## シングルターン完結モデル

- `webnew/server.js` 内の `processNotifyDecision` / `handleContextEventPromptResult` などを見ると分かる通り、バックグラウンド Gemini への問い合わせは **単発の `promptText` 呼び出しで完結** します。モデルのレスポンスを受け取った後に追加で同じリクエストへ返信させる処理は存在しません。【F:webnew/server.js†L4203-L4272】【F:webnew/server.js†L1531-L1604】
- そのため、レスポンス内に `actions` を列挙しても、同じターンで結果を検証したり、結果を踏まえて再度 Gemini を呼び出したりする流れは実装されていません。調査が必要な場合はレスポンス前に CLI ツールを直接呼び出し、`actions` はサーバーへ委任する最終処理に限定する設計へ改める必要があります。

## ツール出力が履歴に残らない

- `prepareHistoryDelta` では `shouldExcludeHistoryEntryForDelta` によって `role === 'tool'` のメッセージや大きな差分が除外されます。これにより、通知プロセスの途中でスクリプトを実行しても、その結果は後続の `history_delta` でモデルに渡されません。【F:webnew/server.js†L2333-L2392】
- CLI のツール実行で得た結果は同一ターン内でのみ参照できるため、その場で要約して `analysis` や `evidence` に書き残す運用が必須です。

## 影響

1. **単発ターン内で完結する調査が必須**: `manage_log.py` や `context.*` 系 RPC を `actions` に列挙しても自動実行されないため、必要な情報は CLI のツール呼び出しで取得し、同じターンで判断まで行う必要があります。
2. **プロンプト仕様の明確化が必要**: 初期プロンプトではツール実行が同期的に結果を返すこと、`actions` を調査に使わないことを明示しておかないと、モデルが実現できない行動計画を生成してしまいます。
3. **再起動やエラー時の追跡が困難**: ツール出力が履歴に残らないため、なぜある通知が `defer` になったのかを後から振り返るのが難しく、デバッグコストが高くなります。結果の要約をレスポンスに必ず残すルールが必要です。

## 取れる対策の方向性

| 方針 | 概要 | メリット | 課題 |
| --- | --- | --- | --- |
| A. ドキュメントで制約を明示 | モデルに「結果は履歴に残らないが、同ターンでツール結果を読める」ことを教え、CLI ツールで調査させる | 仕様の齟齬を減らせる | 応答 JSON への要約記録を徹底する運用が必要 |
| B. `actions` 実行後に再プロンプトするループを実装 | `decision:"defer"` を受け取ったらアクションを実行し、その結果を含む新リクエストを生成 | モデルが自律的に調査できる | 実装コストが大きく、historyDelta フィルタの見直しも必要 |
| C. ツール出力の要約を `history_delta` に残す | 実行結果を軽量化した形で履歴に入れ直す | モデルが結果を参照できる | 上限管理や要約品質の設計が必要 |

現状は方針 A を採用し、初期プロンプトでツール実行の前提と履歴に残らない点を明記しました。あわせて、起動時にコンテキストモード辞書を注入してモード名だけで推論できるよう改善済みです。今後 B/C を検討する際の参考情報として本メモを残します。

## 最近の改善点

- `webnew/server.js` でバックグラウンド通知ペイロードに `usage` / `schedule` を追加し、静音時間・通知上限・残り枠・ポーリング抑制状態をモデルへ直接共有するようにしました。これにより `control.next_poll_*` や `control.resume_at` で次回 AI ポーリング時刻を指定できます。【F:webnew/server.js†L4479-L4537】【F:webnew/server.js†L4538-L4550】
- 同ファイルでは日次上限到達時の自動抑制 (`suppressAiPollUntil`) と、静音終了前に少し早めに再開させるリードタイム (`QUIET_PLAN_LEAD_MINUTES`) を導入し、通知枠の計画を立てる余裕を確保しました。【F:webnew/server.js†L724-L781】【F:webnew/server.js†L798-L822】
- 初期プロンプト `background.gemini.initial.prompt.md` も更新し、`plan` フィールドで当日の通知計画を返すことや、`schedule.polling` の抑制情報を読んで `control` で次回ポーリングを指定する運用を明文化しました。【F:webnew/notify/config/prompts/background.gemini.initial.prompt.md†L12-L36】【F:webnew/notify/config/prompts/background.gemini.initial.prompt.md†L63-L111】

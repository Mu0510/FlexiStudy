# Gemini CLI - タスク引き継ぎ資料

## 1. 全体目標

*   UIコンポーネントのダークモード対応完了。
*   チャットUIの改善: ファイル添付表示、スクロールベースの履歴読み込み、および自動スクロール動作の洗練。

## 2. 現在の最優先課題

**ダークモード対応に起因するライトモードのスタイル破壊の修正**

`study-records.tsx`のダークモード対応を行った際、ライトモードのスタイルが破壊される問題が発生しました。これは、ライトモード用の固定色指定クラスを、`dark:`プレフィックスを付けずにテーマ追従クラスに置き換えてしまったことが原因です。

同様の問題が、これまでダークモード対応を行った他のすべてのコンポーネントで発生している可能性があります。

**修正方針:**
各コンポーネントのライトモード時のスタイル指定（例: `bg-white`, `text-slate-800`）を元に戻し、`dark:`プレフィックスを使用してダークモード用のスタイルを別途指定します。（例: `className="bg-white dark:bg-card"`）

**影響範囲の可能性があるコンポーネントリスト:**
*   `webnew/components/dashboard.tsx`
*   `webnew/components/sidebar.tsx`
*   `webnew/components/mobile-header.tsx`
*   `webnew/components/settings.tsx`
*   `webnew/components/new-chat-panel.tsx`
*   `webnew/components/tool-card.tsx`
*   `webnew/components/tool-card-item.tsx`
*   `webnew/components/study-records.tsx` (修正済み)

## 3. 完了したタスク

### a. 目標開始機能とチャット連携 (c5591ea, 57549fb)
- **内容:**
  - 「今日の目標」カードの「開始」ボタンをクリックすると、フローティングチャットパネルが開き、選択された目標の情報（タスク名、教科など）がチャット入力欄の上に表示されるようになりました。
  - 表示された目標情報は、「×」ボタンでクリアできます。
  - 目標が選択された状態でメッセージを送信すると、その目標情報がシステムメッセージとしてAIに送信され、学習開始のコンテキストが共有されます。
- **影響範囲:**
  - `webnew/components/daily-goals-card.tsx`
  - `webnew/components/study-records.tsx`
  - `webnew/app/page.tsx`
  - `webnew/components/new-chat-panel.tsx`
  - `webnew/hooks/useChat.ts`

### b. アプリケーション時刻のJST（日本標準時）統一 (4cfeada)
- **内容:**
  - これまでUTCとJSTが混在していた学習ログのタイムスタンプを、JSTに統一しました。
  - `manage_log.py`がデータベースにJSTで時刻を記録するように修正しました。
  - これにより、ダッシュボードや学習記録に表示されるすべての時刻がJSTに基づいたものになります。
- **影響範囲:**
  - `manage_log.py`
  - `webnew/server.js` (目標開始機能のバックエンド処理も同時に修正)

### c. フロントエンドの日付処理のタイムゾーン修正 (054e7b9)
- **内容:**
  - 学習記録の初期表示日が、JSTの深夜帯においてUTC基準で前日になってしまう問題を修正しました。
  - `page.tsx`および`study-records.tsx`において、`new Date()`で日付を扱う際に`toISOString()`を使わず、JSTの年月日を直接取得する方法に変更しました。
- **影響範囲:**
  - `webnew/app/page.tsx`
  - `webnew/components/study-records.tsx`

## 4. 今後のタスク

1.  **[最優先] 上記コンポーネントのスタイル破壊の確認と修正**
2.  **[未着手] `analytics.tsx` のダークモード対応**
3.  **[未着手] `exam-analysis.tsx` のダークモード対応**
4.  **[保留中] チャットUIの自動スクロールの問題解決**
    *   メッセージ受信時の自動スクロールが不安定な状態。
    *   `webnew/components/new-chat-panel.tsx`の`useLayoutEffect`内のロジックを再検討する必要がある。

## 5. 主要な知識

*   プロジェクトは、`webnew/`にNext.js/ReactチャットUIを持つGemini CLIアプリケーションです。
*   WebSocket (`webnew/server.js`) がクライアント-サーバー間の通信に使用されます。
*   ファイルアップロードは`webnew/app/api/upload/route.ts`で処理され、1GBの制限があります。
*   `webnew/hooks/useChat.ts`がクライアント側のチャット状態とWebSocketを管理します。
*   `webnew/components/new-chat-panel.tsx`が主要なチャットUIコンポーネントです。
*   ファイル添付情報は`[System]`メッセージを介してAIに伝えられます。
*   履歴読み込みは、初回30メッセージ、以降20メッセージずつロードされます。

## 6. ファイルシステムの状態

*   **MODIFIED: `webnew/components/study-records.tsx`**
    *   ダークモード対応時のスタイル破壊を修正済み (`0e0cb96`)。
*   **MODIFIED: `webnew/components/new-chat-panel.tsx`, `tool-card.tsx`, `tool-card-item.tsx`**
    *   ダークモード対応済みだが、ライトモードのスタイルが破壊されている可能性があるため要確認。
*   **MODIFIED: `webnew/hooks/useChat.ts`**
    *   `Message`インターフェースを`files`を含むように拡張し、`sendMessage`がファイルデータを処理するように更新。
    *   `isFetchingHistory`と`historyFinished`をUI状態管理のためにエクスポート。
    *   `activeMessage`の処理ロジックを修正済み。
*   **MODIFIED: `webnew/server.js`**
    *   `sendUserMessage`がAI向けにファイル詳細を含む`[System]`メッセージを構築するように変更。
    *   `thought`メッセージが`streamAssistantMessageChunk`によって上書きされるバグを修正。
*   **MODIFIED: `webnew/app/api/upload/route.ts`**
    *   アップロードAPIの応答を、アップロードされた各ファイルの`name`、`path`、`size`を含む`files`配列を含むように変更。
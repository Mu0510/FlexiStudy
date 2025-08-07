# 技術スタック

このプロジェクトは、主にPythonとJavaScript/TypeScriptを組み合わせて開発されています。

## 主要な技術

*   **CLI / 学習記録システム:**
    *   **言語:** Python 3
    *   **データベース:** SQLite (`study_log.db`)
    *   **データベース操作:** `manage_log.py` (Pythonスクリプト) が一元管理
*   **Web学習ダッシュボード:**
    *   **フロントエンド:** Next.js (React, TypeScript) - `webnew/` ディレクトリ
    *   **バックエンド:** Node.js (Express.js) - `webnew/server.js`
    *   **データ連携:** `webnew/server.js` が `manage_log.py` を呼び出し、JSON形式で学習データを取得
*   **パッケージ管理:**
    *   Node.js: npm (またはpnpm, `pnpm-lock.yaml`が存在するため)
    *   Python: 標準ライブラリ、または`requirements.txt`に記載されたもの（現時点では確認できていません）
*   **その他:**
    *   ファイル削除の安全性確保のため `trash-cli` を導入
    *   Gitによるバージョン管理

## 開発環境

*   **OS:** Linux

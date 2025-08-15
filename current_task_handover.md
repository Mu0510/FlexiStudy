# プロジェクト引き継ぎ資料

## 1. 現在の状況

### 1.1. プロジェクト目標
Gemini CLIの音声インターフェース（手ぶら対話）の実装。

### 1.2. これまでの経緯と課題 (要約)
1.  **Python音声処理(失敗):** `pyaudio`と`webrtcvad`を直接使う方法は、ユーザー環境で解決不能なハングアップを引き起こしたため破棄。
2.  **C++サーバーへの転換:** 安定性を求め、`whisper.cpp`に同梱されているC++製の`server.exe`を音声認識バックエンドとして利用する方針に転換。
3.  **GPU高速化:** CPUのみでは低速だったため、OpenVINOを使い内蔵GPUでの高速化を目指す。ユーザーは`whisper.cpp`のOpenVINO対応版のビルドに成功。
4.  **DLL問題の解決:** 起動に必要なOpenVINOのDLLファイル群を、ユーザーが`server.exe`と同じディレクトリにコピーし、解決済み。
5.  **モデル互換性問題:**
    *   標準の`ggml`モデルはOpenVINOバックエンドでは使用不可だった。
    *   次に、Intel公式が提供する変換済みOpenVINOモデルをダウンロードしたが、`server.exe`のバージョンと互換性がなく`invalid model data (bad magic)`エラーで失敗。

### 1.3. 現在の状況と最重要課題
- **戦略の再決定:** 外部の変換済みモデルに頼るのではなく、**「自分たちの環境で、今ある`server.exe`と100%互換性のあるモデルを自作する」**という、最も確実な初期方針に回帰した。
- **最重要課題:** モデル変換用Pythonスクリプト(`convert-whisper-to-openvino.py`)の実行に必要なライブラリ(`openvino-dev`等)が、ユーザーの最新Python 3.13環境と互換性がなく、インストールに失敗している。

---

## 2. 今後の計画 (最終確定版)

現在の最重要課題である「Python環境問題」を解決し、モデルを自作して高速なサーバーを起動するための、詳細な最終計画は以下の通りです。

### ステップ1：クリーンな仮想環境の準備
*目的：依存関係の衝突を完全に回避する。*

1.  **仮想環境の非アクティブ化:**
    ```bash
    deactivate
    ```
2.  **古い仮想環境の削除:**
    ```bash
    rm -rf venv_openvino
    ```
3.  **新しい仮想環境の作成:**
    ```bash
    python -m venv venv_openvino
    ```
4.  **新しい仮想環境の有効化:**
    ```bash
    source venv_openvino/Scripts/activate
    ```

### ステップ2：ビルドツールのバージョンを固定してインストール【最重要】
*目的：Python 3.13との互換性問題を回避する。*

1.  **pipのアップグレード:**
    ```bash
    python -m pip install --upgrade pip
    ```
2.  **setuptoolsのバージョンを固定:**
    ```bash
    python -m pip install setuptools==65.5.1
    ```

### ステップ3：変換に必要なライブラリのインストール
*目的：固定されたビルドツールの上で、変換ライブラリをインストールする。*

```bash
python -m pip install -r models/requirements-openvino.txt
```

### ステップ4：モデルの変換
*目的：`whisper.cpp`と完全互換のOpenVINOモデルを生成する。*

```bash
python models/convert-whisper-to-openvino.py --model small --output-dir models/openvino
```

### ステップ5：自作モデルでサーバーを起動
*目的：生成したモデルを使い、GPUで高速化されたサーバーを起動する。*

1.  **実行ディレクトリへ移動:**
    ```bash
    cd build/bin/Release/
    ```
2.  **サーバー起動:**
    ```bash
    ./server.exe -m ../../../models/openvino/whisper-small-encoder.xml --ov-e-device GPU
    ```

---
**次に再開する際は、上記の「ステップ1」から順に実行してください。**

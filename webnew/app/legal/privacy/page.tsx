export const metadata = { title: "プライバシーポリシー" };
import { PwaBackHeader } from "@/components/pwa-back";

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
      <PwaBackHeader />
      <h1 className="text-2xl font-bold">プライバシーポリシー</h1>

      <section>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          本ポリシーは、本アプリにおける情報の取り扱いを定めるものです。本アプリは「ローカルファースト」を前提としており、原則としてユーザーの端末（またはユーザーが自己管理する自己ホスト環境）内で処理・保存されます。開発者がユーザーデータを収集する設計にはしていません。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">1. 取得する情報</h2>
        <ul className="list-disc pl-6 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <li>ユーザー入力情報（テキスト、添付ファイル、音声の文字起こし等）</li>
          <li>利用ログ（送受信のタイムスタンプ、エラー、パフォーマンス計測値）</li>
          <li>端末・環境情報（ブラウザ・OS、Cookie、LocalStorage、PWAキャッシュ、ローカルDB等）</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold">2. 取得方法</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          本アプリ上での入力、音声認識、クライアントログ、ローカル保存（IndexedDB/Cache/SQLite等）を通じて、ユーザー端末もしくは自己ホスト環境内で生成・保存されます。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">3. 利用目的</h2>
        <ul className="list-disc pl-6 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <li>本アプリの提供・維持・改良</li>
          <li>不具合対応、セキュリティ確保、品質向上</li>
          <li>ユーザーからの問い合わせ対応</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold">4. 第三者提供・外部サービス連携</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          開発者がユーザーデータを第三者へ提供することはありません。ユーザーが外部サービス（例：Web検索、AI推論API等）を自ら有効化・設定した場合に限り、当該機能の実行に必要な最小限のデータ（検索クエリや文脈の一部など）が、ユーザーが設定した接続先へ送信されることがあります。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">5. 委託</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          ユーザーが自己ホストする場合、インフラ管理はユーザーの責任となります。開発者がホスティングを提供する設計ではありません。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">6. 保存期間・削除</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          データは利用目的の達成に必要な範囲で保存します。ユーザーは、アプリ内の機能や問い合わせにより、保存データの削除を求めることができます。ローカルに保存されたデータ（PWAキャッシュ等）は、ブラウザのストレージ削除操作でも消去できます。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">7. 安全管理措置</h2>
        <ul className="list-disc pl-6 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <li>通信の暗号化、アクセス制御、権限分離</li>
          <li>ログの最小化、不要データの削除（ユーザー環境内での実施）</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold">8. ユーザーの権利</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          ユーザーは、保有個人データの開示・訂正・削除・利用停止を求めることができます。詳細は本ページ末尾の窓口にご連絡ください。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">9. 未成年の利用</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          未成年のユーザーは、法定代理人の同意のもとで利用してください。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">10. 改定</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          本ポリシーは、必要に応じて改定することがあります。重要な変更はアプリ内掲示等で通知します。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">11. お問い合わせ</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          本ポリシーに関するお問い合わせは、アプリ内のサポート窓口よりご連絡ください。
        </p>
      </section>
    </div>
  );
}

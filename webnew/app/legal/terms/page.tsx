export const metadata = { title: "利用規約" };
import { PwaBackHeader } from "@/components/pwa-back";

export default function TermsPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
      <PwaBackHeader />
      <h1 className="text-2xl font-bold">利用規約</h1>

      <section>
        <h2 className="text-lg font-semibold">1. 定義</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          本規約は、個人開発者（以下「開発者」）が公開する本ソフトウェア／アプリケーション（以下「本アプリ」）の利用条件を定めるものです。利用者を「ユーザー」といいます。「AIエージェント」とは、本アプリ内でユーザーの指示に基づき自動処理・提案・実行を行う機能を指します。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">2. 規約への同意</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          ユーザーは、本規約に同意したうえで本アプリを利用するものとします。未成年のユーザーは、親権者等の法定代理人の同意を得た上で利用してください。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">3. 提供内容（コンセプト／ローカル運用）</h2>
        <ul className="list-disc pl-6 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <li>本アプリは「本当の意味でのあなた専用の勉強管理アプリ」をコンセプトとし、Geminiを秘書として学習計画・記録・助言・自動化を支援します。</li>
          <li>ユーザーは自分の端末で本アプリをローカル実行することを前提とし、必要に応じてローカルサーバーを自己ホストし、VPN等で外部からアクセスする構成も選択できます。</li>
          <li>学習ログの記録・可視化、チャット、音声入力、ファイル添付、PWA/オフライン等の機能を提供します。</li>
          <li>AIエージェントは、ユーザーの要望に基づき本アプリの機能・UI・スクリプト等の「実装支援」も行い、ユーザー環境に合わせてカスタマイズ可能です。</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold">4. オフライン機能について</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          本アプリは恒常的なオフライン動作の提供を前提としません。ブラウザやPWAの仕組みにより一部の画面がオフラインで表示される場合がありますが、これを保証するものではありません。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">5. AIエージェントの権限と注意点</h2>
        <ul className="list-disc pl-6 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <li>本アプリの設計上、AIエージェントは広範な権限を持ち得ます（ローカルデータへのアクセス、ファイル操作、スクリプト実行、自己ホスト環境における外部通信の実行など）。これらはユーザーの操作・設定・同意に基づき有効化・実行されます。</li>
          <li>AI出力は完全性・正確性を保証しません。提案・説明・生成物には誤りや不適切な内容が含まれ得ます。</li>
          <li>AIのツール実行については、ユーザーが設定で「自動許可（YOLO）」と「実行前に確認」を切り替えられる方針です。自動許可モードでは確認なしに実行され得ることを理解の上で利用してください。確認モードでは重要な操作のみ承認を求めます（対象は設定で調整可能とします）。</li>
          <li>最終的な適用可否・レビューはユーザーの責任で行ってください。AIの提案・実装支援・自動処理の結果につき、開発者は責任を負いません。</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold">6. 禁止事項</h2>
        <ul className="list-disc pl-6 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <li>法令または公序良俗に違反する行為</li>
          <li>第三者の権利・プライバシーを侵害する行為</li>
          <li>本アプリや関連サーバに過度な負荷を与える行為、リバースエンジニアリング</li>
          <li>不正アクセス、マルウェア等の配布・実行</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold">7. 知的財産</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          本アプリおよび提供コンテンツに関する知的財産権は開発者または権利者に帰属します。ユーザー投稿（テキスト、ファイル等）はユーザーに権利が帰属しますが、ユーザー端末内での保存・表示・バックアップ等、本アプリの機能提供に必要な範囲で利用されます。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">8. 免責事項（ローカルファースト）</h2>
        <ul className="list-disc pl-6 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <li>本アプリは現状有姿で提供され、特定目的適合性・完全性・無謬性等を保証しません。</li>
          <li>ユーザー環境（端末設定、自己ホスト構成、ネットワーク、外部サービス設定等）に起因する不具合・損害について、開発者は一切の責任を負いません。</li>
          <li>AIの出力・動作、学習成果、データ消失、第三者との紛争、逸失利益等について、開発者は一切の責任を負いません。</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold">9. 責任制限</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          本アプリは個人開発の無償ソフトウェアであり、開発者の責任は法令上許容される最大限において免責されます。有償提供が将来発生する場合でも、責任は直接かつ通常の損害に限られ、当該月にユーザーが支払った対価額を上限とします。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">10. 提供の変更・中断・終了</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          開発者は、必要に応じて本アプリの内容変更、メンテナンス、提供の中断・終了を行うことができ、これに伴い発生した損害について責任を負いません。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">11. アップデートおよび移行</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          関連ソフトウェアのアップデートに伴い仕様変更が必要となった場合、ユーザー環境ごとに実装状況が異なることを前提に、変更点と対応手順を記したガイド（Markdown等）を提示し、AIエージェントに当該ガイドを読み込ませて自動実装・移行を支援する運用を行います。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">12. 準拠法・裁判管轄</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          本規約は日本法に準拠し、紛争は開発者の居住地を管轄する裁判所を第一審の専属的合意管轄とします。
        </p>
      </section>
    </div>
  );
}

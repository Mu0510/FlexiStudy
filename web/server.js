const express   = require('express');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const { spawn, exec } = require('child_process');
const WebSocket = require('ws');

const PORT       = 5000;
const IPC_DIR    = '/home/geminicli/GeminiCLI/web/ipc'; // この行は残すが、実際には使わない

// 1分あたりのトークン上限（Free Tierの場合）
const TOKENS_PER_MINUTE_LIMIT = 250000;
const MILLIS_PER_TOKEN = 60000 / TOKENS_PER_MINUTE_LIMIT;

// 前回のリクエスト時間
let lastRequestTime = 0;

const app    = express();

// index.html の Content-Type を明示的に設定
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Pythonスクリプトを実行するエンドポイント
app.get('/run-python-script', (req, res) => {
  const date = req.query.date;
  const pythonScriptPath = '/home/geminicli/GeminiCLI/manage_log.py';
  const command = `python3 ${pythonScriptPath} logs_json_for_date ${date}`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      return res.status(500).send(stderr);
    }
    res.json(JSON.parse(stdout));
  });
});

// トークン数を見積もる簡易関数
function estimateTokensFromText(text) {
  return Math.ceil(text.length / 4); // 英語なら4文字で1トークン程度
}

// トークン数に応じて待機する関数
async function waitForTokenCooldown(estimatedTokens) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  const neededDelay = estimatedTokens * MILLIS_PER_TOKEN;
  const remainingDelay = neededDelay - elapsed;

  if (remainingDelay > 0) {
    console.log(` Waiting ${Math.ceil(remainingDelay)}ms before next request...`);
    await new Promise(res => setTimeout(res, remainingDelay));
  }

  lastRequestTime = Date.now();
}

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();
const history = [];          // メモリ上の簡易ログ（最新が末尾）

let ongoingText = '';

/* ── ① ユーティリティを追加 ───────────────────────── */
function broadcast(json){
  const str = JSON.stringify(json);
  for (const ws of clients)
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
}
function broadcastExcept(sender, json){
  const str = JSON.stringify(json);
  for (const ws of clients){
    if (ws === sender) continue;                 // ← 送信元だけスキップ
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}
function resetHistory(reason='manual'){
  history.length = 0;                    // 配列を空に
  broadcast({ jsonrpc:'2.0', method:'historyCleared', params:{ reason } });
}

/* ──────────────────────────────────────────────── */

const GEMINI_ARGS = [
  '-m', 'gemini-2.5-flash',
  '-y',
  '--experimental-acp'
];

let geminiProcess;

function startGemini() {
  if (geminiProcess) {
    console.log('Killing existing Gemini process...');
    geminiProcess.kill();
  }

  console.log('Starting new Gemini process...');
  geminiProcess = spawn('gemini', GEMINI_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], cwd: path.join(__dirname, '..') });

  let buf = '';
  geminiProcess.stdout.on('data', data => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { msg = { stdout: line }; }

      // streamAssistantMessageChunk 以外のメッセージが来た場合、
      // ongoingText に溜まっているAIのテキストがあれば、ここで履歴に保存する
      if (msg.method !== 'streamAssistantMessageChunk' && ongoingText.length > 0) {
          const rec = { id:String(Date.now()), ts:Date.now(),
                       role:'assistant', text:ongoingText.trimEnd() };
          history.push(rec);
          console.log('[History] Saved assistant message (before other message):', rec);
          ongoingText = ''; // クリア
      }

      /* 1) AI チャンクなら一旦バッファに溜める */
      if (msg.method === 'streamAssistantMessageChunk') {
          const { chunk: c } = msg.params || {};
          if (c?.text) {
              ongoingText += c.text;
          }
          // ★追加★ thought があれば、thoughtChunk としてクライアントに送信
          if (c?.thought) {
              broadcast({ jsonrpc: '2.0', method: 'streamAssistantThoughtChunk', params: { thought: c.thought } });
          }
          broadcast(msg); // クライアントへライブ表示用
          continue;
      }

      // 完了通知
      const methodsToExclude = ['initialize', 'requestToolCallConfirmation', 'updateToolCall'];
      if ((msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted' || (msg.result !== undefined && msg.result !== null)) && !methodsToExclude.includes(msg.method)) {
          // ongoingText が空でない場合にのみ履歴に保存
          if (ongoingText.length > 0) {
              const rec = { id:String(Date.now()), ts:Date.now(),
                           role:'assistant', text:ongoingText.trimEnd() };
              // ② 完成形をクライアントへ送る
              broadcast(rec);
          }

          // ④ 既存の完了通知も送信 (必要なら)
          broadcast(msg);
          continue;
      }

      /* 3) これまで通り user / system 行を保存 */
      if (msg.role && msg.text) {
          history.push({ ...msg, id: (msg.id !== undefined && msg.id !== null) ? String(msg.id) : String(Date.now()) });
      }
      // ── Agent → Client の updateToolCall を処理 ──
      if (msg.method === 'updateToolCall') {
        broadcast(msg);                               // UI へ

        // ★★ ここが必須 ★★ : Agent へ応答を返す
        geminiProcess.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          id:      msg.id,       // 受信した id
          result:  null          // void 応答
        }) + '\n');

        history.push({ ...msg, ts: Date.now(), type:'tool' });
        return;
      }
      else if (msg.method === 'pushToolCall') {
          // pushToolCall も履歴に保存
          history.push({
              ...msg,
              ts: msg.ts || Date.now(), // タイムスタンプがなければ新規作成
              type: 'tool'             // フロントエンドで判別しやすいように type を追加
          });
      }
      else if (msg.method === 'requestToolCallConfirmation') {
          // ツール関連のメッセージも、タイムスタンプとtypeを追加して履歴に保存
          history.push({
              ...msg,
              ts: msg.ts || Date.now(), // タイムスタンプがなければ新規作成
              type: 'tool'             // フロントエンドで判別しやすいように type を追加
          });
      }

      broadcast(msg);   // 既存の配信
    }
  });

  geminiProcess.stderr.on('data', data => {
    console.error('[Gemini ERROR]', data.toString());
  });

  geminiProcess.on('close', code => {
    console.log('Gemini exited with code', code);
    resetHistory('gemini-exit'); // CLI が閉じたらクリア
  });
}

// サーバー起動時にGeminiプロセスを開始
startGemini();

wss.on('connection', ws => {
  clients.add(ws);

  // ── 初回だけ initialize を送るフラグ
  if (!wss._sentInit) {
    const init = {
      jsonrpc: '2.0',
      id:      1,
      method:  'initialize',
      params:  { protocolVersion: '0.0.9' }
    };
    geminiProcess.stdin.write(JSON.stringify(init) + '\n');
    wss._sentInit = true;          // 以後は送らない
  }

  ws.on('message', async data => { // async を追加

    const text = data.toString().trim();
    if (!text) return;

    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      console.error('Failed to parse incoming WebSocket message as JSON:', e);
      // If it's not JSON, treat it as a plain text command
      geminiProcess.stdin.write(text + '\n');
      return;
    }

    // フロントからの “fetchHistory” をここで処理
    if (msg.method === 'fetchHistory') {
      // fetchHistory が呼ばれた時点で ongoingText にAIのレスポンスが蓄積されていれば履歴に保存
      if (ongoingText.length > 0) {
        const rec = {
          id: String(Date.now()),
          ts: Date.now(),
          role: 'assistant',
          text: ongoingText.trimEnd(),
        };
        history.push(rec);
        console.log('[History] Saved assistant message (on fetchHistory):', rec);
        ongoingText = ''; // クリア
      }

      const { limit = 20, before } = msg.params || {};

      let chunk;
      if (!before) {
        // 起動時 or 明示的に before=null なら最新 limit 件をそのまま返す
        chunk = history.slice(-limit);
      } else {
        // スクロール読み込み
      chunk = history
          .filter(rec => rec.ts < before)
          .slice(-limit);
    }

    // タイムスタンプでソートしてから送信
    chunk.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

    return ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id:     msg.id,
      result: { messages: chunk }
    }));
    }

    /* ── ③ クライアント→サーバー受信部 (ws.on 'message') に追記 ── */
    if (msg.method === 'sendUserMessage') {
      const inputText = msg.params?.chunks?.[0]?.text || '';

      // AIのレスポンスが蓄積されていれば履歴に保存
      if (ongoingText.length > 0) {
        const rec = {
          id: String(Date.now()),
          ts: Date.now(),
          role: 'assistant',
          text: ongoingText.trimEnd(),
        };
        history.push(rec);
        console.log('[History] Saved assistant message:', rec);
        ongoingText = ''; // クリア
      }

      /*   /clear コマンド  */
      if (inputText.trim() === '/clear'){
          resetHistory('command');
          startGemini(); // Geminiプロセスを再起動
          return ws.send(JSON.stringify({ jsonrpc:'2.0', id:msg.id, result:null }));
      }

      /*   ユーザ発言を履歴へも保存して broadcast  */
      const rec = { id: String(Date.now()), ts: Date.now(),
                    role:'user', text: inputText };
      history.push(rec);                     // メモリキャッシュ
      broadcastExcept(ws, rec); // 新：送信元以外にだけ送る
    }


    // Gemini CLIへのメッセージ送信前にクールダウンを適用
    if (msg.method === 'sendUserMessage' && msg.params && msg.params.chunks && msg.params.chunks[0] && msg.params.chunks[0].text) {
      const inputText = msg.params.chunks[0].text;
      const estimatedTokens = estimateTokensFromText(inputText);
      await waitForTokenCooldown(estimatedTokens);
    }

    // それ以外は Gemini へパススルー
    geminiProcess.stdin.write(JSON.stringify(msg) + '\n');
  });

  ws.on('close', () => clients.delete(ws));
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Forcing exit...');
  if (geminiProcess) {
    geminiProcess.kill();
  }
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Forcing exit...');
  if (geminiProcess) {
    geminiProcess.kill();
  }
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
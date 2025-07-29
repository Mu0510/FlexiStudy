const express  = require('express');
const https    = require('https');
const path     = require('path');
const fs       = require('fs');
const { spawn, exec } = require('child_process');
const WebSocket = require('ws');

const app = express();

const PORT = 443;
 const IPC_DIR = '/home/geminicli/GeminiCLI/web/ipc';

const server = https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem'))
}, app);

const wss = new WebSocket.Server({ server, path: '/ws' });

server.listen(PORT, () => {
  console.log(`HTTPS + WSS server running on port ${PORT}`);
});


// 1分あたりのトークン上限（Free Tierの場合）
const TOKENS_PER_MINUTE_LIMIT = 250000;
const MILLIS_PER_TOKEN = 60000 / TOKENS_PER_MINUTE_LIMIT;

// 前回のリクエスト時間
let lastRequestTime = 0;


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

let geminiProcess = null; // Initialize to null

function _startNewGeminiProcess() {
  console.log(`Attempting to start Gemini process with command: gemini ${GEMINI_ARGS.join(' ')}`);
  geminiProcess = spawn('gemini', GEMINI_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], cwd: path.join(__dirname, '..') });

  // 新しいGeminiプロセスが起動したらinitializeメッセージを送信
  const init = {
    jsonrpc: '2.0',
    id:      1,
    method:  'initialize',
    params:  { protocolVersion: '0.0.9' }
  };
  geminiProcess.stdin.write(JSON.stringify(init) + '\n');

  geminiProcess.on('error', (err) => {
    console.error('[Gemini SPAWN ERROR]', err);
    // Consider broadcasting an error message to clients here
  });

  console.log(`Gemini process started with PID: ${geminiProcess.pid}`);


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
      console.log('[Gemini CLI Output]', msg);

      // ACP初期化シーケンスの処理
      if (msg.id === 1 && msg.result?.protocolVersion) {
        console.log('[ACP] Initialize successful. Sending startChat...');
        const startChatRequest = {
          jsonrpc: '2.0',
          id: 2, // initialize の次なので id: 2
          method: 'startChat',
          params: {}
        };
        geminiProcess.stdin.write(JSON.stringify(startChatRequest) + '\n');
        // このメッセージはクライアントにブロードキャストする必要はないので、ここで continue
        continue;
      }

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

  geminiProcess.on('close', (code, signal) => {
    console.log(`Gemini exited with code ${code} and signal ${signal}`);
    // Only reset history if it's an unexpected exit, not a planned restart
    if (geminiProcess !== null && geminiProcess.pid === this.pid) { // Check if this is the currently active process
        resetHistory('gemini-exit'); // CLI が閉じたらクリア
        geminiProcess = null; // Clear the reference
    }
  });
}

function startGemini() {
  if (geminiProcess) {
    console.log('Killing existing Gemini process for restart...');
    const oldPid = geminiProcess.pid;
    geminiProcess.on('close', function(code, signal) { // Use 'function' to get 'this' context
      if (this.pid === oldPid) { // Ensure this listener only acts for the process it was attached to
        console.log(`Old Gemini process (PID: ${oldPid}) exited with code ${code} and signal ${signal}. Waiting 1 second before starting new process...`);
        setTimeout(() => {
          _startNewGeminiProcess();
        }, 1000); // 1秒のディレイ
      }
    });
    geminiProcess.kill();
    geminiProcess = null; // Clear reference immediately to prevent new messages going to old process
  } else {
    _startNewGeminiProcess(); // Initial start
  }
}

// サーバー起動時にGeminiプロセスを開始
startGemini();

wss.on('connection', ws => {
  clients.add(ws);

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

    // メソッドに応じて処理を分岐
    switch (msg.method) {
      case 'fetchHistory': {
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
          chunk = history.slice(-limit);
        } else {
          chunk = history.filter(rec => rec.ts < before).slice(-limit);
        }
        chunk.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { messages: chunk }
        }));
        break;
      }

      case 'startChat': {
        // クライアントからのstartChatは無視する
        // Geminiプロセスへは初期化シーケンスの一部としてサーバーから送信するため
        console.log('[DEBUG] Ignoring startChat from client.');
        break;
      }

      case 'sendUserMessage': {
        const inputText = msg.params?.chunks?.[0]?.text || '';

        if (ongoingText.length > 0) {
          const rec = {
            id: String(Date.now()),
            ts: Date.now(),
            role: 'assistant',
            text: ongoingText.trimEnd(),
          };
          history.push(rec);
          console.log('[History] Saved assistant message:', rec);
          ongoingText = '';
        }

        if (inputText.trim() === '/clear') {
          resetHistory('command');
          startGemini();
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
        } else {
          const rec = {
            id: String(Date.now()),
            ts: Date.now(),
            role: 'user',
            text: inputText
          };
          history.push(rec);
          broadcastExcept(ws, rec);

          const estimatedTokens = estimateTokensFromText(inputText);
          await waitForTokenCooldown(estimatedTokens);
          geminiProcess.stdin.write(JSON.stringify(msg) + '\n');
        }
        break;
      }

      default: {
        // その他のメソッドはすべてGeminiへパススルー
        geminiProcess.stdin.write(JSON.stringify(msg) + '\n');
        break;
      }
    }
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


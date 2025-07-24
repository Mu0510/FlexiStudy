const express   = require('express');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const { spawn, exec } = require('child_process');
const WebSocket = require('ws');

const PORT       = 5000;
const IPC_DIR    = '/home/geminicli/GeminiCLI/web/ipc';
const PIPE_IN    = path.join(IPC_DIR, 'gemini_in');
const PIPE_OUT   = path.join(IPC_DIR, 'gemini_out');

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
const assistantBuf = new Map();

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

const inStream  = fs.createReadStream(PIPE_OUT, { encoding: 'utf8' });
const outStream = fs.createWriteStream(PIPE_IN,  { encoding: 'utf8' });

let buf = '';
inStream.on('data', chunk => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { msg = { stdout: line }; }

    /* 1) AI チャンクなら一旦バッファに溜める */
    if (msg.method === 'streamAssistantMessageChunk') {
        const { chunk, messageId } = msg.params;
        const key = messageId;                // ← ★ 元に戻す
        if (chunk.text !== undefined) {
           const entry = assistantBuf.get(key) || { text: '' };
           entry.text += chunk.text.replace(/^[\r\n]+/,'');
           assistantBuf.set(key, entry);
        }
        /* 継続中なのでここで broadcast して return */
        broadcast(msg);                 // クライアントへライブ表示用
        continue;                       // history にはまだ入れない
    }

    /* 2) stream が終わったシグナル (result:null) で保存 */
    if (msg.result === null && assistantBuf.has(msg.id)) {
        const rec = {
           id:   msg.id.toString(),
           ts:   Date.now(),
           role: 'assistant',
           text: assistantBuf.get(msg.id).text.trim()
        };
        history.push(rec);           // ← 履歴には残す
        // broadcast(rec);              // ← ★ 削除：二重表示の原因
        assistantBuf.delete(msg.id);
        /* ここは return しない。以降↓の role&&text も不要なので continue */
        continue;
    }

    /* 3) これまで通り user / system 行を保存 */
    if (msg.role && msg.text) {
        history.push({ ...msg, id: msg.id || Date.now() });
    }

    broadcast(msg);   // 既存の配信
  }
});

/* ── ② Gemini からの行を処理する所で history.push 済み ──
   ……この直後に inStream.on('end') を利用してキャッシュ自動消し …… */
inStream.on('end', ()=> resetHistory('gemini-exit'));   // CLI が閉じたらクリア
/* ──────────────────────────────────────────────── */

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
    outStream.write(JSON.stringify(init) + '\n');
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
      outStream.write(text + '\n');
      return;
    }

    // フロントからの “fetchHistory” をここで処理
    if (msg.method === 'fetchHistory') {
      const { limit = 5, before } = msg.params || {};

      // before = タイムスタンプ。より古いものを limit 件
      const chunk = history
          .filter(rec => before ? rec.ts < before : true)
          .slice(-limit);                 // 配列末尾が最新なので後ろから切り出す

      return ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id:     msg.id,
        result: { messages: chunk }
      }));
    }

    /* ── ③ クライアント→サーバー受信部 (ws.on 'message') に追記 ── */
    if (msg.method === 'sendUserMessage') {
      const inputText = msg.params?.chunks?.[0]?.text || '';

      /*   /clear コマンド  */
      if (inputText.trim() === '/clear'){
          resetHistory('command');
          return ws.send(JSON.stringify({ jsonrpc:'2.0', id:msg.id, result:null }));
      }

      /*   ユーザ発言を履歴へも保存して broadcast  */
      const rec = { id: Date.now().toString(), ts: Date.now(),
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
    outStream.write(JSON.stringify(msg) + '\n');
  });

  ws.on('close', () => clients.delete(ws));
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Forcing exit...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Forcing exit...');
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
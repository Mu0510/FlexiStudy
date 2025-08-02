import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { goal } = body;

    if (!goal) {
      return NextResponse.json({ error: 'Goal data is required' }, { status: 400 });
    }

    // goalオブジェクトをエスケープ処理したJSON文字列に変換
    const goalJsonString = JSON.stringify(JSON.stringify(goal));
    // JSTで今日の日付を取得 (YYYY-MM-DD形式)
    const today = new Date().toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).replace(/\//g, '-');

    const pythonScriptPath = path.resolve(process.cwd(), '..', 'manage_log.py');
    // 新しいコマンド `add_goal_to_date` を呼び出す
    const command = `python3 ${pythonScriptPath} add_goal_to_date ${goalJsonString} ${today}`;

    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          console.error(`stderr: ${stderr}`);
          resolve(NextResponse.json({ error: 'Failed to execute script', details: stderr }, { status: 500 }));
          return;
        }
        try {
          // 成功した場合、stdoutは空か、成功メッセージを含む
          resolve(NextResponse.json({ success: true, message: stdout.trim() }));
        } catch (parseError) {
          console.error(`JSON parse error: ${parseError}`);
          resolve(NextResponse.json({ error: 'Failed to parse script output', details: stdout }, { status: 500 }));
        }
      });
    });
  } catch (e) {
    console.error('API Error:', e);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}

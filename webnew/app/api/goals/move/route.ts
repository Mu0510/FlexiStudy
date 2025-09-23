import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { goal } = body;

    if (!goal) {
      return NextResponse.json({ error: 'Goal data is required' }, { status: 400 });
    }

    const today = new Date().toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).replace(/\//g, '-');

    const pythonScriptPath = path.resolve(process.cwd(), '..', 'manage_log.py');
    const commandPayload = {
      action: 'goal.add_to_date', // アクション名を修正
      params: {
        goal: goal,
        date: today,
      },
    };
    const args = ['--api-mode', 'execute', JSON.stringify(commandPayload)];

    const processPromise = new Promise((resolve, reject) => {
      const pythonProcess = spawn('python3', [pythonScriptPath, ...args]);

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout);
            if (result.status === 'success') {
              resolve(NextResponse.json({ success: true, message: result.message }));
            } else {
              reject(new Error(result.message || 'Python script returned an error'));
            }
          } catch (e) {
            reject(new Error(`Failed to parse python script output: ${stdout}`));
          }
        } else {
          reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        }
      });

      pythonProcess.on('error', (err) => {
        reject(err);
      });
    });

    return await processPromise;

  } catch (e: any) {
    console.error('API Error:', e);
    return NextResponse.json({ error: 'Invalid request body or failed to move goal', details: e.message }, { status: 500 });
  }
}

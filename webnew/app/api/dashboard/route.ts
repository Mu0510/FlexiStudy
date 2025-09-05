import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const weeklyParam = url.searchParams.get('weekly_period');
    const weekly_period = weeklyParam ? Number(weeklyParam) : null;
    const week_start = url.searchParams.get('week_start');
    const pythonScript = path.join(process.cwd(), '../manage_log.py');
    const commandPayload: any = { action: 'data.dashboard', params: {} };
    // manage_logの実装では "days" パラメータのみ対応
    if (weekly_period) commandPayload.params.days = weekly_period;
    // week_start は未対応のため送らない（週次の合計はPython側で月曜起点固定）
    const args = ['--api-mode', 'execute', JSON.stringify(commandPayload)];

    const processPromise = new Promise((resolve, reject) => {
      const pythonProcess = spawn('python3', [pythonScript, ...args]);

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
            const data = JSON.parse(stdout);
            resolve(data);
          } catch (error) {
            reject(new Error('Failed to parse JSON from python script'));
          }
        } else {
          reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        }
      });

      pythonProcess.on('error', (error) => {
        reject(error);
      });
    });

    const data = await processPromise;
    return NextResponse.json(data);

  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

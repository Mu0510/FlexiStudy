import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function GET(
  request: Request,
  context: { params: Promise<{ date: string }> }
) {
  const { date } = await context.params;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Invalid date format. Please use YYYY-MM-DD.' }, { status: 400 });
  }

  const pythonScriptPath = path.resolve(process.cwd(), '..', 'manage_log.py');
  const commandPayload = {
    action: "log.get",
    params: { date: date }
  };
  const args = ['--api-mode', 'execute', JSON.stringify(commandPayload)];

  const promise = new Promise((resolve, reject) => {
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
          const data = JSON.parse(stdout);
          resolve(NextResponse.json(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${stdout}`));
        }
      } else {
        reject(new Error(`Python script exited with code ${code}: ${stderr}`));
      }
    });

     pythonProcess.on('error', (err) => {
        reject(err);
    });
  });

  try {
    return await promise;
  } catch (error: any) {
      console.error(`[API ERROR] /api/logs/[date]:`, error);
      return NextResponse.json({ error: 'Failed to execute script', details: error.message }, { status: 500 });
  }
}

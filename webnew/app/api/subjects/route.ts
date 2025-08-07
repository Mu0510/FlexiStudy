import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function GET() {
  const promise = new Promise((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), '..', 'manage_log.py');
    const commandPayload = { action: 'data.unique_subjects', params: {} };
    const args = ['--api-mode', 'execute', JSON.stringify(commandPayload)];
    
    const pythonProcess = spawn('python3', [scriptPath, ...args]);

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
          const subjects = JSON.parse(stdout);
          resolve(NextResponse.json(subjects));
        } catch (parseError: any) {
          reject(new Error(`Failed to parse subjects: ${stdout}`));
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
    console.error(`[API ERROR] /api/subjects:`, error);
    return NextResponse.json({ error: 'Failed to get subjects', details: error.message }, { status: 500 });
  }
}

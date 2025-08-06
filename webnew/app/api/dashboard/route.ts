import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function GET() {
  try {
    const pythonScript = path.join(process.cwd(), '../manage_log.py');
    const args = ['dashboard_json'];

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
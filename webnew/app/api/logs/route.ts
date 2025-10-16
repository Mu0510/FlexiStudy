import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date');

  if (!date) {
    return NextResponse.json({ error: 'Date parameter is required' }, { status: 400 });
  }

  return new Promise((resolve) => {
    const pythonScriptPath = path.join(process.cwd(), '..', 'manage_log.py');
    const commandPayload = {
      action: "log.get",
      params: { date: date }
    };
    const pythonProcess = spawn('python3', [pythonScriptPath, '--api-mode', 'execute', JSON.stringify(commandPayload)]);

    let data = '';
    let error = '';

    pythonProcess.stdout.on('data', (chunk) => {
      data += chunk.toString();
    });

    pythonProcess.stderr.on('data', (chunk) => {
      error += chunk.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`Python script exited with code ${code}, error: ${error}`);
        return resolve(NextResponse.json({ error: 'Failed to fetch logs', details: error }, { status: 500 }));
      }

      try {
        const jsonData = JSON.parse(data);
        resolve(NextResponse.json(jsonData));
      } catch (parseError) {
        console.error('Failed to parse JSON from Python script:', parseError, 'Raw data:', data);
        resolve(NextResponse.json({ error: 'Failed to parse logs data', details: parseError.message }, { status: 500 }));
      }
    });

    pythonProcess.on('error', (err) => {
      console.error('Failed to start Python process:', err);
      resolve(NextResponse.json({ error: 'Failed to start Python process', details: err.message }, { status: 500 }));
    });
  });
}

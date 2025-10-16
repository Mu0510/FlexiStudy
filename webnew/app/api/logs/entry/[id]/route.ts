import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const logId = Number(id);
  if (!id || Number.isNaN(logId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const pythonScriptPath = path.resolve(process.cwd(), '..', 'manage_log.py');
  const payload = { action: 'log.get_entry', params: { id: logId } };
  const args = ['--api-mode', 'execute', JSON.stringify(payload)];

  try {
    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn('python3', [pythonScriptPath, ...args]);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += String(d)));
      proc.stderr.on('data', (d) => (stderr += String(d)));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) return resolve(stdout);
        reject(new Error(`Python exited ${code}: ${stderr || stdout}`));
      });
    });
    const json = JSON.parse(result || '{}');
    return NextResponse.json(json);
  } catch (e: any) {
    return NextResponse.json({ error: 'Failed to fetch log entry', details: e?.message || String(e) }, { status: 500 });
  }
}


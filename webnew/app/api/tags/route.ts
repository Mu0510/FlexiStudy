import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const prefix = searchParams.get('prefix') || '';
  const limit = searchParams.get('limit') || '';

  const pythonScriptPath = path.resolve(process.cwd(), '..', 'manage_log.py');
  const payload = {
    action: 'data.tags',
    params: { prefix, limit: limit ? Number(limit) : undefined },
  };
  const args = ['--api-mode', 'execute', JSON.stringify(payload)];

  try {
    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn('python3', [pythonScriptPath, ...args]);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) return resolve(stdout);
        reject(new Error(`Python exited ${code}: ${stderr || stdout}`));
      });
    });
    const data = JSON.parse(result);
    return NextResponse.json(data);
  } catch (error: any) {
    console.error('[API ERROR] /api/tags:', error);
    return NextResponse.json({ error: 'Failed to fetch tags', details: error.message }, { status: 500 });
  }
}


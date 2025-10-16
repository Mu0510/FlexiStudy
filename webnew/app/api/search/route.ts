import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from') || undefined;
  const to = searchParams.get('to') || undefined;
  const type = (searchParams.get('type') || 'all').toLowerCase();
  const q = searchParams.get('q') || undefined;
  const tagsParam = searchParams.get('tags') || undefined; // comma separated
  const match = (searchParams.get('match') || 'all').toLowerCase();
  const order = (searchParams.get('order') || 'relevance').toLowerCase();
  const limit = Number(searchParams.get('limit') || '20');
  const offset = Number(searchParams.get('offset') || '0');

  const pythonScriptPath = path.resolve(process.cwd(), '..', 'manage_log.py');
  const payload = {
    action: 'data.search',
    params: { from, to, type, q, tags: tagsParam, match, order, limit, offset },
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
    console.error('[API ERROR] /api/search:', error);
    return NextResponse.json({ error: 'Failed to search', details: error.message }, { status: 500 });
  }
}

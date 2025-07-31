import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';

export async function GET(
  request: Request,
  context: { params: { date: string } }
) {
  const { date } = context.params;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Invalid date format. Please use YYYY-MM-DD.' }, { status: 400 });
  }

  const pythonScriptPath = path.resolve(process.cwd(), '..', 'manage_log.py');
  const command = `python3 ${pythonScriptPath} logs_json_for_date ${date}`;

  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        resolve(NextResponse.json({ error: 'Failed to execute script', details: stderr }, { status: 500 }));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        resolve(NextResponse.json(data));
      } catch (parseError) {
        console.error(`JSON parse error: ${parseError}`);
        resolve(NextResponse.json({ error: 'Failed to parse script output', details: stdout }, { status: 500 }));
      }
    });
  });
}
import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get('mode'); // 'this_week' | 'last_7' (default)
    const week_start = url.searchParams.get('week_start'); // 'sunday' | 'monday'

    let payload: any;
    if (mode === 'this_week') {
      payload = { action: 'data.this_week_study_time', params: { week_start: week_start || 'sunday' } };
    } else {
      payload = { action: 'data.weekly_study_time', params: {} };
    }
    // Next.js の CWD は webnew/ である可能性が高いため、1つ上の manage_log.py を参照
    const scriptPath = path.resolve(process.cwd(), '..', 'manage_log.py');
    const command = `python3 ${scriptPath} --api-mode execute '${JSON.stringify(payload)}'`;
    const { stdout, stderr } = await execAsync(command);

    if (stderr) {
      console.error(`stderr: ${stderr}`);
      return NextResponse.json(
        { error: "Failed to fetch weekly study time" },
        { status: 500 }
      );
    }

    const data = JSON.parse(stdout);
    return NextResponse.json(data);
  } catch (error) {
    console.error(`error: ${error}`);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

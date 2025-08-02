import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';

export async function GET() {
  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), '..', 'manage_log.py');
    exec(`python3 ${scriptPath} unique_subjects`, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        return resolve(NextResponse.json({ error: stderr || error.message }, { status: 500 }));
      }
      try {
        const subjects = JSON.parse(stdout);
        resolve(NextResponse.json(subjects));
      } catch (parseError: any) {
        console.error(`Parse error: ${parseError}`);
        resolve(NextResponse.json({ error: `Failed to parse subjects: ${parseError.message}` }, { status: 500 }));
      }
    });
  });
}

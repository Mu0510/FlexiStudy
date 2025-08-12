import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';

// Define the shape of the data we expect from the Python script
interface SubjectStudyTime {
  subject: string;
  minutes: number;
}

export async function GET() {
  // Path to the Python script
  const scriptPath = path.resolve(process.cwd(), '../manage_log.py');
  const pythonCommand = 'python3';

  // The JSON payload for the execute command
  const payload = {
    action: 'data.study_time_by_subject',
    params: {},
  };

  // The full command to execute
  const command = `${pythonCommand} ${scriptPath} --api-mode execute '${JSON.stringify(payload)}'`;

  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        resolve(NextResponse.json({ error: 'Failed to execute script', details: stderr }, { status: 500 }));
        return;
      }

      try {
        const data: SubjectStudyTime[] = JSON.parse(stdout);
        resolve(NextResponse.json(data));
      } catch (parseError) {
        console.error(`JSON parse error: ${parseError}`);
        resolve(NextResponse.json({ error: 'Failed to parse script output', details: stdout }, { status: 500 }));
      }
    });
  });
}

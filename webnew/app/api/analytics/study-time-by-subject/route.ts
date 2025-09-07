import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from 'path';

const execAsync = promisify(exec);

export async function GET() {
  try {
    // manage_log.py はプロジェクトルート直下。Nextのcwdは webnew/ の可能性が高いため1つ上を参照
    const scriptPath = path.resolve(process.cwd(), '..', 'manage_log.py');
    const command = `python3 ${scriptPath} --api-mode execute '{"action": "data.study_time_by_subject", "params": {}}'`;
    const { stdout, stderr } = await execAsync(command);

    if (stderr) {
      console.error(`stderr: ${stderr}`);
      return NextResponse.json(
        { error: "Failed to fetch study time by subject" },
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

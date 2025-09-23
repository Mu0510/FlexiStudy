import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

function getProjectRoot() {
  const fromEnv = process.env.PROJECT_ROOT;
  if (fromEnv) return fromEnv;
  return path.join(process.cwd(), "..");
}

function getManageLogPath(root: string) {
  return process.env.MANAGE_LOG_PATH || path.join(root, "manage_log.py");
}

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
    const projectRoot = getProjectRoot();
    const manageLogPath = getManageLogPath(projectRoot);
    const { stdout, stderr } = await execFileAsync(
      "python3",
      [manageLogPath, "--api-mode", "execute", JSON.stringify(payload)],
      { cwd: projectRoot }
    );

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

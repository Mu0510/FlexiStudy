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

export async function GET() {
  try {
    const projectRoot = getProjectRoot();
    const manageLogPath = getManageLogPath(projectRoot);
    const payload = JSON.stringify({ action: "data.study_time_by_subject", params: {} });
    const { stdout, stderr } = await execFileAsync(
      "python3",
      [manageLogPath, "--api-mode", "execute", payload],
      { cwd: projectRoot }
    );

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

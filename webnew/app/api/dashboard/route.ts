import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";

export async function GET(request: NextRequest) {
  const scriptPath = path.resolve(process.cwd(), "../manage_log.py");
  const weeklyPeriod = request.nextUrl.searchParams.get("weekly_period");

  let command = `python3 ${scriptPath} dashboard_json`;
  if (weeklyPeriod) {
    command += ` ${weeklyPeriod}`;
  }

  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        resolve(NextResponse.json({ error: "Failed to fetch dashboard data", details: stderr }, { status: 500 }));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        resolve(NextResponse.json(data));
      } catch (e) {
        console.error(`json parse error: ${e}`);
        resolve(NextResponse.json({ error: "Failed to parse dashboard data", details: stdout }, { status: 500 }));
      }
    });
  });
}

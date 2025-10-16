import { NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

type AppInfo = {
  version: string | null;
  lastCommitDate: string | null;
  git: {
    branch?: string | null;
    commit?: string | null;
    message?: string | null;
  } | null;
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const appDir = process.cwd();
  const pkgPath = path.join(appDir, "package.json");

  let version: string | null = null;
  try {
    const pkgRaw = await fs.readFile(pkgPath, "utf8");
    const pkgJson = JSON.parse(pkgRaw);
    version = pkgJson?.version ?? null;
  } catch {
    // ignore
  }

  // Try to locate .git either in app dir or parent (monorepo root)
  const gitDirCandidates = [path.join(appDir, ".git"), path.join(appDir, "..", ".git")];
  let gitDir: string | null = null;
  for (const cand of gitDirCandidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await fileExists(cand)) {
      gitDir = cand;
      break;
    }
  }

  let branch: string | null = null;
  let commit: string | null = null;
  let message: string | null = null;
  let lastCommitDate: string | null = null;

  if (gitDir) {
    try {
      const headPath = path.join(gitDir, "HEAD");
      const headContent = (await fs.readFile(headPath, "utf8")).trim();

      if (headContent.startsWith("ref:")) {
        const refPath = headContent.split(" ")[1].trim(); // e.g. refs/heads/main
        branch = refPath.split("/").pop() ?? null;
        const refAbs = path.join(gitDir, refPath);
        commit = (await fs.readFile(refAbs, "utf8")).trim();
      } else {
        // Detached HEAD with direct hash
        commit = headContent || null;
      }

      // Try to get last commit date and message from logs
      const logsHead = path.join(gitDir, "logs", "HEAD");
      if (await fileExists(logsHead)) {
        const logsRaw = await fs.readFile(logsHead, "utf8");
        const lines = logsRaw.trim().split(/\r?\n/);
        const last = lines[lines.length - 1] ?? "";
        // Format: <old> <new> <name> <email> <timestamp> <tz>\t<message>
        const parts = last.split(/\t/);
        if (parts.length >= 2) {
          message = parts.slice(1).join("\t");
        }
        const pre = parts[0] ?? "";
        const preTokens = pre.split(/\s+/);
        const tsStr = preTokens[preTokens.length - 2];
        const ts = Number(tsStr);
        if (!Number.isNaN(ts)) {
          const d = new Date(ts * 1000);
          // Format like 2025年8月31日
          lastCommitDate = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
        }
      }
    } catch {
      // ignore git parsing errors
    }
  }

  const info: AppInfo = {
    version,
    lastCommitDate,
    git: gitDir
      ? {
          branch,
          commit: commit ? commit.substring(0, 7) : null,
          message,
        }
      : null,
  };

  return NextResponse.json(info);
}


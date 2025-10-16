import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function GET() {
  try {
    // Next route runs with CWD at webnew/. DB is 1 level up.
    const dbPath = path.resolve(process.cwd(), '..', 'study_log.db')
    const stat = fs.statSync(dbPath)
    const version = stat.mtimeMs
    return NextResponse.json({ version })
  } catch (e: any) {
    return NextResponse.json({ version: 0, error: e?.message }, { status: 200 })
  }
}

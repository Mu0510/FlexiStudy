// app/api/command/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { command } = body;

    if (!command) {
      return NextResponse.json({ error: 'Command not provided' }, { status: 400 });
    }

    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          resolve(NextResponse.json({ error: error.message, stderr, stdout }, { status: 500 }));
          return;
        }
        resolve(NextResponse.json({ stdout, stderr }));
      });
    });

  } catch (error) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

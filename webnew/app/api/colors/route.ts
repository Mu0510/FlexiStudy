import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const dataFilePath = path.join(process.cwd(), 'data', 'subject_colors.json');

async function ensureDirectoryExists() {
  try {
    await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
  } catch (error) {
    console.error('Error creating directory:', error);
  }
}

// GET - 色設定を取得
export async function GET() {
  try {
    await ensureDirectoryExists();
    const fileContent = await fs.readFile(dataFilePath, 'utf-8');
    return NextResponse.json(JSON.parse(fileContent));
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // ファイルが存在しない場合は空のオブジェクトを返す
      return NextResponse.json({});
    }
    console.error('Failed to read color settings:', error);
    return NextResponse.json({ message: 'Error reading color settings' }, { status: 500 });
  }
}

// POST - 色設定を保存
export async function POST(request: Request) {
  try {
    await ensureDirectoryExists();
    const body = await request.json();
    await fs.writeFile(dataFilePath, JSON.stringify(body, null, 2), 'utf-8');
    return NextResponse.json({ message: 'Color settings saved successfully' });
  } catch (error) {
    console.error('Failed to save color settings:', error);
    return NextResponse.json({ message: 'Error saving color settings' }, { status: 500 });
  }
}

// webnew/app/api/upload/route.ts
import { NextResponse, NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const files = formData.getAll('files') as File[];

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files were uploaded.' }, { status: 400 });
    }

    // Create a unique directory for the upload based on the current timestamp
    const timestamp = Date.now();
    const uploadDir = path.join(process.cwd(), 'webnew', 'mnt', 'userFiles', String(timestamp));
    
    // Use recursive true to create parent directories if they don't exist
    await fs.mkdir(uploadDir, { recursive: true });

    // Write each file to the unique directory
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const filePath = path.join(uploadDir, file.name);
      await fs.writeFile(filePath, buffer);
    }

    // Return the path to the created directory
    const relativeUploadDir = path.join('webnew', 'mnt', 'userFiles', String(timestamp));
    return NextResponse.json({ success: true, uploadPath: relativeUploadDir });

  } catch (error) {
    console.error('File upload error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'File upload failed.', details: errorMessage }, { status: 500 });
  }
}

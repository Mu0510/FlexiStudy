// webnew/app/api/upload/route.ts
import { NextResponse, NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import { createWriteStream } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1gb',
    },
  },
};

export async function POST(req: NextRequest) {
  console.log('--- Upload API Received Request ---');
  console.log('Current working directory:', process.cwd());

  // Create a unique directory path *before* starting the upload
  const timestamp = Date.now();
  const uploadDir = path.join(process.cwd(), 'mnt', 'userFiles', String(timestamp));
  console.log(`Upload directory will be: ${uploadDir}`);

  // Abort handler
  const abortHandler = async () => {
    console.log(`Request aborted. Cleaning up directory: ${uploadDir}`);
    try {
      await fs.rm(uploadDir, { recursive: true, force: true });
      console.log(`Successfully removed directory: ${uploadDir}`);
    } catch (cleanupError) {
      console.error(`Failed to cleanup directory ${uploadDir}:`, cleanupError);
    }
  };

  // Attach the abort handler to the request's signal
  req.signal.addEventListener('abort', abortHandler);

  try {
    const formData = await req.formData();
    const files = formData.getAll('files') as File[];
    console.log(`Received ${files.length} file(s).`);

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files were uploaded.' }, { status: 400 });
    }

    // Now, actually create the directory
    await fs.mkdir(uploadDir, { recursive: true });
    console.log(`Successfully created directory: ${uploadDir}`);

    const uploadedFilesInfo = [];

    // Write each file to the unique directory
    const usedNames = new Set<string>();
    const sanitizeFileName = (name: string, index: number) => {
      const base = path.basename(name || '');
      const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
      let candidate = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : `file_${index}`;
      if (candidate.length > 255) candidate = candidate.slice(0, 255);
      let unique = candidate;
      let counter = 1;
      while (usedNames.has(unique)) {
        const suffix = `_${counter++}`;
        const trimmed = candidate.slice(0, Math.max(1, 255 - suffix.length));
        unique = `${trimmed}${suffix}`;
      }
      usedNames.add(unique);
      return unique;
    };

    for (const [index, file] of files.entries()) {
      const safeName = sanitizeFileName(file.name, index);
      const filePath = path.join(uploadDir, safeName);
      const writeStream = createWriteStream(filePath, { flags: 'w' });
      try {
        const nodeStream = Readable.fromWeb(file.stream());
        await pipeline(nodeStream, writeStream, { signal: req.signal });
      } catch (streamError) {
        writeStream.destroy();
        try {
          await fs.unlink(filePath);
        } catch {}
        throw streamError;
      }
      uploadedFilesInfo.push({
        name: safeName,
        path: filePath, // Or a relative path if you prefer
        size: file.size,
      });
    }

    // If we reach here, the upload was successful, so we don't want to delete the directory.
    // Remove the abort listener to prevent it from firing accidentally.
    req.signal.removeEventListener('abort', abortHandler);

    // Return the path to the created directory, relative to the project root
    return NextResponse.json({ success: true, files: uploadedFilesInfo });

  } catch (error) {
    // Also remove the listener in case of other errors
    req.signal.removeEventListener('abort', abortHandler);
    
    console.error('File upload error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    // Don't try to cleanup here, the abort handler should take care of it if the request was aborted.
    return NextResponse.json({ error: 'File upload failed.', details: errorMessage }, { status: 500 });
  }
}

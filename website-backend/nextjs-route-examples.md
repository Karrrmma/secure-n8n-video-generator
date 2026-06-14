# Next.js Route Examples

These examples show how to expose the public website contract while keeping
n8n, OpenAI, and Supabase secrets on the server.

They assume your auth layer provides an authenticated user id. Do not accept a
user id from the browser.

## `app/api/videos/route.ts`

```ts
import { NextResponse } from 'next/server';
import { createVideoJob } from '@/website-backend/video-workflow-client.mjs';
import { getCurrentUserId } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    const body = await request.json();
    const result = await createVideoJob(userId, body);
    return NextResponse.json(result, { status: 202 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Video generation failed.' },
      { status: error.status || 500 },
    );
  }
}
```

## `app/api/videos/[jobId]/route.ts`

```ts
import { NextResponse } from 'next/server';
import { getVideoJobStatus } from '@/website-backend/video-workflow-client.mjs';
import { getCurrentUserId } from '@/lib/auth';

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const userId = await getCurrentUserId();
    const { jobId } = await context.params;
    const result = await getVideoJobStatus(userId, jobId);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Video status failed.' },
      { status: error.status || 500 },
    );
  }
}
```

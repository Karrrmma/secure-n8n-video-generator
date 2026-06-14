import crypto from 'node:crypto';

const ALLOWED_SIZES = new Set(['720x1280', '1280x720', '1024x1792', '1792x1024']);
const ALLOWED_DURATIONS = new Set([4, 8, 12]);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error('Missing required environment variable: ' + name);
  return value;
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signWorkflowJwt(userId, ttlSeconds = 300) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub: userId,
    aud: process.env.N8N_VIDEO_JWT_AUDIENCE || 'n8n-video-workflow',
    iss: process.env.N8N_VIDEO_JWT_ISSUER || 'video-generator-backend',
    iat: now,
    nbf: now - 5,
    exp: now + ttlSeconds,
  }));
  const signature = crypto
    .createHmac('sha256', requiredEnv('N8N_VIDEO_JWT_SECRET'))
    .update(header + '.' + payload)
    .digest('base64url');
  return header + '.' + payload + '.' + signature;
}

function validateCreateInput(input) {
  const idea = typeof input.idea === 'string' ? input.idea.trim() : '';
  const style = typeof input.style === 'string' ? input.style.trim() : '';
  const duration = Number(input.duration ?? 8);
  const size = typeof input.size === 'string' ? input.size.trim() : '720x1280';
  const clientRequestId = typeof input.clientRequestId === 'string' ? input.clientRequestId.trim() : '';

  if (idea.length < 3 || idea.length > 1200) {
    throw Object.assign(new Error('Video idea must be 3-1200 characters.'), { status: 400 });
  }
  if (style.length > 300) {
    throw Object.assign(new Error('Style must be 300 characters or less.'), { status: 400 });
  }
  if (!ALLOWED_DURATIONS.has(duration)) {
    throw Object.assign(new Error('Unsupported duration.'), { status: 400 });
  }
  if (!ALLOWED_SIZES.has(size)) {
    throw Object.assign(new Error('Unsupported size.'), { status: 400 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)) {
    throw Object.assign(new Error('clientRequestId must be a UUID.'), { status: 400 });
  }

  return { idea, style, duration, size, clientRequestId };
}

async function callWorkflow(url, userId, options) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: 'Bearer ' + signWorkflowJwt(userId),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw Object.assign(new Error(
      timedOut
        ? 'The video workflow took too long to respond. Please try again.'
        : 'The video workflow is temporarily unavailable. Please try again.'
    ), { status: 503 });
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: 'Workflow returned a non-JSON response.' };
  }
  if (!response.ok) {
    throw Object.assign(new Error(body.error || 'Video workflow request failed.'), {
      status: response.status,
      body,
    });
  }
  return body;
}

export async function createVideoJob(userId, input) {
  if (!userId) throw Object.assign(new Error('Authenticated user is required.'), { status: 401 });
  const body = validateCreateInput(input);
  return callWorkflow(requiredEnv('N8N_VIDEO_GENERATE_URL'), userId, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Idempotency-Key': body.clientRequestId,
    },
  });
}

export async function getVideoJobStatus(userId, jobId) {
  if (!userId) throw Object.assign(new Error('Authenticated user is required.'), { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(String(jobId || ''))) {
    throw Object.assign(new Error('Invalid job id.'), { status: 400 });
  }
  const url = new URL(requiredEnv('N8N_VIDEO_STATUS_URL'));
  url.searchParams.set('jobId', jobId);
  return callWorkflow(url.toString(), userId, { method: 'GET' });
}

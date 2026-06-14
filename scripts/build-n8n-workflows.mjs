import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const outDir = new URL('../n8n/', import.meta.url);

const baseSettings = {
  executionOrder: 'v1',
  saveExecutionProgress: false,
  saveDataSuccessExecution: 'none',
  saveDataErrorExecution: 'all',
};

function node(id, name, type, typeVersion, position, parameters, extra = {}) {
  return {
    parameters,
    id,
    name,
    type,
    typeVersion,
    position,
    ...extra,
  };
}

const noStoreHeaders = {
  entries: [
    { name: 'Cache-Control', value: 'no-store' },
    { name: 'Content-Type', value: 'application/json; charset=utf-8' },
  ],
};

const generateCode = String.raw`
const crypto = require('crypto');
const fetch = require('node-fetch');

const ALLOWED_SIZES = new Set(['720x1280', '1280x720', '1024x1792', '1792x1024']);
const ALLOWED_DURATIONS = new Set([4, 8, 12]);
const ACTIVE_STATUSES = ['queued', 'in_progress'];

function response(status, body) {
  return [{ json: { httpStatus: status, ...body } }];
}

function env(name, fallback = undefined) {
  const value = $env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error('Missing required environment variable: ' + name);
  return value;
}

function b64urlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function b64urlEncode(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function verifyJwt(headers) {
  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw Object.assign(new Error('Unauthorized'), { status: 401 });

  const parts = token.split('.');
  if (parts.length !== 3) throw Object.assign(new Error('Unauthorized'), { status: 401 });

  const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  if (header.alg !== 'HS256') throw Object.assign(new Error('Unauthorized'), { status: 401 });

  const expected = b64urlEncode(crypto.createHmac('sha256', env('N8N_VIDEO_JWT_SECRET')).update(parts[0] + '.' + parts[1]).digest());
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }

  const claims = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub || typeof claims.sub !== 'string') throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (claims.exp && now >= claims.exp) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (claims.nbf && now < claims.nbf) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (claims.aud && claims.aud !== ($env.N8N_VIDEO_JWT_AUDIENCE || 'n8n-video-workflow')) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }

  return claims;
}

function userHash(ownerId) {
  return crypto.createHmac('sha256', env('N8N_VIDEO_USER_HASH_SECRET', env('N8N_VIDEO_JWT_SECRET'))).update(ownerId).digest('hex');
}

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseClientRequestId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw Object.assign(new Error('clientRequestId must be a UUID'), { status: 400, code: 'invalid_client_request_id' });
  }
  return id;
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error('HTTP request failed');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function supabaseHeaders(prefer) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

function supabaseUrl(path) {
  return env('SUPABASE_URL').replace(/\/$/, '') + path;
}

async function supabaseSelect(query) {
  return requestJson(supabaseUrl('/rest/v1/video_jobs?' + query), {
    method: 'GET',
    headers: supabaseHeaders(),
  });
}

async function supabaseInsert(row) {
  return requestJson(supabaseUrl('/rest/v1/video_jobs'), {
    method: 'POST',
    headers: supabaseHeaders('return=representation,resolution=merge-duplicates'),
    body: JSON.stringify(row),
  });
}

async function supabasePatch(query, patch) {
  return requestJson(supabaseUrl('/rest/v1/video_jobs?' + query), {
    method: 'PATCH',
    headers: supabaseHeaders('return=representation'),
    body: JSON.stringify(patch),
  });
}

async function moderate(input, ownerId) {
  const body = await requestJson('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env('OPENAI_API_KEY'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'omni-moderation-latest',
      input,
      safety_identifier: crypto.createHash('sha256').update(ownerId).digest('hex'),
    }),
  });

  const result = body.results?.[0] || {};
  return {
    flagged: Boolean(result.flagged),
    raw: body,
  };
}

function buildPrompt({ idea, style, duration, size }) {
  const stylePart = style ? ' Visual style: ' + style + '.' : '';
  const orientation = size.includes('1280') || size.includes('1792') ? 'Use the requested aspect ratio.' : 'Frame for vertical short-form social video.';
  return [
    'Create an original short-form video designed for online sharing.',
    'User idea: ' + idea + '.',
    stylePart,
    'Length: ' + duration + ' seconds. ' + orientation,
    'Start with a visually clear first-second hook, keep motion readable, use strong composition, and avoid on-screen text unless it is essential.',
    'Do not include real people, public figures, copyrighted characters, copyrighted music, explicit sexual content, graphic violence, illegal instructions, hate, harassment, or unsafe behavior.'
  ].filter(Boolean).join(' ');
}

async function createOpenAiVideo({ prompt, size, duration, ownerId }) {
  return requestJson('https://api.openai.com/v1/videos', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env('OPENAI_API_KEY'),
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.createHash('sha256').update(ownerId + ':' + prompt).digest('hex'),
    },
    body: JSON.stringify({
      model: $env.OPENAI_VIDEO_MODEL || 'sora-2',
      prompt,
      size,
      seconds: String(duration),
    }),
  });
}

async function main() {
  try {
    const inbound = $input.first().json || {};
    const headers = inbound.headers || {};
    const claims = verifyJwt(headers);
    const ownerId = claims.sub;
    const body = inbound.body || {};

    const idea = cleanText(body.idea, 1200);
    const style = cleanText(body.style || '', 300);
    const duration = Number(body.duration ?? 8);
    const size = cleanText(body.size || '720x1280', 32);
    const clientRequestId = parseClientRequestId(body.clientRequestId);
    const ownerHash = userHash(ownerId);

    if (idea.length < 3) {
      return response(400, { status: 'failed', error: 'Please enter a more specific video idea.' });
    }
    if (!ALLOWED_DURATIONS.has(duration)) {
      return response(400, { status: 'failed', error: 'Unsupported duration.' });
    }
    if (!ALLOWED_SIZES.has(size)) {
      return response(400, { status: 'failed', error: 'Unsupported size.' });
    }

    const duplicate = await supabaseSelect(
      'owner_id=eq.' + encodeURIComponent(ownerId) +
      '&client_request_id=eq.' + encodeURIComponent(clientRequestId) +
      '&select=id,status'
    );
    if (duplicate.length > 0) {
      return response(200, { jobId: duplicate[0].id, status: duplicate[0].status });
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todaysJobs = await supabaseSelect(
      'owner_id=eq.' + encodeURIComponent(ownerId) +
      '&created_at=gte.' + encodeURIComponent(today.toISOString()) +
      '&select=id'
    );
    const dailyLimit = Number($env.N8N_VIDEO_DAILY_LIMIT || 5);
    if (todaysJobs.length >= dailyLimit) {
      return response(429, { status: 'failed', error: 'Daily generation limit reached.' });
    }

    const activeJobs = await supabaseSelect(
      'owner_id=eq.' + encodeURIComponent(ownerId) +
      '&status=in.(' + ACTIVE_STATUSES.join(',') + ')' +
      '&select=id'
    );
    if (activeJobs.length >= 1) {
      return response(429, { status: 'failed', error: 'Please wait for your active generation to finish.' });
    }

    const moderation = await moderate(idea + '\n' + style, ownerId);
    if (moderation.flagged) {
      const blocked = await supabaseInsert({
        owner_id: ownerId,
        user_hash: ownerHash,
        client_request_id: clientRequestId,
        idea,
        style,
        duration_seconds: duration,
        size,
        model: $env.OPENAI_VIDEO_MODEL || 'sora-2',
        status: 'blocked',
        progress: 0,
        moderation_result: moderation.raw,
        error_message: 'Input blocked by safety moderation.',
      });
      return response(200, { jobId: blocked[0].id, status: 'blocked' });
    }

    const prompt = buildPrompt({ idea, style, duration, size });
    const openaiVideo = await createOpenAiVideo({ prompt, size, duration, ownerId });
    const openaiVideoId = openaiVideo.id;
    if (!openaiVideoId) throw new Error('OpenAI did not return a video id.');

    const inserted = await supabaseInsert({
      owner_id: ownerId,
      user_hash: ownerHash,
      client_request_id: clientRequestId,
      idea,
      style,
      prompt,
      duration_seconds: duration,
      size,
      model: $env.OPENAI_VIDEO_MODEL || 'sora-2',
      openai_video_id: openaiVideoId,
      status: openaiVideo.status || 'queued',
      progress: Number(openaiVideo.progress || 0),
      provider_response: openaiVideo,
    });

    return response(202, {
      jobId: inserted[0].id,
      status: inserted[0].status || 'queued',
    });
  } catch (error) {
    const status = error.status || 500;
    const message = status >= 500 ? 'Video generation could not be started.' : error.message;
    return response(status, { status: 'failed', error: message });
  }
}

return await main();
`;

const statusCode = String.raw`
const crypto = require('crypto');
const fetch = require('node-fetch');

function response(status, body) {
  return [{ json: { httpStatus: status, ...body } }];
}

function env(name, fallback = undefined) {
  const value = $env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error('Missing required environment variable: ' + name);
  return value;
}

function b64urlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function b64urlEncode(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function verifyJwt(headers) {
  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const parts = token.split('.');
  if (parts.length !== 3) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  if (header.alg !== 'HS256') throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const expected = b64urlEncode(crypto.createHmac('sha256', env('N8N_VIDEO_JWT_SECRET')).update(parts[0] + '.' + parts[1]).digest());
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }
  const claims = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub || typeof claims.sub !== 'string') throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (claims.exp && now >= claims.exp) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (claims.nbf && now < claims.nbf) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (claims.aud && claims.aud !== ($env.N8N_VIDEO_JWT_AUDIENCE || 'n8n-video-workflow')) {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }
  return claims;
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error('HTTP request failed');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function requestBuffer(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = new Error('HTTP request failed');
    err.status = res.status;
    err.body = await res.text();
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

function supabaseHeaders(prefer) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

function supabaseUrl(path) {
  return env('SUPABASE_URL').replace(/\/$/, '') + path;
}

async function supabaseSelect(query) {
  return requestJson(supabaseUrl('/rest/v1/video_jobs?' + query), {
    method: 'GET',
    headers: supabaseHeaders(),
  });
}

async function supabasePatch(query, patch) {
  return requestJson(supabaseUrl('/rest/v1/video_jobs?' + query), {
    method: 'PATCH',
    headers: supabaseHeaders('return=representation'),
    body: JSON.stringify(patch),
  });
}

async function openAiStatus(videoId) {
  return requestJson('https://api.openai.com/v1/videos/' + encodeURIComponent(videoId), {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + env('OPENAI_API_KEY') },
  });
}

async function openAiContent(videoId) {
  return requestBuffer('https://api.openai.com/v1/videos/' + encodeURIComponent(videoId) + '/content', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + env('OPENAI_API_KEY') },
  });
}

async function openAiDelete(videoId) {
  try {
    await fetch('https://api.openai.com/v1/videos/' + encodeURIComponent(videoId), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + env('OPENAI_API_KEY') },
    });
  } catch {}
}

async function uploadVideo(path, buffer) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(supabaseUrl('/storage/v1/object/generated-videos/' + path), {
    method: 'PUT',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'video/mp4',
      'Cache-Control': '3600',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    const err = new Error('Storage upload failed');
    err.status = res.status;
    err.body = await res.text();
    throw err;
  }
}

async function signedUrl(path) {
  const expiresIn = Number($env.VIDEO_SIGNED_URL_TTL_SECONDS || 3600);
  const body = await requestJson(supabaseUrl('/storage/v1/object/sign/generated-videos/' + path), {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify({ expiresIn }),
  });
  const signed = body.signedURL || body.signedUrl;
  if (!signed) throw new Error('Supabase did not return a signed URL.');
  const base = env('SUPABASE_URL').replace(/\/$/, '');
  return signed.startsWith('http') ? signed : base + '/storage/v1' + signed;
}

function getJobId(inbound) {
  const fromQuery = inbound.query?.jobId;
  const fromParam = inbound.params?.jobId;
  const value = String(fromQuery || fromParam || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    throw Object.assign(new Error('Invalid job id.'), { status: 400 });
  }
  return value.toLowerCase();
}

function failureMessage(provider = {}) {
  const code = provider.error?.code || '';
  if (code === 'moderation_blocked' || code === 'policy_violation') {
    return 'OpenAI stopped this video because its safety filter flagged the request. Try simplifying the idea and removing references to real people, violence, copyrighted characters, or other sensitive content.';
  }
  if (code === 'rate_limit_exceeded' || code === 'rate_limit') {
    return 'OpenAI is receiving too many requests right now. Please wait a few minutes and try again.';
  }
  if (code === 'invalid_prompt') {
    return 'OpenAI could not generate this video from the prompt. Try describing one clear scene with fewer instructions.';
  }
  if (provider.status === 'expired') {
    return 'The video job expired before it could finish. Please generate it again.';
  }
  if (provider.status === 'cancelled') {
    return 'The video job was cancelled before it finished. Please generate it again.';
  }
  return 'The video provider could not finish this generation. Try a simpler prompt or generate it again in a few minutes.';
}

async function main() {
  try {
    const inbound = $input.first().json || {};
    const claims = verifyJwt(inbound.headers || {});
    const ownerId = claims.sub;
    const jobId = getJobId(inbound);

    const rows = await supabaseSelect(
      'id=eq.' + encodeURIComponent(jobId) +
      '&owner_id=eq.' + encodeURIComponent(ownerId) +
      '&select=*'
    );
    if (rows.length === 0) return response(404, { status: 'failed', error: 'Video job not found.' });

    const job = rows[0];
    if (job.status === 'blocked') {
      return response(200, { jobId, status: 'blocked', progress: 0, videoUrl: null, error: 'This request was blocked by safety checks.' });
    }
    if (job.status === 'failed') {
      return response(200, {
        jobId,
        status: 'failed',
        progress: job.progress || 0,
        videoUrl: null,
        error: failureMessage(job.provider_response || {}),
      });
    }
    if (job.status === 'completed' && job.video_path) {
      return response(200, { jobId, status: 'completed', progress: 100, videoUrl: await signedUrl(job.video_path), error: null });
    }
    if (!job.openai_video_id) {
      return response(200, { jobId, status: job.status || 'queued', progress: job.progress || 0, videoUrl: null, error: null });
    }

    const provider = await openAiStatus(job.openai_video_id);
    const providerStatus = provider.status || 'in_progress';
    const progress = Math.max(0, Math.min(100, Number(provider.progress || job.progress || 0)));

    if (providerStatus === 'failed' || providerStatus === 'cancelled' || providerStatus === 'expired') {
      const errorMessage = failureMessage(provider);
      await supabasePatch('id=eq.' + encodeURIComponent(jobId), {
        status: 'failed',
        progress,
        provider_response: provider,
        error_message: errorMessage,
      });
      return response(200, { jobId, status: 'failed', progress, videoUrl: null, error: errorMessage });
    }

    if (providerStatus !== 'completed') {
      const patched = await supabasePatch('id=eq.' + encodeURIComponent(jobId), {
        status: providerStatus === 'queued' ? 'queued' : 'in_progress',
        progress,
        provider_response: provider,
      });
      const updated = patched[0] || {};
      return response(200, { jobId, status: updated.status || 'in_progress', progress: updated.progress || progress, videoUrl: null, error: null });
    }

    const video = await openAiContent(job.openai_video_id);
    const path = (job.user_hash || 'unknown') + '/' + jobId + '.mp4';
    await uploadVideo(path, video);
    const patched = await supabasePatch('id=eq.' + encodeURIComponent(jobId), {
      status: 'completed',
      progress: 100,
      video_path: path,
      completed_at: new Date().toISOString(),
      provider_response: provider,
    });
    await openAiDelete(job.openai_video_id);

    return response(200, {
      jobId,
      status: 'completed',
      progress: 100,
      videoUrl: await signedUrl(path),
      error: null,
    });
  } catch (error) {
    const status = error.status || 500;
    const message = status >= 500 ? 'Video status could not be checked.' : error.message;
    return response(status, { status: 'failed', videoUrl: null, error: message });
  }
}

return await main();
`;

const cleanupCode = String.raw`
const fetch = require('node-fetch');

function response(status, body) {
  return [{ json: { httpStatus: status, ...body } }];
}

function env(name, fallback = undefined) {
  const value = $env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error('Missing required environment variable: ' + name);
  return value;
}

function supabaseUrl(path) {
  return env('SUPABASE_URL').replace(/\/$/, '') + path;
}

function supabaseHeaders(prefer) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error('HTTP request failed');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function deleteStorage(paths) {
  if (paths.length === 0) return;
  await requestJson(supabaseUrl('/storage/v1/object/generated-videos'), {
    method: 'DELETE',
    headers: supabaseHeaders(),
    body: JSON.stringify({ prefixes: paths }),
  });
}

async function main() {
  const days = Number($env.N8N_VIDEO_RETENTION_DAYS || 30);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const oldJobs = await requestJson(
    supabaseUrl('/rest/v1/video_jobs?created_at=lt.' + encodeURIComponent(cutoff) + '&select=id,video_path'),
    { method: 'GET', headers: supabaseHeaders() }
  );

  const paths = oldJobs.map((job) => job.video_path).filter(Boolean);
  for (let i = 0; i < paths.length; i += 100) {
    await deleteStorage(paths.slice(i, i + 100));
  }

  await requestJson(
    supabaseUrl('/rest/v1/video_jobs?created_at=lt.' + encodeURIComponent(cutoff)),
    { method: 'DELETE', headers: supabaseHeaders() }
  );

  return response(200, {
    deletedJobs: oldJobs.length,
    deletedFiles: paths.length,
    cutoff,
  });
}

return await main();
`;

function respondNode(id, name, position) {
  return node(id, name, 'n8n-nodes-base.respondToWebhook', 1.4, position, {
    respondWith: 'json',
    responseBody: '={{ JSON.stringify($json) }}',
    options: {
      responseCode: '={{ $json.httpStatus || 200 }}',
      responseHeaders: noStoreHeaders,
    },
  });
}

function sticky(id, name, position, content) {
  return node(id, name, 'n8n-nodes-base.stickyNote', 1, position, {
    width: 420,
    height: 260,
    content,
  });
}

const workflows = [
  {
    file: 'video-generate.workflow.json',
    workflow: {
      name: 'Video Generator API - Create',
      nodes: [
        sticky('note-generate', 'Setup Notes', [-760, -260], '## Secure video generation\n\nRequires environment variables: `N8N_VIDEO_JWT_SECRET`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.\n\nThe browser must call your website backend, not this webhook directly.'),
        node('webhook-generate', 'POST /webhook/video-generate', 'n8n-nodes-base.webhook', 2, [-740, 80], {
          httpMethod: 'POST',
          path: 'video-generate-v2',
          authentication: 'none',
          responseMode: 'responseNode',
          options: {
            allowedOrigins: '',
          },
        }, { webhookId: 'b91f7e8a-f702-4ac2-9ae9-86da45490a3a' }),
        node('code-create-job', 'Validate, Moderate, Create Sora Job', 'n8n-nodes-base.code', 2, [-360, 80], {
          jsCode: generateCode,
        }),
        respondNode('respond-generate', 'Return Job Response', [40, 80]),
      ],
      connections: {
        'POST /webhook/video-generate': {
          main: [[{ node: 'Validate, Moderate, Create Sora Job', type: 'main', index: 0 }]],
        },
        'Validate, Moderate, Create Sora Job': {
          main: [[{ node: 'Return Job Response', type: 'main', index: 0 }]],
        },
      },
      active: false,
      settings: baseSettings,
      staticData: null,
      pinData: {},
      tags: [{ name: 'video-generation' }, { name: 'secure' }],
    },
  },
  {
    file: 'video-status.workflow.json',
    workflow: {
      name: 'Video Generator API - Status',
      nodes: [
        sticky('note-status', 'Setup Notes', [-760, -260], '## Secure status polling\n\nPolls OpenAI, uploads completed MP4 files to private Supabase Storage, and returns one-hour signed playback URLs.\n\nKeep this webhook behind your website backend.'),
        node('webhook-status', 'GET /webhook/video-status', 'n8n-nodes-base.webhook', 2, [-740, 80], {
          httpMethod: 'GET',
          path: 'video-status-v2',
          authentication: 'none',
          responseMode: 'responseNode',
          options: {
            allowedOrigins: '',
          },
        }, { webhookId: 'c0ea44fe-664e-4198-832b-52cb60ddf85b' }),
        node('code-status', 'Check Status, Upload, Sign URL', 'n8n-nodes-base.code', 2, [-360, 80], {
          jsCode: statusCode,
        }),
        respondNode('respond-status', 'Return Status Response', [40, 80]),
      ],
      connections: {
        'GET /webhook/video-status': {
          main: [[{ node: 'Check Status, Upload, Sign URL', type: 'main', index: 0 }]],
        },
        'Check Status, Upload, Sign URL': {
          main: [[{ node: 'Return Status Response', type: 'main', index: 0 }]],
        },
      },
      active: false,
      settings: baseSettings,
      staticData: null,
      pinData: {},
      tags: [{ name: 'video-generation' }, { name: 'secure' }],
    },
  },
  {
    file: 'video-cleanup.workflow.json',
    workflow: {
      name: 'Secure Video Generation - Cleanup',
      nodes: [
        sticky('note-cleanup', 'Setup Notes', [-760, -240], '## Cleanup\n\nRuns daily and removes video job rows plus Supabase Storage objects older than `N8N_VIDEO_RETENTION_DAYS`.\n\nDefault retention: 30 days.'),
        node('schedule-cleanup', 'Daily Cleanup Trigger', 'n8n-nodes-base.scheduleTrigger', 1.2, [-720, 80], {
          rule: {
            interval: [
              {
                field: 'cronExpression',
                expression: '17 3 * * *',
              },
            ],
          },
        }),
        node('code-cleanup', 'Delete Expired Jobs and Files', 'n8n-nodes-base.code', 2, [-360, 80], {
          jsCode: cleanupCode,
        }),
      ],
      connections: {
        'Daily Cleanup Trigger': {
          main: [[{ node: 'Delete Expired Jobs and Files', type: 'main', index: 0 }]],
        },
      },
      active: false,
      settings: baseSettings,
      staticData: null,
      pinData: {},
      tags: [{ name: 'video-generation' }, { name: 'cleanup' }],
    },
  },
];

await mkdir(outDir, { recursive: true });
for (const { file, workflow } of workflows) {
  await writeFile(join(outDir.pathname, file), JSON.stringify(workflow, null, 2) + '\n');
}

console.log('Wrote ' + workflows.length + ' n8n workflows to ' + outDir.pathname);

# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately through GitHub Security
Advisories. Do not open a public issue containing secrets, access tokens, or
reproduction steps that expose a running deployment.

## Deployment Checklist

- Keep `.env` and all provider credentials outside Git.
- Use a unique, high-entropy `N8N_VIDEO_JWT_SECRET`.
- Use a different high-entropy `N8N_VIDEO_USER_HASH_SECRET`.
- Keep the Supabase service-role key server-side only.
- Keep the `generated-videos` bucket private.
- Enable Row Level Security on `public.video_jobs`.
- Restrict public access to the n8n editor.
- Retain generic user-facing errors and restricted provider logs.
- Rotate credentials immediately if accidental exposure is suspected.

The local cookie-based identity in `server.mjs` is intended for demonstration.
A production deployment should replace it with a real authenticated user
session.

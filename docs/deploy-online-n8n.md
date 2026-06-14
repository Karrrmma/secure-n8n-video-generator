# Deploy n8n Online

The video workflows use trusted Code nodes that read host environment variables
and import `crypto` and `node-fetch`. A hosted self-managed n8n instance is the
most direct online deployment because it supports those settings without
rewriting the workflows.

This repository includes a Render Blueprint and a custom n8n Docker image. The
Blueprint creates an HTTPS n8n web service with a persistent disk so workflows,
users, and encrypted credentials survive restarts.

## 1. Create the Online n8n Instance

Open the Blueprint:

[Deploy n8n on Render](https://render.com/deploy?repo=https://github.com/Karrrmma/secure-n8n-video-generator)

During setup, enter the required secret environment variables:

- `WEBHOOK_URL`: the final Render service URL, ending with `/`
- `N8N_EDITOR_BASE_URL`: the same final Render service URL
- `N8N_VIDEO_JWT_SECRET`: the same secret used by the website backend
- `N8N_VIDEO_USER_HASH_SECRET`: a different random secret
- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Never commit these values to GitHub. Render stores them as private environment
variables.

After the first deployment, open the Render URL and create the n8n owner
account. Keep the editor login private and enable two-factor authentication.

## 2. Import the Video Workflows

In the online n8n editor, create a workflow, open the workflow menu, choose
**Import from URL**, and import each URL:

```text
https://raw.githubusercontent.com/Karrrmma/secure-n8n-video-generator/main/n8n/video-generate.workflow.json
https://raw.githubusercontent.com/Karrrmma/secure-n8n-video-generator/main/n8n/video-status.workflow.json
https://raw.githubusercontent.com/Karrrmma/secure-n8n-video-generator/main/n8n/video-cleanup.workflow.json
```

Review each workflow, then publish all three. Their production webhooks are:

```text
https://YOUR-N8N-DOMAIN/webhook/video-generate-v2
https://YOUR-N8N-DOMAIN/webhook/video-status-v2
```

## 3. Connect the Website Backend

Update the website backend environment:

```sh
N8N_VIDEO_GENERATE_URL="https://YOUR-N8N-DOMAIN/webhook/video-generate-v2"
N8N_VIDEO_STATUS_URL="https://YOUR-N8N-DOMAIN/webhook/video-status-v2"
N8N_VIDEO_JWT_SECRET="the-same-secret-configured-on-render"
```

Restart the website backend after changing its environment. The browser still
calls the website backend; it never calls n8n directly.

## 4. Verify

1. Open the website and submit a short test video.
2. Confirm the Create workflow receives one production execution.
3. Confirm status polling reaches the Status workflow.
4. Confirm the completed MP4 appears in the private Supabase bucket.
5. Confirm the website receives a playable signed URL.

## Important Notes

- The persistent disk is required. Without it, n8n data can disappear during a
  redeploy.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is required by these workflows. Only
  trusted administrators should have access to the n8n editor.
- Render hosting and OpenAI video generation may incur charges.
- The website remains local until it is deployed separately.


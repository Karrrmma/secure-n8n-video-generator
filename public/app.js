const form = document.querySelector('#videoForm');
const submitButton = document.querySelector('#submitButton');
const connectionStatus = document.querySelector('#connectionStatus');
const emptyState = document.querySelector('#emptyState');
const progressPanel = document.querySelector('#progressPanel');
const statusLabel = document.querySelector('#statusLabel');
const statusDetail = document.querySelector('#statusDetail');
const progressBar = document.querySelector('#progressBar');
const progressValue = document.querySelector('#progressValue');
const elapsedTime = document.querySelector('#elapsedTime');
const stageList = document.querySelector('#stageList');
const activityText = document.querySelector('#activityText');
const lastChecked = document.querySelector('#lastChecked');
const jobIdLabel = document.querySelector('#jobId');
const videoPlayer = document.querySelector('#videoPlayer');
const downloadLink = document.querySelector('#downloadLink');
let pollTimer = null;
let elapsedTimer = null;
let startedAt = null;
let pollInFlight = false;
let activityTimer = null;
let activityIndex = 0;
let estimateTimer = null;
let displayedProgress = 0;
let currentStatus = 'submitting';

const activityMessages = [
  'Keeping the secure connection open',
  'Checking the video provider for progress',
  'Waiting for the next generation update',
  'Your request is still active',
];

function setStages(currentStage) {
  const stages = ['request', 'queue', 'generate', 'finalize', 'upload'];
  const currentIndex = stages.indexOf(currentStage);
  for (const item of stageList.querySelectorAll('li')) {
    const index = stages.indexOf(item.dataset.stage);
    item.classList.toggle('is-complete', index < currentIndex);
    item.classList.toggle('is-current', index === currentIndex);
  }
}

function stageFromProgress(status, progress) {
  if (status === 'queued') return 'queue';
  if (progress >= 99) return 'upload';
  if (progress >= 85) return 'finalize';
  if (progress >= 1) return 'generate';
  return 'request';
}

function detailFromProgress(status, progress) {
  if (status === 'queued') return 'Your request is accepted and waiting for video generation capacity.';
  if (progress >= 99) return 'The video is generated. Preparing secure playback now.';
  if (progress >= 85) return 'The final frames are being assembled and checked.';
  if (progress >= 50) return 'The main scene is taking shape. Motion and details are still rendering.';
  if (progress >= 1) return 'Sora is generating the scene frame by frame.';
  return 'The workflow is preparing your prompt and safety checks.';
}

function startActivity() {
  clearInterval(activityTimer);
  activityIndex = 0;
  activityText.textContent = activityMessages[activityIndex];
  activityTimer = setInterval(() => {
    activityIndex = (activityIndex + 1) % activityMessages.length;
    activityText.textContent = activityMessages[activityIndex];
  }, 3500);
}

function stopActivity(message) {
  clearInterval(activityTimer);
  activityTimer = null;
  activityText.textContent = message;
}

function startEstimate() {
  clearInterval(estimateTimer);
  estimateTimer = setInterval(() => {
    const ceiling = currentStatus === 'queued' ? 24 : 96;
    if (displayedProgress >= ceiling) return;
    displayedProgress = Math.min(ceiling, displayedProgress + (displayedProgress < 30 ? 2 : 1));
    progressBar.style.width = `${Math.max(5, displayedProgress)}%`;
    progressValue.textContent = `${displayedProgress}%`;
    if (currentStatus !== 'queued') setStages(stageFromProgress(currentStatus, displayedProgress));
  }, 1800);
}

function stopEstimate() {
  clearInterval(estimateTimer);
  estimateTimer = null;
}

function updateElapsed() {
  if (!startedAt) {
    elapsedTime.textContent = 'Just started';
    return;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  elapsedTime.textContent = seconds < 60
    ? `${seconds}s elapsed`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
}

function startElapsedTimer(timestamp = Date.now()) {
  startedAt = timestamp;
  clearInterval(elapsedTimer);
  updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 1000);
}

function stopElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.querySelector('.button-label').textContent = isBusy ? 'Generating video' : 'Generate video';
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (char) =>
    (Number(char) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(char) / 4).toString(16)
  );
}

function showStatus(status, detail, progress = 0) {
  emptyState.classList.add('hidden');
  progressPanel.classList.remove('hidden');
  statusLabel.textContent = status;
  statusDetail.textContent = detail;
  const normalizedProgress = Math.max(0, Math.min(100, progress));
  displayedProgress = Math.max(displayedProgress, normalizedProgress);
  progressBar.style.width = `${Math.max(5, displayedProgress)}%`;
  progressValue.textContent = `${displayedProgress}%`;
  progressPanel.classList.toggle('is-active', normalizedProgress < 100);
  connectionStatus.textContent = status;
}

function showError(message) {
  clearTimeout(pollTimer);
  stopElapsedTimer();
  stopActivity('Generation stopped');
  stopEstimate();
  setStages('');
  localStorage.removeItem('activeVideoJob');
  setBusy(false);
  connectionStatus.textContent = 'Error';
  showStatus('Failed', message, 100);
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(35_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new Error(
      timedOut
        ? 'The request took too long. Please try again.'
        : 'The server could not be reached. Please try again.'
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'Request failed.');
    error.body = body;
    error.status = response.status;
    throw error;
  }
  return body;
}

function schedulePoll(jobId) {
  clearTimeout(pollTimer);
  lastChecked.textContent = 'Next check in 4s';
  pollTimer = setTimeout(() => poll(jobId), 4_000);
}

async function poll(jobId) {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const result = await requestJson(`/api/videos/${encodeURIComponent(jobId)}`);
    const progress = Number(result.progress || 0);
    currentStatus = result.status;
    lastChecked.textContent = 'Checked just now';

    if (result.status === 'completed' && result.videoUrl) {
      clearTimeout(pollTimer);
      stopElapsedTimer();
      stopActivity('Video ready');
      stopEstimate();
      setStages('');
      for (const item of stageList.querySelectorAll('li')) item.classList.add('is-complete');
      localStorage.removeItem('activeVideoJob');
      setBusy(false);
      showStatus('Completed', 'Your video is ready.', 100);
      videoPlayer.src = result.videoUrl;
      videoPlayer.classList.remove('hidden');
      downloadLink.href = result.videoUrl;
      downloadLink.classList.remove('hidden');
      return;
    }

    if (result.status === 'failed' || result.status === 'blocked') {
      showError(result.error || 'The workflow could not complete this request. Try a simpler prompt and generate it again.');
      return;
    }

    showStatus(
      result.status === 'queued' ? 'Queued' : 'Generating',
      detailFromProgress(result.status, progress),
      progress || 20
    );
    setStages(stageFromProgress(result.status, progress));
    schedulePoll(jobId);
  } catch (error) {
    showError(error.message);
  } finally {
    pollInFlight = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  displayedProgress = 5;
  currentStatus = 'submitting';
  showStatus('Submitting', 'Preparing your idea and opening a secure workflow request.', 5);
  try {
    clearTimeout(pollTimer);
    startElapsedTimer();
    startActivity();
    startEstimate();
    setStages('request');
    setBusy(true);
    videoPlayer.classList.add('hidden');
    downloadLink.classList.add('hidden');
    videoPlayer.removeAttribute('src');

    const data = new FormData(form);
    const payload = {
      idea: String(data.get('idea') || ''),
      style: String(data.get('style') || ''),
      duration: Number(data.get('duration') || 8),
      size: String(data.get('size') || '720x1280'),
      clientRequestId: uuid(),
    };

    const result = await requestJson('/api/videos', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    jobIdLabel.textContent = result.jobId || 'Job created';
    localStorage.setItem('activeVideoJob', JSON.stringify({
      jobId: result.jobId,
      startedAt,
    }));
    currentStatus = result.status || 'queued';
    showStatus('Queued', 'The n8n workflow accepted your request.', 15);
    setStages('queue');
    await poll(result.jobId);
  } catch (error) {
    showError(error.message);
  }
});

try {
  const activeJob = JSON.parse(localStorage.getItem('activeVideoJob') || 'null');
  if (activeJob?.jobId) {
    displayedProgress = 15;
    currentStatus = 'checking';
    setBusy(true);
    jobIdLabel.textContent = activeJob.jobId;
    startElapsedTimer(Number(activeJob.startedAt) || Date.now());
    startActivity();
    startEstimate();
    setStages('request');
    showStatus('Checking', 'Restoring your active generation.', 15);
    poll(activeJob.jobId);
  }
} catch {
  localStorage.removeItem('activeVideoJob');
}

window.addEventListener('unhandledrejection', () => {
  if (submitButton.disabled) showError('The page hit an unexpected problem while tracking the video. Please try again.');
});

window.addEventListener('error', () => {
  if (submitButton.disabled) showError('The page hit an unexpected problem while tracking the video. Please try again.');
});

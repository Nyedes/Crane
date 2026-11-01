// background.js

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Rate-limit-safe pacing & concurrency constants
const TAB_OPEN_DELAY_MS = 160;        // Smooth 160ms stagger (~6 tabs/sec) avoids Cloudflare burst blocks
const MARK_READ_CONCURRENCY = 2;      // Max 2 in-flight mark-read requests at a time
const MIN_REQUEST_INTERVAL_MS = 180;  // Minimum 180ms spacing between starting HTTP requests
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1500;
const DUPLICATE_JOB_COOLDOWN_MS = 1000;

// Sequential Job Queue & Global Rate Limiter State
const jobQueue = [];
let activeJob = null;
let activeExpandState = null;
let isProcessingQueue = false;
let lastCompletedJob = null;
let jobIdCounter = 0;
const recentJobTimestamps = new Map();

let nextAllowedRequestTime = 0;
let rateLimitPauseUntil = 0;

/**
 * Normalizes a URL for duplicate job detection across tabs/pages.
 */
function normalizeUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        let path = u.pathname.toLowerCase();
        const threadMatch = path.match(/^\/threads\/[^/]+\.(\d+)/);
        if (threadMatch) return (u.origin + threadMatch[0]).toLowerCase();
        const forumMatch = path.match(/^\/forums\/[^/]+\.(\d+)/);
        if (forumMatch) return (u.origin + forumMatch[0]).toLowerCase();
        if (path.endsWith('/')) path = path.slice(0, -1);
        return (u.origin + path).toLowerCase();
    } catch (e) {
        let clean = String(url).trim().toLowerCase();
        if (clean.endsWith('/')) clean = clean.slice(0, -1);
        return clean;
    }
}

/**
 * Safely broadcasts runtime messages to the popup if open.
 */
function notifyPopup(payload) {
    browser.runtime.sendMessage(payload).catch(() => {
        // Ignore error when popup is closed
    });
}

/**
 * Token-bucket style request pacer: ensures outgoing requests are spaced by at least
 * `MIN_REQUEST_INTERVAL_MS` and respects any global 429 cooldown window.
 */
async function acquireRequestSlot() {
    while (true) {
        const now = Date.now();
        if (now < rateLimitPauseUntil) {
            await delay(rateLimitPauseUntil - now);
            continue;
        }
        const scheduledTime = Math.max(now, nextAllowedRequestTime);
        nextAllowedRequestTime = scheduledTime + MIN_REQUEST_INTERVAL_MS;
        const waitMs = scheduledTime - now;
        if (waitMs > 0) {
            await delay(waitMs);
        }
        // Re-check if another worker hit a 429 while we were waiting
        if (Date.now() < rateLimitPauseUntil) {
            continue;
        }
        return;
    }
}

/**
 * Executes a fetch with automatic HTTP 429 / 503 detection, Retry-After parsing,
 * global worker pause, and exponential backoff.
 */
async function fetchWithRateLimitRetry(url, options = {}, abortBodyOnSuccess = false) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await acquireRequestSlot();

        const controller = abortBodyOnSuccess ? new AbortController() : null;
        const fetchOpts = controller ? { ...options, signal: controller.signal } : options;

        try {
            const response = await fetch(url, fetchOpts);

            if (response.status === 429 || response.status === 503) {
                if (controller) controller.abort();
                const retryAfterHeader = response.headers.get('Retry-After');
                let backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
                if (retryAfterHeader) {
                    const parsedSec = parseInt(retryAfterHeader, 10);
                    if (!isNaN(parsedSec) && parsedSec > 0) {
                        backoffMs = Math.min(parsedSec * 1000, 15000);
                    }
                }
                // Add jitter and pause all concurrent workers during cooldown
                const jitter = Math.floor(Math.random() * 300);
                rateLimitPauseUntil = Math.max(rateLimitPauseUntil, Date.now() + backoffMs + jitter);
                console.warn(`Rate limited (${response.status}) on ${url}. Backing off for ${backoffMs + jitter}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);

                if (attempt < MAX_RETRIES) {
                    continue;
                }
                return response;
            }

            if (abortBodyOnSuccess && controller) {
                const ok = response.ok;
                const status = response.status;
                controller.abort();
                return { ok, status };
            }

            return response;
        } catch (error) {
            if (abortBodyOnSuccess && error && error.name === 'AbortError') {
                return { ok: true, status: 200 };
            }
            if (attempt < MAX_RETRIES) {
                const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
                await delay(backoffMs);
                continue;
            }
            throw error;
        }
    }
    return { ok: false, status: 0 };
}

/**
 * Runs an async iterator over `items` with a maximum concurrency limit.
 */
async function runConcurrentPool(items, concurrency, taskFn) {
    const total = items.length;
    if (total === 0) return;
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, total);

    const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < total) {
            const currentIndex = nextIndex++;
            await taskFn(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);
}

/**
 * Checks whether a tab/page already has an active or queued job, or was just submitted.
 */
function isDuplicateJobRequest(tabId, pageUrl) {
    const key = `${tabId || 'no-tab'}::${pageUrl || 'no-url'}`;
    const now = Date.now();
    const lastSubmitted = recentJobTimestamps.get(key);
    if (lastSubmitted && (now - lastSubmitted) < DUPLICATE_JOB_COOLDOWN_MS) {
        return true;
    }

    if (activeJob && ((tabId && activeJob.tabId === tabId) || (pageUrl && activeJob.pageUrl === pageUrl))) {
        return true;
    }

    return jobQueue.some(job =>
        (tabId && job.tabId === tabId) || (pageUrl && job.pageUrl === pageUrl)
    );
}

// Listen for messages from content script and popup
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !request.action) return false;

    if (request.action === 'getQueueStatus') {
        sendResponse({
            isProcessing: isProcessingQueue || Boolean(activeExpandState),
            activeExpandState: activeExpandState ? { ...activeExpandState } : null,
            activeJob: activeJob ? { ...activeJob } : null,
            queueLength: jobQueue.length,
            queuedJobs: jobQueue.map(j => ({
                id: j.id,
                tabId: j.tabId,
                pageUrl: j.pageUrl,
                totalToOpen: j.urlsToOpen.length,
                totalToMark: j.subforumUrlsToMarkAsRead.length + j.threadUrlsToMarkAsRead.length
            })),
            lastCompletedJob
        });
        return true;
    }

    if (request.action === 'expandProgress') {
        const tabId = (sender && sender.tab && sender.tab.id) || request.tabId || null;
        const pageUrl = normalizeUrl((sender && sender.tab && sender.tab.url) || request.pageUrl || '');

        if (request.done) {
            activeExpandState = null;
        } else {
            activeExpandState = {
                tabId,
                pageUrl,
                stage: 'expanding',
                current: request.current || 0,
                total: request.total || 1,
                currentTitle: request.currentTitle || ''
            };
            notifyPopup({
                action: 'scanProgress',
                stage: 'expanding',
                tabId,
                pageUrl,
                current: activeExpandState.current,
                total: activeExpandState.total,
                currentTitle: activeExpandState.currentTitle,
                queueLength: jobQueue.length
            });
        }
        sendResponse({ status: 'ok' });
        return true;
    }

    if (request.action === 'processLinks') {
        activeExpandState = null;
        const tabId = (sender && sender.tab && sender.tab.id) || request.tabId || null;
        const rawPageUrl = (sender && sender.tab && sender.tab.url) || request.pageUrl || '';
        const pageUrl = normalizeUrl(rawPageUrl);

        // Guard against accidental double-presses or duplicate concurrent jobs for the same page
        if (isDuplicateJobRequest(tabId, pageUrl)) {
            sendResponse({
                status: 'already_queued',
                queueLength: jobQueue.length,
                activeJobId: activeJob ? activeJob.id : null
            });
            return true;
        }

        const key = `${tabId || 'no-tab'}::${pageUrl || 'no-url'}`;
        recentJobTimestamps.set(key, Date.now());

        const urlsToOpen = Array.isArray(request.urlsToOpen) ? request.urlsToOpen : [];
        const subforumUrlsToMarkAsRead = Array.isArray(request.subforumUrlsToMarkAsRead) ? request.subforumUrlsToMarkAsRead : [];
        const threadUrlsToMarkAsRead = Array.isArray(request.threadUrlsToMarkAsRead) ? request.threadUrlsToMarkAsRead : [];

        const job = {
            id: ++jobIdCounter,
            tabId,
            pageUrl,
            urlsToOpen,
            subforumUrlsToMarkAsRead,
            threadUrlsToMarkAsRead,
            needsUnreadRedirectGrace: Boolean(request.needsUnreadRedirectGrace),
            expandedSubforumsCount: request.expandedSubforumsCount || 0,
            csrfToken: request.csrfToken || '',
            enqueuedAt: Date.now()
        };

        jobQueue.push(job);
        const queuePosition = jobQueue.length;
        const willQueueBehindActive = isProcessingQueue;

        if (willQueueBehindActive) {
            notifyPopup({
                action: 'queueUpdated',
                jobId: job.id,
                tabId: job.tabId,
                pageUrl: job.pageUrl,
                queueLength: jobQueue.length,
                activeJob: activeJob ? { ...activeJob } : null
            });
        }

        // Kick off sequential queue processor
        processQueue();

        sendResponse({
            status: willQueueBehindActive ? 'queued' : 'processing',
            jobId: job.id,
            queuePosition,
            queueLength: jobQueue.length
        });
        return true;
    }

    return false;
});

/**
 * Processes queued link-opening and mark-as-read jobs strictly sequentially.
 */
async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        while (jobQueue.length > 0) {
            const job = jobQueue.shift();
            await executeJob(job);
        }
    } finally {
        activeJob = null;
        isProcessingQueue = false;
    }
}

/**
 * Executes a single job:
 * 1. Opens tabs in exact sequential hierarchy order with rate-limit-safe stagger.
 * 2. Marks ignored subforums & threads as read using a paced, retry-protected worker pool.
 */
async function executeJob(job) {
    const totalToOpen = job.urlsToOpen.length;
    const subforums = job.subforumUrlsToMarkAsRead;
    const threads = job.threadUrlsToMarkAsRead;
    const totalToMark = subforums.length + threads.length;

    let openedCount = 0;
    let markedCount = 0;

    activeJob = {
        id: job.id,
        tabId: job.tabId,
        pageUrl: job.pageUrl,
        stage: totalToOpen > 0 ? 'opening' : 'marking',
        current: 0,
        total: totalToOpen > 0 ? totalToOpen : totalToMark,
        openedCount: 0,
        markedCount: 0,
        totalToOpen,
        totalToMark,
        expandedSubforumsCount: job.expandedSubforumsCount || 0
    };

    try {
        // 1. Open requested URLs in new background tabs strictly in order
        if (totalToOpen > 0) {
            for (let i = 0; i < totalToOpen; i++) {
                const urlObj = job.urlsToOpen[i];
                const url = typeof urlObj === 'string' ? urlObj : (urlObj && urlObj.url);
                if (url) {
                    try {
                        await browser.tabs.create({ url: url, active: false });
                        openedCount++;
                    } catch (tabErr) {
                        console.warn(`Failed to open tab for URL: ${url}`, tabErr);
                    }
                }

                activeJob.stage = 'opening';
                activeJob.current = i + 1;
                activeJob.total = totalToOpen;
                activeJob.openedCount = openedCount;

                notifyPopup({
                    action: 'scanProgress',
                    jobId: job.id,
                    tabId: job.tabId,
                    pageUrl: job.pageUrl,
                    stage: 'opening',
                    current: i + 1,
                    total: totalToOpen,
                    openedCount,
                    markedCount,
                    totalToOpen,
                    totalToMark,
                    expandedSubforumsCount: job.expandedSubforumsCount || 0,
                    queueLength: jobQueue.length
                });

                if (i < totalToOpen - 1 && TAB_OPEN_DELAY_MS > 0) {
                    await delay(TAB_OPEN_DELAY_MS);
                }
            }
        }

        // 2. Mark ignored subforums and threads as read with paced concurrency + 429 backoff
        if (totalToMark > 0) {
            // If we opened watched `/unread` threads in a subforum that will now be bulk-marked read,
            // give the opened tabs a brief grace window to resolve their initial `/unread` 302 redirect.
            if (job.needsUnreadRedirectGrace && totalToOpen > 0) {
                await delay(650);
            }

            let processedCount = 0;

            const markTasks = [
                ...subforums.map(url => ({ type: 'subforum', url })),
                ...threads.map(url => ({ type: 'thread', url }))
            ];

            await runConcurrentPool(markTasks, MARK_READ_CONCURRENCY, async (task) => {
                let ok = false;
                if (task.type === 'subforum') {
                    ok = await markSubforumAsRead(task.url, job.csrfToken);
                } else {
                    ok = await markThreadAsRead(task.url);
                }

                if (ok) markedCount++;
                processedCount++;

                activeJob.stage = 'marking';
                activeJob.current = processedCount;
                activeJob.total = totalToMark;
                activeJob.markedCount = markedCount;

                notifyPopup({
                    action: 'scanProgress',
                    jobId: job.id,
                    tabId: job.tabId,
                    pageUrl: job.pageUrl,
                    stage: 'marking',
                    current: processedCount,
                    total: totalToMark,
                    openedCount,
                    markedCount,
                    totalToOpen,
                    totalToMark,
                    expandedSubforumsCount: job.expandedSubforumsCount || 0,
                    queueLength: jobQueue.length
                });
            });
        }

        lastCompletedJob = {
            id: job.id,
            tabId: job.tabId,
            pageUrl: job.pageUrl,
            openedCount,
            markedCount,
            totalToOpen,
            totalToMark,
            expandedSubforumsCount: job.expandedSubforumsCount || 0,
            completedAt: Date.now(),
            error: null
        };

        notifyPopup({
            action: 'scanResults',
            jobId: job.id,
            tabId: job.tabId,
            pageUrl: job.pageUrl,
            openedCount,
            markedCount,
            totalToOpen,
            totalToMark,
            expandedSubforumsCount: job.expandedSubforumsCount || 0,
            queueLength: jobQueue.length
        });
    } catch (error) {
        console.error('Error in executeJob:', error);
        lastCompletedJob = {
            id: job.id,
            tabId: job.tabId,
            pageUrl: job.pageUrl,
            openedCount,
            markedCount,
            totalToOpen,
            totalToMark,
            expandedSubforumsCount: job.expandedSubforumsCount || 0,
            completedAt: Date.now(),
            error: 'Background error: ' + error.message
        };

        notifyPopup({
            action: 'scanResults',
            jobId: job.id,
            tabId: job.tabId,
            pageUrl: job.pageUrl,
            openedCount,
            markedCount,
            totalToOpen,
            totalToMark,
            expandedSubforumsCount: job.expandedSubforumsCount || 0,
            queueLength: jobQueue.length,
            error: 'Background error: ' + error.message
        });
    }
}

/**
 * Sends a lightweight JSON POST request to XenForo mark-read endpoint to clear subforum unread status.
 */
async function markSubforumAsRead(subforumUrl, csrfToken) {
    let markReadUrl = subforumUrl;
    if (!markReadUrl.endsWith('/')) {
        markReadUrl += '/';
    }
    markReadUrl += 'mark-read';

    const body = new URLSearchParams();
    body.append('_xfToken', csrfToken);
    body.append('confirm', '1');
    body.append('_xfResponseType', 'json');

    try {
        const response = await fetchWithRateLimitRetry(
            markReadUrl,
            {
                method: 'POST',
                body: body,
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': 'application/json, text/javascript, */*; q=0.01'
                }
            },
            false
        );
        if (response && response.ok) {
            return true;
        } else {
            console.warn(`Failed to mark subforum as read: ${subforumUrl} (Status: ${response && response.status})`);
            return false;
        }
    } catch (error) {
        console.error(`Error marking subforum as read: ${subforumUrl}`, error);
        return false;
    }
}

/**
 * Sends a GET request to a thread URL to clear its unread status,
 * with rate-limit pacing, retry/backoff, and early body stream abort.
 */
async function markThreadAsRead(threadUrl) {
    try {
        const response = await fetchWithRateLimitRetry(
            threadUrl,
            {
                method: 'GET',
                credentials: 'same-origin'
            },
            true
        );
        return Boolean(response && response.ok);
    } catch (error) {
        console.error(`Error marking thread as read: ${threadUrl}`, error);
        return false;
    }
}

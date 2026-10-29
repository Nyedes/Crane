// background.js

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const TAB_OPEN_DELAY_MS = 500;
const MARK_READ_DELAY_MS = 400;
const DUPLICATE_JOB_COOLDOWN_MS = 1500;

// Sequential Job Queue State
const jobQueue = [];
let activeJob = null;
let activeExpandState = null;
let isProcessingQueue = false;
let lastCompletedJob = null;
let jobIdCounter = 0;
const recentJobTimestamps = new Map();

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
 * Executes a single job: opens tabs with pacing delays, then marks ignored items as read.
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
        // 1. Open requested URLs in new background tabs with a delay
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

                if (i < totalToOpen - 1) {
                    await delay(TAB_OPEN_DELAY_MS);
                }
            }
        }

        // 2. Mark ignored subforums and threads as read sequentially with a delay
        if (totalToMark > 0) {
            let processedCount = 0;

            for (let i = 0; i < subforums.length; i++) {
                const ok = await markSubforumAsRead(subforums[i], job.csrfToken);
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

                if (processedCount < totalToMark) {
                    await delay(MARK_READ_DELAY_MS);
                }
            }

            for (let i = 0; i < threads.length; i++) {
                const ok = await markThreadAsRead(threads[i]);
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

                if (processedCount < totalToMark) {
                    await delay(MARK_READ_DELAY_MS);
                }
            }
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
 * Sends a POST request to XenForo mark-read endpoint to clear subforum unread status.
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

    try {
        const response = await fetch(markReadUrl, {
            method: 'POST',
            body: body,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
        if (response.ok) {
            console.log(`Successfully marked subforum as read: ${subforumUrl}`);
            return true;
        } else {
            console.warn(`Failed to mark subforum as read: ${subforumUrl} (Status: ${response.status})`);
            return false;
        }
    } catch (error) {
        console.error(`Error marking subforum as read: ${subforumUrl}`, error);
        return false;
    }
}

/**
 * Sends a GET request to a thread URL to clear its unread status.
 */
async function markThreadAsRead(threadUrl) {
    try {
        const response = await fetch(threadUrl, {
            method: 'GET'
        });
        if (response.ok) {
            console.log(`Successfully marked thread as read: ${threadUrl}`);
            return true;
        } else {
            console.warn(`Failed to mark thread as read: ${threadUrl} (Status: ${response.status})`);
            return false;
        }
    } catch (error) {
        console.error(`Error marking thread as read: ${threadUrl}`, error);
        return false;
    }
}

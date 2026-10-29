// popup.js

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

document.addEventListener('DOMContentLoaded', () => {
    const openUnreadButton = document.getElementById('openLinksBtn');
    const expandAllButton = document.getElementById('expandAllBtn');
    const expandAllLabel = document.getElementById('expandAllLabel');
    const addRuleForPageButton = document.getElementById('addRuleForPage');
    const unreadCountLabel = document.getElementById('unreadCountLabel');
    const pipelineDiv = document.getElementById('pipeline');
    const queueBadge = document.getElementById('queueBadge');
    const settingsBtn = document.getElementById('popupSettingsBtn');
    const configureAllRulesBtn = document.getElementById('configureAllRules');

    let currentTab = null;
    let isScanTriggering = false;
    let isNavigationLocked = false;

    const pipelineSteps = [
        { id: 'scan', name: 'Scan Active Page', status: 'pending', detail: '', progress: undefined },
        { id: 'open', name: 'Open Target Tabs', status: 'pending', detail: '', progress: undefined },
        { id: 'clear', name: 'Clear Ignored Items', status: 'pending', detail: '', progress: undefined }
    ];

    // Map of stepId -> cached DOM references for surgical in-place updates (no full innerHTML wipe)
    const stepDomRefs = new Map();

    function initPipelineDOM() {
        if (!pipelineDiv) return;
        pipelineDiv.innerHTML = '';
        stepDomRefs.clear();

        pipelineSteps.forEach(step => {
            const row = document.createElement('div');
            const dot = document.createElement('div');
            const label = document.createElement('span');
            const progressWrap = document.createElement('div');
            const progressBar = document.createElement('div');
            const icon = document.createElement('span');

            progressWrap.className = 'flex-grow h-[2px] bg-outline-variant/30 ml-sm rounded-full overflow-hidden hidden';
            progressBar.className = 'h-full bg-primary';
            progressBar.style.width = '0%';
            progressBar.style.transition = 'width 0.25s ease';
            progressWrap.appendChild(progressBar);

            icon.className = 'material-symbols-outlined text-sm ml-auto hidden';
            icon.style.fontVariationSettings = "'FILL' 1";

            row.appendChild(dot);
            row.appendChild(label);
            row.appendChild(progressWrap);
            row.appendChild(icon);

            pipelineDiv.appendChild(row);
            stepDomRefs.set(step.id, { row, dot, label, progressWrap, progressBar, icon });
            updateStepDOM(step);
        });
    }

    /**
     * Updates a single pipeline step's DOM node in place without recreating elements,
     * preserving CSS transitions and keyframe animations.
     */
    function updateStepDOM(step) {
        const refs = stepDomRefs.get(step.id);
        if (!refs) return;

        const { row, dot, label, progressWrap, progressBar, icon } = refs;
        const detailSuffix = step.detail ? ` (${step.detail})` : '';

        if (step.status === 'done') {
            row.className = 'flex items-center gap-sm pl-md group opacity-60';
            dot.className = 'status-dot bg-green-600';
            label.className = 'font-body-md text-on-surface-variant line-through';
            label.textContent = `${step.name}${detailSuffix}`;
            progressWrap.classList.add('hidden');
            icon.className = 'material-symbols-outlined text-sm text-green-600 ml-auto';
            icon.textContent = 'check_circle';
        } else if (step.status === 'active') {
            row.className = 'flex items-center gap-sm pl-md bg-secondary-container/10 py-xs -ml-[13px] border-l-4 border-primary rounded-r-md';
            dot.className = 'status-dot active bg-primary ml-2';
            label.className = 'font-body-md font-semibold text-primary truncate';
            label.textContent = `${step.name}${detailSuffix}`;

            if (step.progress !== undefined) {
                progressWrap.classList.remove('hidden');
                progressBar.style.width = `${Math.max(0, Math.min(100, step.progress))}%`;
            } else {
                progressWrap.classList.add('hidden');
                progressBar.style.width = '0%';
            }
            icon.className = 'material-symbols-outlined text-sm ml-auto hidden';
            icon.textContent = '';
        } else if (step.status === 'error') {
            row.className = 'flex items-center gap-sm pl-md group';
            dot.className = 'status-dot bg-red-600';
            label.className = 'font-body-md text-red-600 font-semibold truncate flex-grow';
            label.textContent = step.detail ? `${step.name}: ${step.detail}` : step.name;
            label.title = step.detail || '';
            progressWrap.classList.add('hidden');
            icon.className = 'material-symbols-outlined text-sm text-red-600 ml-auto';
            icon.textContent = 'error';
        } else {
            // Pending
            row.className = 'flex items-center gap-sm pl-md opacity-40';
            dot.className = 'status-dot bg-on-surface-variant';
            label.className = 'font-body-md text-on-surface-variant';
            label.textContent = `${step.name}${detailSuffix}`;
            progressWrap.classList.add('hidden');
            progressBar.style.width = '0%';
            icon.className = 'material-symbols-outlined text-sm ml-auto hidden';
            icon.textContent = '';
        }
    }

    function setStepStatus(stepId, status, detail = undefined, progress = undefined) {
        const step = pipelineSteps.find(s => s.id === stepId);
        if (!step) return;
        step.status = status;
        if (detail !== undefined) {
            step.detail = detail;
        }
        step.progress = progress;
        updateStepDOM(step);
    }

    function resetPipeline(isExpand = false) {
        pipelineSteps[0].name = isExpand ? 'Expand Hierarchy' : 'Scan Active Page';
        pipelineSteps.forEach(step => {
            step.status = 'pending';
            step.detail = '';
            step.progress = undefined;
            updateStepDOM(step);
        });
    }

    function setActionButtonsDisabled(disabled) {
        openUnreadButton.disabled = disabled;
        if (expandAllButton) expandAllButton.disabled = disabled;
    }

    function updateQueueBadge(queueLength) {
        if (!queueBadge) return;
        if (queueLength && queueLength > 0) {
            queueBadge.textContent = `${queueLength} QUEUED`;
            queueBadge.classList.remove('hidden');
        } else {
            queueBadge.textContent = '';
            queueBadge.classList.add('hidden');
        }
    }

    function isValidForumTab(tab) {
        return Boolean(tab && tab.url && tab.url.startsWith('https://www.skyscrapercity.com/'));
    }

    function isTabInActiveOrQueued(tab, activeJob, queuedJobs = [], activeExpandState = null) {
        if (!tab) return { isActive: false, isQueued: false, queuePos: -1 };
        const normTabUrl = normalizeUrl(tab.url);

        const isExpanding = Boolean(
            activeExpandState &&
            ((tab.id && activeExpandState.tabId === tab.id) || (normTabUrl && activeExpandState.pageUrl === normTabUrl))
        );

        const isActive = isExpanding || Boolean(
            activeJob &&
            ((tab.id && activeJob.tabId === tab.id) || (normTabUrl && activeJob.pageUrl === normTabUrl))
        );

        const qIdx = queuedJobs.findIndex(j =>
            (tab.id && j.tabId === tab.id) || (normTabUrl && j.pageUrl === normTabUrl)
        );

        return { isActive, isQueued: qIdx !== -1, queuePos: qIdx + 1 };
    }

    /**
     * Synchronizes UI with any active expansion or queued job running in background.js.
     */
    function applyQueueStatusToUI(status) {
        if (!status) return;
        updateQueueBadge(status.queueLength || 0);

        if (status.activeExpandState) {
            const exp = status.activeExpandState;
            pipelineSteps[0].name = 'Expand Hierarchy';
            const progressVal = exp.total > 0 ? Math.round((exp.current / exp.total) * 100) : 50;
            setStepStatus('scan', 'active', `${exp.current}/${exp.total}`, progressVal);
            unreadCountLabel.textContent = `Expanding subforums (${exp.current}/${exp.total})`;
            if (expandAllLabel) {
                expandAllLabel.textContent = exp.currentTitle
                    ? `Scanning: ${exp.currentTitle}`
                    : `Expanding (${exp.current}/${exp.total})...`;
            }
        }

        const active = status.activeJob;
        if (active) {
            if (active.expandedSubforumsCount > 0) {
                pipelineSteps[0].name = 'Expand Hierarchy';
                setStepStatus('scan', 'done', `${active.expandedSubforumsCount} subforums`);
            } else {
                pipelineSteps[0].name = 'Scan Active Page';
                setStepStatus('scan', 'done', 'Scanned');
            }

            if (active.stage === 'opening') {
                const progressVal = active.total > 0 ? Math.round((active.current / active.total) * 100) : 100;
                setStepStatus('open', 'active', `${active.current}/${active.total}`, progressVal);
                setStepStatus('clear', 'pending', active.totalToMark > 0 ? `${active.totalToMark} pending` : '');
                unreadCountLabel.textContent = `Opening tabs (${active.current}/${active.total})`;
            } else if (active.stage === 'marking') {
                setStepStatus('open', 'done', active.totalToOpen > 0 ? `Opened ${active.openedCount}` : '0 tabs needed');
                const progressVal = active.total > 0 ? Math.round((active.current / active.total) * 100) : 100;
                setStepStatus('clear', 'active', `${active.current}/${active.total}`, progressVal);
                unreadCountLabel.textContent = `Clearing unread (${active.current}/${active.total})`;
            }
        }

        if (isValidForumTab(currentTab) && (status.activeExpandState || active)) {
            const { isActive, isQueued, queuePos } = isTabInActiveOrQueued(
                currentTab,
                active,
                status.queuedJobs,
                status.activeExpandState
            );
            if (isActive || isQueued) {
                setActionButtonsDisabled(true);
                if (isQueued) {
                    unreadCountLabel.textContent = `Queued (#${queuePos} in line)`;
                }
            } else {
                // Different forum tab: allow queuing this tab behind the active job
                setActionButtonsDisabled(false);
                unreadCountLabel.textContent = 'Click to Queue This Page';
            }
        }
    }

    // Initialize pipeline DOM once
    initPipelineDOM();

    // Check current tab status and query background queue state
    Promise.all([
        browser.tabs.query({ active: true, currentWindow: true }),
        browser.runtime.sendMessage({ action: 'getQueueStatus' }).catch(() => null)
    ]).then(([tabs, queueStatus]) => {
        currentTab = tabs[0];
        if (isValidForumTab(currentTab)) {
            setActionButtonsDisabled(false);
            addRuleForPageButton.disabled = false;
            unreadCountLabel.textContent = 'Ready to Scan Page';
            setStepStatus('scan', 'active', 'Click Open or Expand');

            if (queueStatus && (queueStatus.isProcessing || queueStatus.queueLength > 0)) {
                applyQueueStatusToUI(queueStatus);
            }
        } else {
            setActionButtonsDisabled(true);
            addRuleForPageButton.disabled = true;
            unreadCountLabel.textContent = 'Not a Forum Page';
            setStepStatus('scan', 'error', 'Navigate to Skyscraper City');
            if (queueStatus) {
                updateQueueBadge(queueStatus.queueLength || 0);
            }
        }
    });

    /**
     * Opens or focuses the options page, preventing duplicate tabs from accidental double presses.
     */
    async function openOptionsPage(queryParams = '') {
        if (isNavigationLocked) return;
        isNavigationLocked = true;
        try {
            const baseOptionsUrl = browser.runtime.getURL('options.html');
            const targetUrl = queryParams ? `${baseOptionsUrl}${queryParams}` : baseOptionsUrl;
            const existingTabs = await browser.tabs.query({});
            const existingOptionsTab = existingTabs.find(t => t.url && t.url.startsWith(baseOptionsUrl));

            if (existingOptionsTab) {
                await browser.tabs.update(existingOptionsTab.id, { url: targetUrl, active: true });
            } else {
                await browser.tabs.create({ url: targetUrl });
            }
        } finally {
            setTimeout(() => {
                isNavigationLocked = false;
            }, 400);
        }
    }

    // Open options page for this tab's rules
    addRuleForPageButton.addEventListener('click', () => {
        if (currentTab && currentTab.url) {
            openOptionsPage(`?pageUrl=${encodeURIComponent(currentTab.url)}`);
        }
    });

    // Header Settings click
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            openOptionsPage();
        });
    }

    // Footer All Rules click
    if (configureAllRulesBtn) {
        configureAllRulesBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openOptionsPage();
        });
    }

    /**
     * Triggers either a single-page scan (expand = false) or a full hierarchical deep-open (expand = true).
     */
    async function triggerScanAction({ expand = false } = {}) {
        if (isScanTriggering || openUnreadButton.disabled) return;
        isScanTriggering = true;
        setActionButtonsDisabled(true);

        resetPipeline(expand);
        setStepStatus('scan', 'active', expand ? 'Expanding subforums...' : 'Scanning DOM...');
        unreadCountLabel.textContent = expand ? 'Expanding hierarchy...' : 'Scanning...';
        if (expand && expandAllLabel) {
            expandAllLabel.textContent = 'Scanning subforums in saved order...';
        }

        try {
            if (!currentTab) {
                setStepStatus('scan', 'error', 'No active tab');
                unreadCountLabel.textContent = 'No Active Tab';
                setActionButtonsDisabled(false);
                return;
            }

            // Check if content.js is loaded (ping)
            let loaded = false;
            try {
                const pingResponse = await browser.tabs.sendMessage(currentTab.id, { action: 'ping' });
                if (pingResponse && pingResponse.status === 'pong') {
                    loaded = true;
                }
            } catch (e) {
                loaded = false;
            }

            // Inject content script if not active
            if (!loaded) {
                await browser.scripting.executeScript({
                    target: { tabId: currentTab.id },
                    files: ['content.js']
                });
            }

            const actionName = expand ? 'expandAll' : 'scanPage';
            const response = await browser.tabs.sendMessage(currentTab.id, { action: actionName });
            if (!response) return;

            if (response.status === 'error' || response.status === 'empty') {
                setStepStatus('scan', 'error', response.error || 'No unread items found.');
                unreadCountLabel.textContent = response.status === 'empty' ? 'No Unread Links' : 'Scan Failed';
                if (expandAllLabel) expandAllLabel.textContent = 'Open Subforums + Threads in Hierarchy';
                setActionButtonsDisabled(false);
            } else if (response.status === 'busy' || response.status === 'already_queued') {
                setStepStatus('scan', 'done', 'Already active');
                unreadCountLabel.textContent = 'Already Scanning / Queued';
                setActionButtonsDisabled(true);
            } else if (response.status === 'queued') {
                updateQueueBadge(response.queueLength || 1);
                setStepStatus('scan', 'done', 'Queued');
                setStepStatus('open', 'pending', `${response.totalToOpen || 0} queued`);
                setStepStatus('clear', 'pending', `${response.totalToMark || 0} queued`);
                unreadCountLabel.textContent = `Queued (#${response.queueLength || 1} in line)`;
                setActionButtonsDisabled(true);
            }
        } catch (error) {
            console.error('Failed to execute scan action:', error);
            setStepStatus('scan', 'error', error.message);
            unreadCountLabel.textContent = 'Scan Error';
            if (expandAllLabel) expandAllLabel.textContent = 'Open Subforums + Threads in Hierarchy';
            setActionButtonsDisabled(false);
        } finally {
            setTimeout(() => {
                isScanTriggering = false;
            }, 350);
        }
    }

    // Standard single-page scan button
    openUnreadButton.addEventListener('click', () => {
        triggerScanAction({ expand: false });
    });

    // Expand & Open All button (hierarchical deep scan)
    if (expandAllButton) {
        expandAllButton.addEventListener('click', () => {
            triggerScanAction({ expand: true });
        });
    }

    // Listen for progress and queue updates
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!request) return false;

        if (request.action === 'queueUpdated') {
            updateQueueBadge(request.queueLength || 0);
        } else if (request.action === 'scanProgress') {
            updateQueueBadge(request.queueLength || 0);

            if (request.stage === 'expanding') {
                pipelineSteps[0].name = 'Expand Hierarchy';
                const progressVal = request.total > 0 ? Math.round((request.current / request.total) * 100) : 50;
                setStepStatus('scan', 'active', `${request.current}/${request.total}`, progressVal);
                unreadCountLabel.textContent = `Expanding subforums (${request.current}/${request.total})`;
                if (expandAllLabel) {
                    expandAllLabel.textContent = request.currentTitle
                        ? `Scanning: ${request.currentTitle}`
                        : `Expanding (${request.current}/${request.total})...`;
                }
            } else if (request.stage === 'opening') {
                if (request.expandedSubforumsCount > 0) {
                    pipelineSteps[0].name = 'Expand Hierarchy';
                    setStepStatus('scan', 'done', `${request.expandedSubforumsCount} subforums`);
                } else {
                    setStepStatus('scan', 'done', 'Scanned');
                }
                const progressVal = request.total > 0 ? Math.round((request.current / request.total) * 100) : 100;
                setStepStatus('open', 'active', `${request.current}/${request.total}`, progressVal);
                if (request.totalToMark !== undefined) {
                    setStepStatus('clear', 'pending', request.totalToMark > 0 ? `${request.totalToMark} pending` : '');
                }
                unreadCountLabel.textContent = `Opening tabs (${request.current}/${request.total})`;
                if (expandAllLabel && request.expandedSubforumsCount > 0) {
                    expandAllLabel.textContent = `Opening hierarchy (${request.current}/${request.total})...`;
                }
            } else if (request.stage === 'marking') {
                if (request.expandedSubforumsCount > 0) {
                    pipelineSteps[0].name = 'Expand Hierarchy';
                    setStepStatus('scan', 'done', `${request.expandedSubforumsCount} subforums`);
                } else {
                    setStepStatus('scan', 'done', 'Scanned');
                }
                const openedText = request.totalToOpen > 0 ? `Opened ${request.openedCount}` : '0 tabs needed';
                setStepStatus('open', 'done', openedText);
                const progressVal = request.total > 0 ? Math.round((request.current / request.total) * 100) : 100;
                setStepStatus('clear', 'active', `${request.current}/${request.total}`, progressVal);
                unreadCountLabel.textContent = `Clearing unread (${request.current}/${request.total})`;
            }
        } else if (request.action === 'scanResults') {
            updateQueueBadge(request.queueLength || 0);
            if (expandAllLabel) {
                expandAllLabel.textContent = 'Open Subforums + Threads in Hierarchy';
            }

            if (request.error) {
                setStepStatus('scan', 'error', request.error);
                unreadCountLabel.textContent = 'Error';
            } else {
                const openedCount = request.openedCount || 0;
                const markedCount = request.markedCount || 0;
                const totalToMark = request.totalToMark || 0;
                const expandedCount = request.expandedSubforumsCount || 0;

                if (expandedCount > 0) {
                    pipelineSteps[0].name = 'Expand Hierarchy';
                    setStepStatus('scan', 'done', `${expandedCount} subforums`);
                } else {
                    setStepStatus('scan', 'done', 'Scanned');
                }
                setStepStatus('open', 'done', openedCount > 0 ? `Opened ${openedCount}` : '0 tabs needed');
                setStepStatus('clear', 'done', totalToMark > 0 ? `Cleared ${markedCount}/${totalToMark}` : 'None to clear');

                if (openedCount > 0 && markedCount > 0) {
                    unreadCountLabel.textContent = `Opened ${openedCount} • Cleared ${markedCount}`;
                } else if (openedCount > 0) {
                    unreadCountLabel.textContent = `Opened ${openedCount} tab${openedCount === 1 ? '' : 's'}`;
                } else if (markedCount > 0) {
                    unreadCountLabel.textContent = `Cleared ${markedCount} ignored item${markedCount === 1 ? '' : 's'}`;
                } else {
                    unreadCountLabel.textContent = 'No new unread links';
                }
            }

            // Re-enable buttons if no more jobs are queued for the current tab
            if (!request.queueLength || request.queueLength === 0) {
                setActionButtonsDisabled(!isValidForumTab(currentTab));
            }
        }

        sendResponse({ status: 'Received' });
        return true;
    });
});

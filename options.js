// options.js

// Helper to escape HTML special characters to prevent broken attributes or DOM injection
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Helper to normalize URLs for reliable comparisons
function normalizeUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        let path = u.pathname.toLowerCase();

        // Match XenForo thread patterns: /threads/slug-name.12345/page-X or /threads/slug-name.12345/unread
        const threadMatch = path.match(/^\/threads\/[^/]+\.(\d+)/);
        if (threadMatch) {
            return (u.origin + threadMatch[0]).toLowerCase();
        }

        // Match XenForo forum patterns: /forums/slug-name.12345/page-X
        const forumMatch = path.match(/^\/forums\/[^/]+\.(\d+)/);
        if (forumMatch) {
            return (u.origin + forumMatch[0]).toLowerCase();
        }

        if (path.endsWith('/')) {
            path = path.slice(0, -1);
        }
        return (u.origin + path).toLowerCase();
    } catch (e) {
        let clean = String(url).trim().toLowerCase();
        if (clean.endsWith('/')) {
            clean = clean.slice(0, -1);
        }
        return clean;
    }
}

// Helper to extract a friendly title from a XenForo URL
function getFriendlyUrlTitle(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const path = u.pathname.toLowerCase();

        // Check if it's a thread URL: e.g. /threads/sydney-airport.460346/page-124
        const threadMatch = path.match(/\/threads\/([^/]+)/);
        if (threadMatch) {
            let segment = threadMatch[1].replace(/\.\d+$/, '');
            let name = decodeURIComponent(segment).replace(/[-_.]+/g, ' ');
            return name
                .split(' ')
                .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ');
        }

        // Check if it's a forum URL: e.g. /forums/transportation.297/page-2
        const forumMatch = path.match(/\/forums\/([^/]+)/);
        if (forumMatch) {
            let segment = forumMatch[1].replace(/\.\d+$/, '');
            let name = decodeURIComponent(segment).replace(/[-_.]+/g, ' ');
            return name
                .split(' ')
                .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ');
        }

        // Fallback to the last path segment for other URLs
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length > 0) {
            let lastSegment = parts[parts.length - 1];
            let name = decodeURIComponent(lastSegment).replace(/[-_.]+/g, ' ');
            name = name
                .split(' ')
                .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ');
            if (!name || /^\d+$/.test(name.trim())) {
                return u.hostname + u.pathname;
            }
            return name;
        }
        return u.hostname + u.pathname;
    } catch (e) {
        let clean = String(url).trim();
        clean = clean.replace(/\.\d+\/?$/, '').replace(/[-_.]+/g, ' ');
        if (clean) {
            return clean
                .split(' ')
                .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ');
        }
        return String(url);
    }
}

// Helper to deduplicate target URLs based on their normalized form
function deduplicateUrls(urls) {
    const seen = new Set();
    const unique = [];
    (urls || []).forEach(url => {
        const norm = normalizeUrl(url);
        if (norm && !seen.has(norm)) {
            seen.add(norm);
            unique.push(url);
        }
    });
    return unique;
}

document.addEventListener('DOMContentLoaded', () => {
    const statusDiv = document.getElementById('status');

    // --- Subforum Rule Elements ---
    const subforumPageUrlInput = document.getElementById('subforumPageUrl');
    const customSubforumsTextarea = document.getElementById('customSubforums');
    const addSubforumRuleButton = document.getElementById('addSubforumRuleButton');
    const subforumOrderModeSelect = document.getElementById('subforumOrderMode');

    // --- Thread Rule Elements ---
    const threadPageUrlInput = document.getElementById('threadPageUrl');
    const customThreadsTextarea = document.getElementById('customThreads');
    const addThreadRuleButton = document.getElementById('addThreadRuleButton');
    const threadOrderModeSelect = document.getElementById('threadOrderMode');

    // --- Tab Switcher Elements ---
    const tabBtnDashboard = document.getElementById('tabBtnDashboard');
    const tabBtnCreate = document.getElementById('tabBtnCreate');
    const tabContentDashboard = document.getElementById('tabContentDashboard');
    const tabContentCreate = document.getElementById('tabContentCreate');

    // --- Search & Filter Elements ---
    const dashboardSearchInput = document.getElementById('dashboardSearch');
    const dashboardTypeFilter = document.getElementById('dashboardTypeFilter');
    const dashboardGrid = document.getElementById('dashboardGrid');

    let subforumRules = [];
    let threadRules = [];

    // --- Toast Notification Management ---
    let statusTimeoutId = null;
    function setStatus(message, isError = false) {
        if (!statusDiv) return;
        if (statusTimeoutId) {
            clearTimeout(statusTimeoutId);
        }
        statusDiv.textContent = message;
        statusDiv.style.background = isError ? 'rgba(239, 68, 68, 0.95)' : 'rgba(16, 185, 129, 0.95)';
        statusDiv.style.border = isError ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)';
        statusTimeoutId = setTimeout(() => {
            statusDiv.textContent = '';
            statusTimeoutId = null;
        }, 3000);
    }

    // --- Anti-Double-Press Cooldown Guard & Sequential Action Queue ---
    const actionCooldowns = new Map();

    /**
     * Prevents accidental double-clicks on buttons with the same key within `cooldownMs`.
     */
    function isAccidentalDoublePress(key, cooldownMs = 300) {
        const now = Date.now();
        const lastTime = actionCooldowns.get(key) || 0;
        if (now - lastTime < cooldownMs) {
            return true;
        }
        actionCooldowns.set(key, now);
        return false;
    }

    // Sequential queue for rapid UI actions (e.g., clicking Move Up/Down multiple times quickly)
    const uiActionQueue = [];
    let isRunningUiQueue = false;

    function enqueueUiAction(fn) {
        uiActionQueue.push(fn);
        if (!isRunningUiQueue) {
            isRunningUiQueue = true;
            while (uiActionQueue.length > 0) {
                const nextAction = uiActionQueue.shift();
                try {
                    nextAction();
                } catch (err) {
                    console.error('Error in queued UI action:', err);
                }
            }
            isRunningUiQueue = false;
        }
    }

    // --- Coalesced & Serialized Storage Write Queue ---
    let storageSaveTimer = null;
    let pendingStorageChain = Promise.resolve();
    let pendingSubforumSave = false;
    let pendingThreadSave = false;
    let pendingToastMessage = null;

    function queueStorageSave({ saveSubforums = false, saveThreads = false, toastMessage = null } = {}) {
        if (saveSubforums) pendingSubforumSave = true;
        if (saveThreads) pendingThreadSave = true;
        if (toastMessage) pendingToastMessage = toastMessage;

        if (storageSaveTimer) {
            clearTimeout(storageSaveTimer);
        }

        storageSaveTimer = setTimeout(() => {
            storageSaveTimer = null;
            const payload = {};
            if (pendingSubforumSave) {
                payload.subforumRules = subforumRules.map(r => ({
                    pageUrl: r.pageUrl,
                    subforumUrls: [...(r.subforumUrls || [])],
                    orderMode: r.orderMode || 'custom'
                }));
                pendingSubforumSave = false;
            }
            if (pendingThreadSave) {
                payload.threadRules = threadRules.map(r => ({
                    pageUrl: r.pageUrl,
                    threadUrls: [...(r.threadUrls || [])],
                    orderMode: r.orderMode || 'custom'
                }));
                pendingThreadSave = false;
            }
            const msgToShow = pendingToastMessage;
            pendingToastMessage = null;

            if (Object.keys(payload).length > 0) {
                pendingStorageChain = pendingStorageChain
                    .then(() => browser.storage.sync.set(payload))
                    .then(() => {
                        if (msgToShow) setStatus(msgToShow);
                    })
                    .catch(err => {
                        console.error('Failed to save rules to storage:', err);
                        setStatus('Failed to save rules: ' + err.message, true);
                    });
            }
        }, 180);
    }

    // --- Tab Switcher Logic ---
    function switchTab(targetTab) {
        if (targetTab === 'dashboard') {
            tabBtnDashboard.classList.add('active');
            tabBtnCreate.classList.remove('active');
            tabContentDashboard.classList.add('active');
            tabContentCreate.classList.remove('active');
        } else {
            tabBtnCreate.classList.add('active');
            tabBtnDashboard.classList.remove('active');
            tabContentCreate.classList.add('active');
            tabContentDashboard.classList.remove('active');
        }
    }

    tabBtnDashboard.addEventListener('click', () => {
        if (tabBtnDashboard.classList.contains('active')) return;
        switchTab('dashboard');
    });

    tabBtnCreate.addEventListener('click', () => {
        if (tabBtnCreate.classList.contains('active')) return;
        switchTab('create');
    });

    // --- Live Prefill / Existing Rule Detection ---
    function checkExistingSubforumRule() {
        const pageUrl = subforumPageUrlInput.value.trim();
        if (!pageUrl) {
            clearSubforumFormStatus();
            return;
        }
        const normUrl = normalizeUrl(pageUrl);
        const existing = subforumRules.find(r => normalizeUrl(r.pageUrl) === normUrl);

        let statusLabel = document.getElementById('subforumFormStatus');
        if (!statusLabel) {
            statusLabel = document.createElement('div');
            statusLabel.id = 'subforumFormStatus';
            statusLabel.style.fontSize = '12px';
            statusLabel.style.marginTop = '6px';
            statusLabel.style.fontWeight = '600';
            subforumPageUrlInput.parentNode.appendChild(statusLabel);
        }

        if (existing) {
            customSubforumsTextarea.value = existing.subforumUrls.join('\n');
            subforumOrderModeSelect.value = existing.orderMode || 'custom';
            statusLabel.textContent = `⚡ Pre-existing rule loaded. Contains ${existing.subforumUrls.length} subforum URL(s).`;
            statusLabel.style.color = '#9e3d00';
        } else {
            statusLabel.textContent = '';
        }
    }

    function clearSubforumFormStatus() {
        const statusLabel = document.getElementById('subforumFormStatus');
        if (statusLabel) statusLabel.textContent = '';
    }

    function checkExistingThreadRule() {
        const pageUrl = threadPageUrlInput.value.trim();
        if (!pageUrl) {
            clearThreadFormStatus();
            return;
        }
        const normUrl = normalizeUrl(pageUrl);
        const existing = threadRules.find(r => normalizeUrl(r.pageUrl) === normUrl);

        let statusLabel = document.getElementById('threadFormStatus');
        if (!statusLabel) {
            statusLabel = document.createElement('div');
            statusLabel.id = 'threadFormStatus';
            statusLabel.style.fontSize = '12px';
            statusLabel.style.marginTop = '6px';
            statusLabel.style.fontWeight = '600';
            threadPageUrlInput.parentNode.appendChild(statusLabel);
        }

        if (existing) {
            customThreadsTextarea.value = existing.threadUrls.join('\n');
            threadOrderModeSelect.value = existing.orderMode || 'custom';
            statusLabel.textContent = `⚡ Pre-existing rule loaded. Contains ${existing.threadUrls.length} thread URL(s).`;
            statusLabel.style.color = '#9e3d00';
        } else {
            statusLabel.textContent = '';
        }
    }

    function clearThreadFormStatus() {
        const statusLabel = document.getElementById('threadFormStatus');
        if (statusLabel) statusLabel.textContent = '';
    }

    subforumPageUrlInput.addEventListener('input', checkExistingSubforumRule);
    subforumPageUrlInput.addEventListener('change', checkExistingSubforumRule);
    threadPageUrlInput.addEventListener('input', checkExistingThreadRule);
    threadPageUrlInput.addEventListener('change', checkExistingThreadRule);

    // --- Helper to find a rule object by type and normalized pageUrl ---
    function findRuleAndIndex(type, ruleKey) {
        const list = type === 'subforum' ? subforumRules : threadRules;
        const index = list.findIndex(r => normalizeUrl(r.pageUrl) === ruleKey);
        return { list, rule: index !== -1 ? list[index] : null, index };
    }

    // --- Creator Form Submit Handlers ---
    function addSubforumRule() {
        if (isAccidentalDoublePress('addSubforumRuleButton', 400)) return;

        const pageUrl = subforumPageUrlInput.value.trim();
        const rawUrls = customSubforumsTextarea.value.split('\n').map(url => url.trim()).filter(Boolean);
        const subforumUrls = deduplicateUrls(rawUrls);
        const orderMode = subforumOrderModeSelect.value;

        if (!pageUrl || subforumUrls.length === 0) {
            setStatus('Please provide a page URL and at least one subforum URL.', true);
            return;
        }

        const ruleKey = normalizeUrl(pageUrl);
        const existingRuleIndex = subforumRules.findIndex(rule => normalizeUrl(rule.pageUrl) === ruleKey);
        if (existingRuleIndex > -1) {
            if (!confirm('A rule already exists for this page. Do you want to overwrite it with the new configuration?')) {
                return;
            }
            subforumRules[existingRuleIndex].subforumUrls = subforumUrls;
            subforumRules[existingRuleIndex].orderMode = orderMode;
            upsertDashboardCard('subforum', subforumRules[existingRuleIndex]);
        } else {
            const newRule = { pageUrl, subforumUrls, orderMode };
            subforumRules.push(newRule);
            upsertDashboardCard('subforum', newRule);
        }

        queueStorageSave({ saveSubforums: true, toastMessage: 'Subforum rules saved!' });
        subforumPageUrlInput.value = '';
        customSubforumsTextarea.value = '';
        subforumOrderModeSelect.value = 'custom';
        clearSubforumFormStatus();
    }

    function addThreadRule() {
        if (isAccidentalDoublePress('addThreadRuleButton', 400)) return;

        const pageUrl = threadPageUrlInput.value.trim();
        const rawUrls = customThreadsTextarea.value.split('\n').map(url => url.trim()).filter(Boolean);
        const threadUrls = deduplicateUrls(rawUrls);
        const orderMode = threadOrderModeSelect.value;

        if (!pageUrl || threadUrls.length === 0) {
            setStatus('Please provide a subforum page URL and at least one thread URL.', true);
            return;
        }

        const ruleKey = normalizeUrl(pageUrl);
        const existingRuleIndex = threadRules.findIndex(rule => normalizeUrl(rule.pageUrl) === ruleKey);
        if (existingRuleIndex > -1) {
            if (!confirm('A rule already exists for this page. Do you want to overwrite it with the new configuration?')) {
                return;
            }
            threadRules[existingRuleIndex].threadUrls = threadUrls;
            threadRules[existingRuleIndex].orderMode = orderMode;
            upsertDashboardCard('thread', threadRules[existingRuleIndex]);
        } else {
            const newRule = { pageUrl, threadUrls, orderMode };
            threadRules.push(newRule);
            upsertDashboardCard('thread', newRule);
        }

        queueStorageSave({ saveThreads: true, toastMessage: 'Thread rules saved!' });
        threadPageUrlInput.value = '';
        customThreadsTextarea.value = '';
        threadOrderModeSelect.value = 'custom';
        clearThreadFormStatus();
    }

    // --- Surgical Dashboard Card Rendering (No Unnecessary Full UI Refresh) ---

    // Tracks which subforum items have their nested child rules expanded in the Dashboard
    const expandedNestedItems = new Set();

    function findNestedRulesForTargetUrl(targetUrl) {
        const normTarget = normalizeUrl(targetUrl);
        if (!normTarget) return { nestedSubRule: null, nestedThreadRule: null };

        const matchFn = (rule) => {
            const normRulePage = normalizeUrl(rule.pageUrl);
            if (!normRulePage) return false;
            if (normRulePage === normTarget) return true;
            const cleanTarget = normTarget.replace(/^\/+/, '');
            return Boolean(cleanTarget) && normRulePage.endsWith('/' + cleanTarget);
        };

        const nestedSubRule = subforumRules.find(r => matchFn(r) && normalizeUrl(r.pageUrl) !== normTarget ? true : matchFn(r)) || null;
        const nestedThreadRule = threadRules.find(matchFn) || null;
        return { nestedSubRule, nestedThreadRule };
    }

    function getModeBadgeText(mode) {
        if (mode === 'bottomToTop') return 'MODE: Bottom-To-Top';
        if (mode === 'topToBottom') return 'MODE: Top-To-Bottom';
        return 'MODE: Specific';
    }

    function buildCardItemsHtml(rule, type) {
        const urls = (type === 'subforum' ? rule.subforumUrls : rule.threadUrls) || [];
        const currentMode = rule.orderMode || 'custom';
        const parentRuleKey = normalizeUrl(rule.pageUrl);

        if (urls.length === 0) {
            return `<div class="text-[12px] text-on-surface-variant/60 italic py-2 text-center">No target links configured. Add one below.</div>`;
        }

        return urls.map((url, itemIdx) => {
            const friendlyItemTitle = escapeHtml(getFriendlyUrlTitle(url));
            const escapedUrl = escapeHtml(url);
            const normItemUrl = normalizeUrl(url);
            const expandKey = `${parentRuleKey}::${normItemUrl}`;
            const isExpanded = expandedNestedItems.has(expandKey);

            let nestedBadgeHtml = '';
            let nestedDrawerHtml = '';

            if (type === 'subforum' && normItemUrl !== parentRuleKey) {
                const { nestedSubRule, nestedThreadRule } = findNestedRulesForTargetUrl(url);
                const nestedSubUrls = (nestedSubRule && nestedSubRule.subforumUrls) || [];
                const nestedThreadUrls = (nestedThreadRule && nestedThreadRule.threadUrls) || [];
                const totalNested = nestedSubUrls.length + nestedThreadUrls.length;

                if (totalNested > 0) {
                    nestedBadgeHtml = `
                        <button type="button" class="card-btn-toggle-nested px-1.5 py-0.5 rounded bg-secondary-container/20 hover:bg-secondary-container/35 text-primary text-[10px] font-label-caps font-bold flex items-center gap-0.5 shrink-0 transition-colors" data-expand-key="${escapeHtml(expandKey)}" title="Expand nested rules for this subforum">
                            <span>↳ ${totalNested}</span>
                            <span class="material-symbols-outlined text-[12px] pointer-events-none">${isExpanded ? 'expand_less' : 'expand_more'}</span>
                        </button>
                    `;

                    if (isExpanded) {
                        const subRows = nestedSubUrls.map((subU, sIdx) => `
                            <div class="flex items-center gap-1.5 text-[11px] text-on-surface-variant py-0.5 pl-2 border-l-2 border-secondary-container/50">
                                <span class="material-symbols-outlined text-[12px] text-secondary">folder</span>
                                <span class="font-label-caps text-[10px] text-primary font-bold">#${sIdx + 1}</span>
                                <span class="truncate" title="${escapeHtml(subU)}">${escapeHtml(getFriendlyUrlTitle(subU))}</span>
                            </div>
                        `).join('');

                        const threadRows = nestedThreadUrls.map((thU, tIdx) => `
                            <div class="flex items-center gap-1.5 text-[11px] text-on-surface-variant py-0.5 pl-2 border-l-2 border-primary/40">
                                <span class="material-symbols-outlined text-[12px] text-primary">chat_bubble</span>
                                <span class="font-label-caps text-[10px] text-primary font-bold">#${tIdx + 1}</span>
                                <span class="truncate" title="${escapeHtml(thU)}">${escapeHtml(getFriendlyUrlTitle(thU))}</span>
                            </div>
                        `).join('');

                        nestedDrawerHtml = `
                            <div class="mt-1.5 pt-1.5 border-t border-outline-variant/15 pl-3 flex flex-col gap-1 bg-surface-container-low/60 rounded p-1.5">
                                <div class="text-[9px] font-label-caps uppercase text-on-surface-variant/70 font-bold">Nested Hierarchy Order</div>
                                ${subRows}
                                ${threadRows}
                            </div>
                        `;
                    }
                }
            }

            return `
                <div class="flex flex-col p-2 rounded hover:bg-white/50 transition-all border border-outline-variant/10 bg-surface-container-lowest" data-item-idx="${itemIdx}">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2 overflow-hidden flex-1 pr-sm">
                            <span class="font-bold text-primary text-[11px] font-label-caps">#${itemIdx + 1}</span>
                            <span class="text-body-md text-on-surface truncate" title="${escapedUrl}">${friendlyItemTitle}</span>
                            ${nestedBadgeHtml}
                        </div>
                        <div class="flex items-center gap-1">
                            ${currentMode === 'custom' ? `
                                <button type="button" class="card-btn-move-up p-1 hover:bg-surface-container-high rounded text-primary transition-all disabled:opacity-30 disabled:pointer-events-none" data-item-idx="${itemIdx}" title="Move Up" ${itemIdx === 0 ? 'disabled' : ''}>▲</button>
                                <button type="button" class="card-btn-move-down p-1 hover:bg-surface-container-high rounded text-primary transition-all disabled:opacity-30 disabled:pointer-events-none" data-item-idx="${itemIdx}" title="Move Down" ${itemIdx === urls.length - 1 ? 'disabled' : ''}>▼</button>
                            ` : ''}
                            <button type="button" class="card-btn-remove-item p-1 hover:bg-error-container hover:text-error rounded text-outline transition-all" data-item-idx="${itemIdx}" title="Remove">×</button>
                        </div>
                    </div>
                    ${nestedDrawerHtml}
                </div>
            `;
        }).join('');
    }

    function createRuleCardElement(rule, type) {
        const ruleKey = normalizeUrl(rule.pageUrl);
        const urls = (type === 'subforum' ? rule.subforumUrls : rule.threadUrls) || [];
        const typeLabel = type === 'subforum' ? 'Subforum Rule' : 'Thread Rule';
        const typeIcon = type === 'subforum' ? 'folder' : 'chat_bubble';
        const typeBadgeColor = type === 'subforum'
            ? 'bg-secondary-container/15 text-on-secondary-fixed-variant'
            : 'bg-primary-container/10 text-primary';
        const friendlyName = escapeHtml(getFriendlyUrlTitle(rule.pageUrl));
        const escapedPageUrl = escapeHtml(rule.pageUrl);
        const currentMode = rule.orderMode || 'custom';

        const card = document.createElement('div');
        card.className = 'rule-card bg-surface-container-lowest rounded-2xl border border-outline-variant/20 card-elevation overflow-hidden active-beam p-lg flex flex-col gap-md group transition-all duration-200';
        card.setAttribute('data-rule-type', type);
        card.setAttribute('data-rule-key', ruleKey);

        card.innerHTML = `
            <div class="flex justify-between items-start border-b border-outline-variant/20 pb-sm">
                <div class="space-y-1 overflow-hidden flex-1 pr-sm">
                    <div class="flex items-center gap-sm">
                        <span class="material-symbols-outlined text-primary text-md" style="font-variation-settings: 'FILL' 1;">${typeIcon}</span>
                        <a class="font-headline-md text-headline-md text-primary hover:underline truncate block" href="${escapedPageUrl}" target="_blank" title="${escapedPageUrl}">${friendlyName}</a>
                    </div>
                    <div class="flex flex-wrap items-center gap-sm">
                        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${typeBadgeColor} font-label-caps uppercase tracking-wider">${typeLabel}</span>
                        <span class="card-mode-badge px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant text-[10px] font-label-caps uppercase tracking-wider font-bold">${getModeBadgeText(currentMode)}</span>
                    </div>
                </div>
                <div class="flex gap-xs">
                    <button type="button" class="btn-visit-page p-2 hover:bg-surface-container-high rounded-xl text-outline transition-colors" data-url="${escapedPageUrl}" title="Open Page"><span class="material-symbols-outlined text-sm pointer-events-none">open_in_new</span></button>
                    <button type="button" class="btn-edit-form p-2 hover:bg-surface-container-high rounded-xl text-outline transition-colors" title="Load in Form"><span class="material-symbols-outlined text-sm pointer-events-none">edit</span></button>
                    <button type="button" class="btn-delete-rule p-2 hover:bg-error-container hover:text-error rounded-xl text-outline transition-colors" title="Delete Rule"><span class="material-symbols-outlined text-sm pointer-events-none">delete</span></button>
                </div>
            </div>
            <div class="space-y-sm flex-grow">
                <div class="text-[11px] text-on-surface-variant/40 truncate font-mono select-all" title="${escapedPageUrl}">${escapedPageUrl}</div>

                <div class="flex items-center justify-between gap-md py-xs border-b border-outline-variant/10">
                    <span class="text-label-caps font-label-caps text-on-surface-variant/70 text-[11px] font-bold">Opening Order</span>
                    <select class="card-order-mode-select bg-surface-container-low border border-outline-variant/20 focus:border-primary focus:ring-0 rounded px-2 py-1 text-[11px] font-semibold text-primary transition-all cursor-pointer">
                        <option value="custom" ${currentMode === 'custom' ? 'selected' : ''}>Specific Order</option>
                        <option value="bottomToTop" ${currentMode === 'bottomToTop' ? 'selected' : ''}>Bottom to Top</option>
                        <option value="topToBottom" ${currentMode === 'topToBottom' ? 'selected' : ''}>Top to Bottom</option>
                    </select>
                </div>
                <div class="card-links-count font-label-caps text-[11px] text-on-surface-variant/70 font-bold mb-xs">${urls.length} target link(s) configured</div>

                <div class="card-items-list bg-surface-container-low rounded-xl p-md max-h-40 overflow-y-auto border border-outline-variant/10 custom-scrollbar flex flex-col gap-2">
                    ${buildCardItemsHtml(rule, type)}
                </div>
                <div class="flex items-center gap-xs mt-sm pt-xs border-t border-outline-variant/10">
                    <input type="text" class="card-new-item-input flex-grow bg-surface-container-low border-none border-b-2 border-outline-variant focus:border-primary focus:ring-0 rounded-t px-sm py-1.5 text-body-md transition-all placeholder:text-[11px]" placeholder="Add page or thread URL...">
                    <button type="button" class="btn-add-item bg-primary text-on-primary hover:bg-on-primary-fixed-variant px-3 py-1.5 rounded transition-all active:scale-95 text-lg font-bold">+</button>
                </div>
            </div>
        `;

        return card;
    }

    /**
     * Updates ONLY a single card's internal DOM (items list, count, mode badge, dropdown)
     * while preserving its internal scroll position and input field value.
     */
    function updateSingleCardDOM(cardEl, rule, type) {
        if (!cardEl || !rule) return;
        const urls = (type === 'subforum' ? rule.subforumUrls : rule.threadUrls) || [];
        const currentMode = rule.orderMode || 'custom';

        const modeBadge = cardEl.querySelector('.card-mode-badge');
        if (modeBadge) modeBadge.textContent = getModeBadgeText(currentMode);

        const modeSelect = cardEl.querySelector('.card-order-mode-select');
        if (modeSelect && modeSelect.value !== currentMode) {
            modeSelect.value = currentMode;
        }

        const countEl = cardEl.querySelector('.card-links-count');
        if (countEl) countEl.textContent = `${urls.length} target link(s) configured`;

        const itemsListEl = cardEl.querySelector('.card-items-list');
        if (itemsListEl) {
            const prevScrollTop = itemsListEl.scrollTop;
            itemsListEl.innerHTML = buildCardItemsHtml(rule, type);
            itemsListEl.scrollTop = prevScrollTop;
        }
    }

    /**
     * Checks whether a rule matches the active search query and type filter.
     */
    function doesRuleMatchFilter(rule, type) {
        const searchQuery = dashboardSearchInput.value.trim().toLowerCase();
        const typeFilter = dashboardTypeFilter.value;

        if (typeFilter === 'subforums' && type !== 'subforum') return false;
        if (typeFilter === 'threads' && type !== 'thread') return false;

        if (!searchQuery) return true;

        const matchUrl = rule.pageUrl.toLowerCase().includes(searchQuery);
        const matchFriendlyPage = getFriendlyUrlTitle(rule.pageUrl).toLowerCase().includes(searchQuery);
        if (matchUrl || matchFriendlyPage) return true;

        const itemsList = (type === 'subforum' ? rule.subforumUrls : rule.threadUrls) || [];
        return itemsList.some(itemUrl =>
            itemUrl.toLowerCase().includes(searchQuery) ||
            getFriendlyUrlTitle(itemUrl).toLowerCase().includes(searchQuery)
        );
    }

    function renderEmptyDashboardState(hasSearchQuery) {
        dashboardGrid.innerHTML = `
            <div class="empty-state bg-surface-container-lowest rounded-2xl border border-outline-variant/20 p-xl text-center space-y-sm" style="grid-column: 1 / -1;">
                <span class="material-symbols-outlined text-4xl text-outline">search_off</span>
                <h3 class="font-headline-md text-headline-md text-on-surface">No rules match your filters</h3>
                <p class="text-body-md text-on-surface-variant">${hasSearchQuery ? 'Try adjusting your search query.' : 'Click "Create New Rule" to get started!'}</p>
            </div>
        `;
    }

    /**
     * Inserts or updates a single rule card in the dashboard without wiping other cards.
     */
    function upsertDashboardCard(type, rule) {
        const ruleKey = normalizeUrl(rule.pageUrl);
        const existingCard = dashboardGrid.querySelector(
            `.rule-card[data-rule-type="${type}"][data-rule-key="${CSS.escape(ruleKey)}"]`
        );

        if (!doesRuleMatchFilter(rule, type)) {
            if (existingCard) {
                existingCard.remove();
                if (!dashboardGrid.querySelector('.rule-card')) {
                    renderEmptyDashboardState(Boolean(dashboardSearchInput.value.trim()));
                }
            }
            return;
        }

        const emptyState = dashboardGrid.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        if (existingCard) {
            updateSingleCardDOM(existingCard, rule, type);
        } else {
            const newCard = createRuleCardElement(rule, type);
            dashboardGrid.appendChild(newCard);
        }
    }

    /**
     * Full dashboard render used ONLY on initial load or when search/filter criteria change.
     */
    function renderDashboard() {
        const searchQuery = dashboardSearchInput.value.trim().toLowerCase();
        const fragment = document.createDocumentFragment();
        let matchedCount = 0;

        subforumRules.forEach(rule => {
            if (doesRuleMatchFilter(rule, 'subforum')) {
                fragment.appendChild(createRuleCardElement(rule, 'subforum'));
                matchedCount++;
            }
        });

        threadRules.forEach(rule => {
            if (doesRuleMatchFilter(rule, 'thread')) {
                fragment.appendChild(createRuleCardElement(rule, 'thread'));
                matchedCount++;
            }
        });

        dashboardGrid.innerHTML = '';
        if (matchedCount === 0) {
            renderEmptyDashboardState(Boolean(searchQuery));
        } else {
            dashboardGrid.appendChild(fragment);
        }
    }

    // --- Event Delegation on Dashboard Grid (Single Listener Set, Zero Re-binding Leaks) ---

    function handleAddItemToCard(cardEl) {
        const type = cardEl.getAttribute('data-rule-type');
        const ruleKey = cardEl.getAttribute('data-rule-key');
        const inputEl = cardEl.querySelector('.card-new-item-input');
        if (!inputEl) return;

        const urlToAdd = inputEl.value.trim();
        if (!urlToAdd) return;

        if (isAccidentalDoublePress(`addItem::${type}::${ruleKey}`, 250)) return;

        enqueueUiAction(() => {
            const { rule } = findRuleAndIndex(type, ruleKey);
            if (!rule) return;

            const normToAdd = normalizeUrl(urlToAdd);
            const targetArray = type === 'subforum' ? rule.subforumUrls : rule.threadUrls;
            const exists = targetArray.some(u => normalizeUrl(u) === normToAdd);

            if (exists) {
                setStatus(`This ${type} (or an equivalent page of it) is already in the rule.`, true);
                inputEl.value = '';
                return;
            }

            targetArray.push(urlToAdd);
            inputEl.value = '';
            updateSingleCardDOM(cardEl, rule, type);

            // Keep newly added bottom item visible inside the card's scrollable list
            const itemsListEl = cardEl.querySelector('.card-items-list');
            if (itemsListEl) {
                itemsListEl.scrollTop = itemsListEl.scrollHeight;
            }

            queueStorageSave({
                saveSubforums: type === 'subforum',
                saveThreads: type === 'thread'
            });
        });
    }

    dashboardGrid.addEventListener('click', (e) => {
        const cardEl = e.target.closest('.rule-card');
        if (!cardEl) return;

        const type = cardEl.getAttribute('data-rule-type');
        const ruleKey = cardEl.getAttribute('data-rule-key');

        // 1. Visit Page button
        const visitBtn = e.target.closest('.btn-visit-page');
        if (visitBtn) {
            if (isAccidentalDoublePress(`visit::${ruleKey}`, 500)) return;
            const url = visitBtn.dataset.url;
            if (url) browser.tabs.create({ url });
            return;
        }

        // 1b. Toggle Nested Hierarchy Drawer inside a Subforum Card
        const toggleNestedBtn = e.target.closest('.card-btn-toggle-nested');
        if (toggleNestedBtn) {
            const expandKey = toggleNestedBtn.dataset.expandKey;
            if (!expandKey) return;
            if (expandedNestedItems.has(expandKey)) {
                expandedNestedItems.delete(expandKey);
            } else {
                expandedNestedItems.add(expandKey);
            }
            const { rule } = findRuleAndIndex(type, ruleKey);
            if (rule) {
                updateSingleCardDOM(cardEl, rule, type);
            }
            return;
        }

        // 2. Edit in Form button
        const editBtn = e.target.closest('.btn-edit-form');
        if (editBtn) {
            if (isAccidentalDoublePress(`editForm::${ruleKey}`, 300)) return;
            const { rule } = findRuleAndIndex(type, ruleKey);
            if (!rule) return;

            switchTab('create');

            if (type === 'subforum') {
                subforumPageUrlInput.value = rule.pageUrl;
                customSubforumsTextarea.value = rule.subforumUrls.join('\n');
                subforumOrderModeSelect.value = rule.orderMode || 'custom';
                checkExistingSubforumRule();
                subforumPageUrlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const cardContainer = document.getElementById('subforumCreatorCard');
                if (cardContainer) {
                    cardContainer.style.borderColor = '#fc8f34';
                    cardContainer.style.boxShadow = '0 0 20px rgba(252, 143, 52, 0.35)';
                    setTimeout(() => {
                        cardContainer.style.borderColor = '';
                        cardContainer.style.boxShadow = '';
                    }, 1200);
                }
            } else {
                threadPageUrlInput.value = rule.pageUrl;
                customThreadsTextarea.value = rule.threadUrls.join('\n');
                threadOrderModeSelect.value = rule.orderMode || 'custom';
                checkExistingThreadRule();
                threadPageUrlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const cardContainer = document.getElementById('threadCreatorCard');
                if (cardContainer) {
                    cardContainer.style.borderColor = '#fc8f34';
                    cardContainer.style.boxShadow = '0 0 20px rgba(252, 143, 52, 0.35)';
                    setTimeout(() => {
                        cardContainer.style.borderColor = '';
                        cardContainer.style.boxShadow = '';
                    }, 1200);
                }
            }
            return;
        }

        // 3. Delete Rule button
        const deleteRuleBtn = e.target.closest('.btn-delete-rule');
        if (deleteRuleBtn) {
            if (isAccidentalDoublePress(`deleteRule::${type}::${ruleKey}`, 500)) return;
            const { list, index } = findRuleAndIndex(type, ruleKey);
            if (index === -1) return;

            if (confirm(`Are you sure you want to delete this ${type} rule?`)) {
                list.splice(index, 1);
                cardEl.remove();
                if (!dashboardGrid.querySelector('.rule-card')) {
                    renderEmptyDashboardState(Boolean(dashboardSearchInput.value.trim()));
                }
                queueStorageSave({
                    saveSubforums: type === 'subforum',
                    saveThreads: type === 'thread',
                    toastMessage: `${type === 'subforum' ? 'Subforum' : 'Thread'} rule deleted.`
                });
            }
            return;
        }

        // 4. Move Item Up (queued sequentially for rapid multi-presses, updates card in place)
        const moveUpBtn = e.target.closest('.card-btn-move-up');
        if (moveUpBtn) {
            const itemIdx = parseInt(moveUpBtn.dataset.itemIdx, 10);
            enqueueUiAction(() => {
                const { rule } = findRuleAndIndex(type, ruleKey);
                if (!rule) return;
                const arr = type === 'subforum' ? rule.subforumUrls : rule.threadUrls;
                if (itemIdx > 0 && itemIdx < arr.length) {
                    const temp = arr[itemIdx];
                    arr[itemIdx] = arr[itemIdx - 1];
                    arr[itemIdx - 1] = temp;
                    updateSingleCardDOM(cardEl, rule, type);
                    queueStorageSave({
                        saveSubforums: type === 'subforum',
                        saveThreads: type === 'thread'
                    });
                }
            });
            return;
        }

        // 5. Move Item Down (queued sequentially for rapid multi-presses, updates card in place)
        const moveDownBtn = e.target.closest('.card-btn-move-down');
        if (moveDownBtn) {
            const itemIdx = parseInt(moveDownBtn.dataset.itemIdx, 10);
            enqueueUiAction(() => {
                const { rule } = findRuleAndIndex(type, ruleKey);
                if (!rule) return;
                const arr = type === 'subforum' ? rule.subforumUrls : rule.threadUrls;
                if (itemIdx >= 0 && itemIdx < arr.length - 1) {
                    const temp = arr[itemIdx];
                    arr[itemIdx] = arr[itemIdx + 1];
                    arr[itemIdx + 1] = temp;
                    updateSingleCardDOM(cardEl, rule, type);
                    queueStorageSave({
                        saveSubforums: type === 'subforum',
                        saveThreads: type === 'thread'
                    });
                }
            });
            return;
        }

        // 6. Remove Item from Rule (guarded against accidental double-press so adjacent item isn't deleted)
        const removeItemBtn = e.target.closest('.card-btn-remove-item');
        if (removeItemBtn) {
            if (isAccidentalDoublePress(`removeItem::${type}::${ruleKey}`, 280)) return;
            const itemIdx = parseInt(removeItemBtn.dataset.itemIdx, 10);
            enqueueUiAction(() => {
                const { rule } = findRuleAndIndex(type, ruleKey);
                if (!rule) return;
                const arr = type === 'subforum' ? rule.subforumUrls : rule.threadUrls;
                if (itemIdx >= 0 && itemIdx < arr.length) {
                    arr.splice(itemIdx, 1);
                    updateSingleCardDOM(cardEl, rule, type);
                    queueStorageSave({
                        saveSubforums: type === 'subforum',
                        saveThreads: type === 'thread'
                    });
                }
            });
            return;
        }

        // 7. Add Item button (+)
        const addItemBtn = e.target.closest('.btn-add-item');
        if (addItemBtn) {
            handleAddItemToCard(cardEl);
        }
    });

    // Order Mode Changed in Card Dropdown (delegated)
    dashboardGrid.addEventListener('change', (e) => {
        const selectEl = e.target.closest('.card-order-mode-select');
        if (!selectEl) return;

        const cardEl = selectEl.closest('.rule-card');
        if (!cardEl) return;

        const type = cardEl.getAttribute('data-rule-type');
        const ruleKey = cardEl.getAttribute('data-rule-key');
        const { rule } = findRuleAndIndex(type, ruleKey);
        if (!rule) return;

        const newVal = selectEl.value;
        const oldVal = rule.orderMode || 'custom';
        if (oldVal === newVal) return;

        const modeNames = {
            custom: 'Specific Order',
            bottomToTop: 'Bottom to Top',
            topToBottom: 'Top to Bottom'
        };

        const confirmed = confirm(
            `Are you sure you want to change the opening order mode from "${modeNames[oldVal]}" to "${modeNames[newVal]}"?`
        );
        if (confirmed) {
            rule.orderMode = newVal;
            updateSingleCardDOM(cardEl, rule, type);
            queueStorageSave({
                saveSubforums: type === 'subforum',
                saveThreads: type === 'thread',
                toastMessage: `Order mode updated to ${modeNames[newVal]}.`
            });
        } else {
            selectEl.value = oldVal;
        }
    });

    // Enter key on Card Add Item Input (delegated)
    dashboardGrid.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const inputEl = e.target.closest('.card-new-item-input');
        if (!inputEl) return;
        e.preventDefault();
        const cardEl = inputEl.closest('.rule-card');
        if (cardEl) handleAddItemToCard(cardEl);
    });

    // Debounced Search Input & Filter Change
    let searchDebounceTimer = null;
    dashboardSearchInput.addEventListener('input', () => {
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            renderDashboard();
        }, 120);
    });
    dashboardTypeFilter.addEventListener('change', renderDashboard);

    // --- Initial Load ---
    function loadAllRules() {
        browser.storage.sync.get(['subforumRules', 'threadRules'], (result) => {
            const loadedSub = result.subforumRules || [];
            const loadedThread = result.threadRules || [];

            // Retroactively deduplicate target URLs in loaded rules
            subforumRules = loadedSub.map(rule => ({
                ...rule,
                subforumUrls: deduplicateUrls(rule.subforumUrls || [])
            }));

            threadRules = loadedThread.map(rule => ({
                ...rule,
                threadUrls: deduplicateUrls(rule.threadUrls || [])
            }));

            const hasSubforumChanges = JSON.stringify(loadedSub) !== JSON.stringify(subforumRules);
            const hasThreadChanges = JSON.stringify(loadedThread) !== JSON.stringify(threadRules);

            if (hasSubforumChanges || hasThreadChanges) {
                queueStorageSave({
                    saveSubforums: hasSubforumChanges,
                    saveThreads: hasThreadChanges
                });
            }

            renderDashboard();
            prefillFromUrl();
        });
    }

    function prefillFromUrl() {
        const urlParams = new URLSearchParams(window.location.search);
        const pageUrl = urlParams.get('pageUrl');
        if (!pageUrl) return;

        const decodedUrl = decodeURIComponent(pageUrl);
        const normDecoded = normalizeUrl(decodedUrl);

        // Prefill manual forms so they are ready if the user switches to Create New Rule tab
        const existingThreadRule = threadRules.find(rule => normalizeUrl(rule.pageUrl) === normDecoded);
        const existingSubforumRule = subforumRules.find(rule => normalizeUrl(rule.pageUrl) === normDecoded);
        if (existingThreadRule) {
            threadPageUrlInput.value = decodedUrl;
            customThreadsTextarea.value = existingThreadRule.threadUrls.join('\n');
            threadOrderModeSelect.value = existingThreadRule.orderMode || 'custom';
            checkExistingThreadRule();
        } else if (existingSubforumRule) {
            subforumPageUrlInput.value = decodedUrl;
            customSubforumsTextarea.value = existingSubforumRule.subforumUrls.join('\n');
            subforumOrderModeSelect.value = existingSubforumRule.orderMode || 'custom';
            checkExistingSubforumRule();
        } else {
            subforumPageUrlInput.value = decodedUrl;
        }

        // Query the open tab to populate the Interactive Live Builder on the Dashboard tab
        browser.tabs.query({}).then((tabs) => {
            const targetBaseNorm = normalizeUrl(decodedUrl.split('#')[0]);
            const tab = tabs.find(t => {
                if (!t.url) return false;
                const tabNorm = normalizeUrl(t.url);
                return tabNorm === targetBaseNorm || tabNorm.startsWith(targetBaseNorm + '/');
            });

            if (!tab) {
                // If the source tab is no longer open, fall back to the manual Creator tab
                switchTab('create');
                return;
            }

            browser.scripting.executeScript({
                target: { tabId: tab.id },
                func: scrapePageForRules
            }).then((results) => {
                if (results && results[0] && results[0].result && results[0].result.success) {
                    const res = results[0].result;
                    if (res.type === 'threads') {
                        threadPageUrlInput.value = decodedUrl;
                        const exRule = threadRules.find(rule => normalizeUrl(rule.pageUrl) === normDecoded);
                        if (exRule) {
                            customThreadsTextarea.value = exRule.threadUrls.join('\n');
                            threadOrderModeSelect.value = exRule.orderMode || 'custom';
                        } else {
                            customThreadsTextarea.value = '';
                            threadOrderModeSelect.value = 'custom';
                        }
                        checkExistingThreadRule();
                    } else {
                        subforumPageUrlInput.value = decodedUrl;
                        const exRule = subforumRules.find(rule => normalizeUrl(rule.pageUrl) === normDecoded);
                        if (exRule) {
                            customSubforumsTextarea.value = exRule.subforumUrls.join('\n');
                            subforumOrderModeSelect.value = exRule.orderMode || 'custom';
                        } else {
                            customSubforumsTextarea.value = '';
                            subforumOrderModeSelect.value = 'custom';
                        }
                        checkExistingSubforumRule();
                    }

                    // Keep Dashboard tab active so the Live Builder in the right column is visible
                    switchTab('dashboard');
                    setupInteractiveBuilder(res.items, res.type, decodedUrl);
                } else {
                    switchTab('create');
                }
            }).catch(err => {
                console.error('Failed to execute script on tab:', err);
                switchTab('create');
            });
        });
    }

    /**
     * Unified Interactive Live Builder for both Subforums and Threads,
     * using scoped event delegation and in-place sequence preview updates.
     */
    function setupInteractiveBuilder(items, type, pageUrl) {
        const builderDiv = document.getElementById('interactiveBuilder');
        const builderPageUrl = document.getElementById('builderPageUrl');
        const builderContent = document.getElementById('builderContent');
        const saveBtn = document.getElementById('saveBuilderRuleButton');

        const isSubforums = type === 'subforums';
        const ruleTypeKey = isSubforums ? 'subforum' : 'thread';
        const rulesList = isSubforums ? subforumRules : threadRules;
        const normPageUrl = normalizeUrl(pageUrl);
        const existingRule = rulesList.find(r => normalizeUrl(r.pageUrl) === normPageUrl);
        const savedUrls = existingRule
            ? (isSubforums ? existingRule.subforumUrls : existingRule.threadUrls) || []
            : [];
        const savedOrderMode = existingRule ? (existingRule.orderMode || 'custom') : 'custom';

        builderDiv.style.display = 'block';
        builderPageUrl.textContent = pageUrl;
        builderPageUrl.href = pageUrl;

        // Initialize orderedItems in the saved custom order, preserving items not currently on page
        let orderedItems = [];
        savedUrls.forEach(url => {
            const normSaved = normalizeUrl(url);
            const found = items.find(item => normalizeUrl(item.url) === normSaved);
            if (found) {
                orderedItems.push(found);
            } else {
                orderedItems.push({
                    url: url,
                    title: url,
                    notOnPage: true
                });
            }
        });

        // If no rule exists yet, default to all items checked in bottom-to-top order
        if (!existingRule) {
            orderedItems = [...items].reverse();
        }

        const selectedNormSet = new Set(orderedItems.map(i => normalizeUrl(i.url)));
        const nounPlural = isSubforums ? 'subforums' : 'threads';
        const headerLabel = isSubforums ? 'SUBFORUMS DETECTED' : 'THREADS DETECTED';

        builderContent.innerHTML = `
            <p class="text-body-md text-on-surface-variant/80 mb-sm">Check the ${nounPlural} you want the scanner to open. Unchecked ${nounPlural} will be automatically marked as read.</p>
            <div class="flex justify-between items-center px-1 mb-xs">
                <span class="font-label-caps text-[11px] text-on-surface-variant/70 font-bold">${headerLabel} (${items.length})</span>
                <div class="flex gap-3">
                    <button type="button" class="text-primary text-[10px] font-bold hover:underline" id="builderSelectAll">SELECT ALL</button>
                    <button type="button" class="text-outline text-[10px] font-bold hover:underline" id="builderClearAll">CLEAR ALL</button>
                </div>
            </div>
            <div class="grid grid-cols-1 gap-2 max-h-56 overflow-y-auto pr-2 custom-scrollbar builder-checkbox-grid">
                ${items.map((item) => {
                    const normItem = normalizeUrl(item.url);
                    const isChecked = selectedNormSet.has(normItem) ? 'checked' : '';
                    const escapedUrl = escapeHtml(item.url);
                    const escapedTitle = escapeHtml(item.title);
                    return `
                        <label class="flex items-center gap-3 p-3 bg-surface-container-lowest border border-outline-variant/20 rounded-xl hover:bg-secondary-container/5 cursor-pointer transition-all group border-l-4 border-l-transparent hover:border-l-primary">
                            <input type="checkbox" class="builder-item-checkbox w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary" value="${escapedUrl}" data-title="${escapedTitle}" ${isChecked}>
                            <span class="text-body-md text-on-surface flex-grow truncate font-medium" title="${escapedTitle}">${escapedTitle}</span>
                            <span class="material-symbols-outlined opacity-0 group-hover:opacity-100 text-sm text-outline">drag_indicator</span>
                        </label>
                    `;
                }).join('')}
            </div>

            <!-- Sequencing Container -->
            <div id="sequencingContainer" class="pt-lg border-t border-outline-variant/20">
                <div class="flex justify-between items-center mb-3">
                    <span class="font-label-caps text-[11px] text-on-surface-variant/70 font-bold tracking-wider">SEQUENCE PREVIEW</span>
                    <select id="builderOrderMode" class="bg-surface-container-low border border-outline-variant/20 focus:border-primary focus:ring-0 rounded px-2 py-1 text-[11px] font-semibold text-primary transition-all cursor-pointer">
                        <option value="custom" ${savedOrderMode === 'custom' ? 'selected' : ''}>Specific Order</option>
                        <option value="bottomToTop" ${savedOrderMode === 'bottomToTop' ? 'selected' : ''}>Bottom to Top</option>
                        <option value="topToBottom" ${savedOrderMode === 'topToBottom' ? 'selected' : ''}>Top to Bottom</option>
                    </select>
                </div>
                <p id="builderSequencingHelp" class="text-[11px] text-on-surface-variant/60 mb-3 px-1"></p>
                <div id="orderList" class="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1 custom-scrollbar"></div>
            </div>
        `;

        const orderListDiv = builderContent.querySelector('#orderList');
        const builderOrderModeSelect = builderContent.querySelector('#builderOrderMode');
        const helpEl = builderContent.querySelector('#builderSequencingHelp');

        /**
         * Computes the effective sequence to display in the preview based on current order mode.
         */
        function getPreviewSequence() {
            const currentMode = builderOrderModeSelect.value;
            if (currentMode === 'custom') {
                return orderedItems;
            }
            const activeNorms = new Set(orderedItems.map(i => normalizeUrl(i.url)));
            const pageMatched = items.filter(item => activeNorms.has(normalizeUrl(item.url)));
            if (currentMode === 'bottomToTop') {
                pageMatched.reverse();
            }
            const offPageSaved = orderedItems.filter(i => i.notOnPage);
            return [...pageMatched, ...offPageSaved];
        }

        function renderOrderList() {
            const currentMode = builderOrderModeSelect.value;
            if (currentMode === 'custom') {
                helpEl.textContent = `Use the arrows to arrange the exact order in which these ${nounPlural} will be opened.`;
            } else if (currentMode === 'bottomToTop') {
                helpEl.textContent = `${isSubforums ? 'Subforums' : 'Threads'} will be opened from bottom to top (reversed page order).`;
            } else {
                helpEl.textContent = `${isSubforums ? 'Subforums' : 'Threads'} will be opened from top to bottom (original page order).`;
            }

            const previewItems = getPreviewSequence();
            if (previewItems.length === 0) {
                orderListDiv.style.display = 'none';
                orderListDiv.innerHTML = '';
                return;
            }

            const prevScroll = orderListDiv.scrollTop;
            orderListDiv.style.display = 'flex';
            orderListDiv.innerHTML = previewItems.map((item, idx) => {
                const titleText = escapeHtml(item.notOnPage ? getFriendlyUrlTitle(item.url) : item.title);
                const escapedUrl = escapeHtml(item.url);

                return `
                    <div class="flex items-center justify-between p-3 bg-surface-container-low border border-outline-variant/20 rounded-xl w-full" data-url="${escapedUrl}">
                        <div class="flex items-center gap-3 overflow-hidden flex-1">
                            <span class="font-bold text-primary text-sm font-label-caps">#${idx + 1}</span>
                            <span class="text-body-md text-on-surface font-semibold truncate" title="${escapedUrl}">${titleText}</span>
                            ${item.notOnPage ? `<span class="bg-outline-variant/20 text-outline text-[10px] px-2 py-0.5 rounded font-label-caps font-bold">Saved (Not on page)</span>` : ''}
                        </div>
                        ${currentMode === 'custom' ? `
                        <div class="flex gap-1">
                            <button type="button" class="builder-btn-move-up p-1.5 hover:bg-surface-container-high rounded text-primary transition-all disabled:opacity-30 disabled:pointer-events-none" data-index="${idx}" ${idx === 0 ? 'disabled' : ''}>▲</button>
                            <button type="button" class="builder-btn-move-down p-1.5 hover:bg-surface-container-high rounded text-primary transition-all disabled:opacity-30 disabled:pointer-events-none" data-index="${idx}" ${idx === previewItems.length - 1 ? 'disabled' : ''}>▼</button>
                        </div>
                        ` : ''}
                    </div>
                `;
            }).join('');
            orderListDiv.scrollTop = prevScroll;
        }

        renderOrderList();

        // Scoped event listeners on builderContent elements (no global selector leaks)
        builderOrderModeSelect.addEventListener('change', renderOrderList);

        orderListDiv.addEventListener('click', (e) => {
            const upBtn = e.target.closest('.builder-btn-move-up');
            if (upBtn) {
                const idx = parseInt(upBtn.dataset.index, 10);
                enqueueUiAction(() => {
                    if (idx > 0 && idx < orderedItems.length) {
                        const temp = orderedItems[idx];
                        orderedItems[idx] = orderedItems[idx - 1];
                        orderedItems[idx - 1] = temp;
                        renderOrderList();
                    }
                });
                return;
            }

            const downBtn = e.target.closest('.builder-btn-move-down');
            if (downBtn) {
                const idx = parseInt(downBtn.dataset.index, 10);
                enqueueUiAction(() => {
                    if (idx >= 0 && idx < orderedItems.length - 1) {
                        const temp = orderedItems[idx];
                        orderedItems[idx] = orderedItems[idx + 1];
                        orderedItems[idx + 1] = temp;
                        renderOrderList();
                    }
                });
            }
        });

        builderContent.querySelectorAll('.builder-item-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const url = e.target.value;
                const normUrl = normalizeUrl(url);
                const title = e.target.dataset.title;
                if (e.target.checked) {
                    if (!orderedItems.some(s => normalizeUrl(s.url) === normUrl)) {
                        orderedItems.push({ url, title });
                    }
                } else {
                    orderedItems = orderedItems.filter(s => normalizeUrl(s.url) !== normUrl);
                }
                renderOrderList();
            });
        });

        builderContent.querySelector('#builderSelectAll').addEventListener('click', () => {
            if (isAccidentalDoublePress('builderSelectAll', 250)) return;
            builderContent.querySelectorAll('.builder-item-checkbox').forEach(cb => {
                cb.checked = true;
                const url = cb.value;
                const normUrl = normalizeUrl(url);
                const title = cb.dataset.title;
                if (!orderedItems.some(s => normalizeUrl(s.url) === normUrl)) {
                    orderedItems.push({ url, title });
                }
            });
            renderOrderList();
        });

        builderContent.querySelector('#builderClearAll').addEventListener('click', () => {
            if (isAccidentalDoublePress('builderClearAll', 250)) return;
            builderContent.querySelectorAll('.builder-item-checkbox').forEach(cb => {
                cb.checked = false;
            });
            orderedItems = [];
            renderOrderList();
        });

        const newSaveHandler = () => {
            if (isAccidentalDoublePress('saveBuilderRuleButton', 400)) return;

            const effectiveSequence = getPreviewSequence();
            const checkedUrls = deduplicateUrls(effectiveSequence.map(s => s.url));
            const orderMode = builderOrderModeSelect.value;

            if (checkedUrls.length === 0) {
                setStatus(`Please select at least one ${ruleTypeKey} to open.`, true);
                return;
            }

            const existingIndex = rulesList.findIndex(r => normalizeUrl(r.pageUrl) === normPageUrl);
            let targetRule;
            if (existingIndex > -1) {
                if (isSubforums) {
                    rulesList[existingIndex].subforumUrls = checkedUrls;
                } else {
                    rulesList[existingIndex].threadUrls = checkedUrls;
                }
                rulesList[existingIndex].orderMode = orderMode;
                targetRule = rulesList[existingIndex];
            } else {
                targetRule = isSubforums
                    ? { pageUrl, subforumUrls: checkedUrls, orderMode }
                    : { pageUrl, threadUrls: checkedUrls, orderMode };
                rulesList.push(targetRule);
            }

            upsertDashboardCard(ruleTypeKey, targetRule);
            queueStorageSave({
                saveSubforums: isSubforums,
                saveThreads: !isSubforums,
                toastMessage: `${isSubforums ? 'Subforum' : 'Thread'} sequence saved from Live Builder!`
            });
        };

        const freshSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(freshSaveBtn, saveBtn);
        freshSaveBtn.addEventListener('click', newSaveHandler);

        // Smoothly highlight Live Builder when preloaded
        builderDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    addSubforumRuleButton.addEventListener('click', addSubforumRule);
    addThreadRuleButton.addEventListener('click', addThreadRule);

    loadAllRules();
});

// Standalone function used for dynamic execution inside page context
function scrapePageForRules() {
    const hasSubforums = document.querySelector('.p-body-pageContent .node-list');
    const hasThreads = document.querySelector('.p-body-pageContent .structItemContainer-group.js-threadList');

    if (hasSubforums) {
        const subforums = [];
        document.querySelectorAll('.node.node--forum').forEach(item => {
            const link = item.querySelector('.node-main .node-title a');
            if (link && link.href) {
                subforums.push({
                    url: link.href,
                    title: link.innerText.trim()
                });
            }
        });
        document.querySelectorAll('.subNodeLink').forEach(link => {
            if (link.href) {
                subforums.push({
                    url: link.href,
                    title: link.innerText.trim()
                });
            }
        });

        const uniqueSubforums = [];
        const seen = new Set();
        subforums.forEach(s => {
            if (!seen.has(s.url)) {
                seen.add(s.url);
                uniqueSubforums.push(s);
            }
        });
        return { success: true, type: 'subforums', items: uniqueSubforums };
    }

    if (hasThreads) {
        const threads = [];
        document.querySelectorAll('.structItem.structItem--thread').forEach(item => {
            const titleLink = item.querySelector('.structItem-title a[data-tp-primary="on"]');
            if (titleLink) {
                threads.push({
                    title: titleLink.innerText.trim(),
                    url: titleLink.href
                });
            }
        });
        return { success: true, type: 'threads', items: threads };
    }

    return { success: false, error: 'Page has no subforums or thread list.' };
}

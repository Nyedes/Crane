// content.js

if (!window.__skyscraperContentScriptLoaded) {
    window.__skyscraperContentScriptLoaded = true;
    console.log('Content script loaded');

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    let isScanning = false;
    let lastScanTimestamp = 0;
    const SCAN_COOLDOWN_MS = 1000;
    const EXPAND_FETCH_DELAY_MS = 300;
    const MAX_EXPAND_DEPTH = 3;

    // Helper to normalize URLs for reliable comparisons (stripping trailing slashes, pagination, post IDs, hashes, etc.)
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

    // Resolves a link's href safely against a base page URL (works for both live DOM and DOMParser documents)
    function resolveLinkUrl(linkEl, basePageUrl) {
        if (!linkEl) return '';
        const rawHref = linkEl.getAttribute('href');
        if (!rawHref) return '';
        try {
            return new URL(rawHref, basePageUrl).href;
        } catch (e) {
            return linkEl.href || '';
        }
    }

    // Extracts clean text from a link element in both live DOM and detached DOMParser documents
    function getLinkText(linkEl) {
        if (!linkEl) return '';
        return (linkEl.textContent || linkEl.innerText || '').trim();
    }

    // Boundary-safe rule page comparison (prevents /forums/slug.12 from matching /forums/slug.123)
    function isSameRulePage(currentNorm, rulePageUrl) {
        const ruleNorm = normalizeUrl(rulePageUrl);
        if (!currentNorm || !ruleNorm) return false;
        return currentNorm === ruleNorm || currentNorm.startsWith(ruleNorm + '/');
    }

    // Boundary-safe target link comparison (supports full URLs and shorthand slugs like "transport.297")
    function isMatchingTargetUrl(itemNorm, customNorm) {
        if (!itemNorm || !customNorm) return false;
        if (itemNorm === customNorm) return true;
        const cleanCustom = customNorm.replace(/^\/+/, '');
        return Boolean(cleanCustom) && itemNorm.endsWith('/' + cleanCustom);
    }

    // --- Subforum Page Logic (supports both live document and fetched DOMParser documents) ---
    function processSubforumsFromDoc(doc, pageUrl, rules, parentCuratedFilter = null) {
        const unreadLinks = [];
        const childToParentMap = new Map();

        doc.querySelectorAll('.node.node--forum').forEach(item => {
            const parentLink = item.querySelector('.node-main .node-title a');
            const parentUrl = resolveLinkUrl(parentLink, pageUrl);
            if (parentUrl) {
                const normParentUrl = normalizeUrl(parentUrl);

                // Build the parent-child relationship map for all subnodes
                item.querySelectorAll('.subNodeLink').forEach(subLink => {
                    const subUrl = resolveLinkUrl(subLink, pageUrl);
                    if (subUrl) {
                        childToParentMap.set(normalizeUrl(subUrl), normParentUrl);
                    }
                });

                if (item.querySelector('.node-icon .node--unread.forum')) {
                    unreadLinks.push({ url: parentUrl, title: getLinkText(parentLink) });
                }
            }
        });

        doc.querySelectorAll('.subNodeLink--unread').forEach(link => {
            const subUrl = resolveLinkUrl(link, pageUrl);
            if (subUrl) {
                unreadLinks.push({ url: subUrl, title: getLinkText(link) });
            }
        });

        // Deduplicate unreadLinks on the same page by normalized URL
        const uniqueUnreadLinks = [];
        const seenUnread = new Set();
        unreadLinks.forEach(item => {
            const norm = normalizeUrl(item.url);
            if (norm && !seenUnread.has(norm)) {
                seenUnread.add(norm);
                uniqueUnreadLinks.push(item);
            }
        });

        const currentNormalized = normalizeUrl(pageUrl);
        const matchingRule = rules.find(rule => isSameRulePage(currentNormalized, rule.pageUrl));

        // Use either the page's own matchingRule or a parent-curated filter if applicable
        const effectiveRule = matchingRule || parentCuratedFilter;

        if (effectiveRule) {
            const customUrls = (effectiveRule.subforumUrls || []).map(s => s.trim()).filter(Boolean);
            const normalizedCustom = customUrls.map(normalizeUrl);

            const matched = uniqueUnreadLinks.filter(item => {
                const normItem = normalizeUrl(item.url);
                return normalizedCustom.some(normCustom => isMatchingTargetUrl(normItem, normCustom));
            });

            const mode = effectiveRule.orderMode || 'custom';
            if (mode === 'custom') {
                matched.sort((a, b) => {
                    const normA = normalizeUrl(a.url);
                    const normB = normalizeUrl(b.url);
                    const indexA = normalizedCustom.findIndex(url => isMatchingTargetUrl(normA, url));
                    const indexB = normalizedCustom.findIndex(url => isMatchingTargetUrl(normB, url));
                    return indexA - indexB;
                });
            } else if (mode === 'bottomToTop') {
                matched.reverse();
            }

            const openedNormalized = new Set(matched.map(item => normalizeUrl(item.url)));

            // Precompute parent nodes that have at least one opened child in O(N)
            const parentsWithOpenedChild = new Set();
            for (const [normChildUrl, normParentUrl] of childToParentMap.entries()) {
                if (openedNormalized.has(normChildUrl)) {
                    parentsWithOpenedChild.add(normParentUrl);
                }
            }

            const urlsToMarkAsRead = uniqueUnreadLinks
                .map(item => item.url)
                .filter(url => {
                    const normUrl = normalizeUrl(url);

                    // 1. If this URL is directly being opened, do not mark it read
                    if (openedNormalized.has(normUrl)) {
                        return false;
                    }

                    // 2. If this URL is a child of a parent subforum that is being opened, do not mark it read
                    const normParentUrl = childToParentMap.get(normUrl);
                    if (normParentUrl && openedNormalized.has(normParentUrl)) {
                        return false;
                    }

                    // 3. If this URL is a parent and has any child that is being opened, do not mark it read
                    if (parentsWithOpenedChild.has(normUrl)) {
                        return false;
                    }

                    return true;
                });

            return {
                urlsToOpen: matched,
                urlsToMarkAsRead,
                hasRule: Boolean(matchingRule),
                matchingRule,
                childToParentMap
            };
        } else {
            // Default behavior: open all unread from bottom to top
            const defaultOpen = [...uniqueUnreadLinks].reverse();
            return {
                urlsToOpen: defaultOpen,
                urlsToMarkAsRead: [],
                hasRule: false,
                matchingRule: null,
                childToParentMap
            };
        }
    }

    // --- Thread Page Logic (supports both live document and fetched DOMParser documents) ---
    function processThreadsFromDoc(doc, pageUrl, rules) {
        const unreadThreads = [];
        const selector = '.structItem.structItem--thread.structItem--unread, .structItem.structItem--thread.is-unread';

        doc.querySelectorAll(selector).forEach(item => {
            const titleLink = item.querySelector('.structItem-title a[data-tp-primary="on"]');
            const threadUrl = resolveLinkUrl(titleLink, pageUrl);
            if (threadUrl) {
                unreadThreads.push({ url: threadUrl, title: getLinkText(titleLink) });
            }
        });

        const currentNormalized = normalizeUrl(pageUrl);
        const matchingRule = rules.find(rule => isSameRulePage(currentNormalized, rule.pageUrl));

        if (matchingRule) {
            const customUrls = (matchingRule.threadUrls || []).map(s => s.trim()).filter(Boolean);
            const normalizedCustom = customUrls.map(normalizeUrl);

            const matched = unreadThreads.filter(item => {
                const normItem = normalizeUrl(item.url);
                return normalizedCustom.some(normCustom => isMatchingTargetUrl(normItem, normCustom));
            });

            const mode = matchingRule.orderMode || 'custom';
            if (mode === 'custom') {
                matched.sort((a, b) => {
                    const normA = normalizeUrl(a.url);
                    const normB = normalizeUrl(b.url);
                    const indexA = normalizedCustom.findIndex(url => isMatchingTargetUrl(normA, url));
                    const indexB = normalizedCustom.findIndex(url => isMatchingTargetUrl(normB, url));
                    return indexA - indexB;
                });
            } else if (mode === 'bottomToTop') {
                matched.reverse();
            }

            const openedNormalized = new Set(matched.map(item => normalizeUrl(item.url)));

            const urlsToMarkAsRead = unreadThreads
                .map(item => item.url)
                .filter(url => !openedNormalized.has(normalizeUrl(url)));

            return { urlsToOpen: matched, urlsToMarkAsRead, hasRule: true };
        } else {
            // Default behavior: open all unread from bottom to top
            const defaultOpen = [...unreadThreads].reverse();
            return { urlsToOpen: defaultOpen, urlsToMarkAsRead: [], hasRule: false };
        }
    }

    // --- Helper to get CSRF token from a document ---
    function getCsrfTokenFromDoc(doc = document) {
        const htmlCsrf = doc.documentElement && doc.documentElement.getAttribute('data-csrf');
        if (htmlCsrf) return htmlCsrf;
        const inputCsrf = doc.querySelector && doc.querySelector('input[name="_xfToken"]');
        if (inputCsrf && inputCsrf.value) return inputCsrf.value;
        return '';
    }

    // Helper to deduplicate URL strings by normalized form while preserving first-seen hierarchy order
    function deduplicateUrlStrings(urls) {
        const seen = new Set();
        return urls.filter(url => {
            const norm = normalizeUrl(url);
            if (!norm || seen.has(norm)) return false;
            seen.add(norm);
            return true;
        });
    }

    /**
     * Fetches a subforum page and parses it into a DOM Document.
     */
    async function fetchSubforumDocument(url) {
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'same-origin'
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} when fetching ${url}`);
        }
        const htmlText = await response.text();
        const parser = new DOMParser();
        return parser.parseFromString(htmlText, 'text/html');
    }

    /**
     * Main execution for both Standard Scan (expand = false) and Deep Hierarchy Expand (expand = true).
     */
    async function runScan({ expand = false } = {}) {
        const now = Date.now();
        if (isScanning || (now - lastScanTimestamp) < SCAN_COOLDOWN_MS) {
            return { status: 'busy' };
        }

        isScanning = true;
        lastScanTimestamp = now;

        try {
            let finalUrlsToOpen = [];
            let finalSubforumUrlsToMarkAsRead = [];
            let finalThreadUrlsToMarkAsRead = [];
            let csrfToken = getCsrfTokenFromDoc(document);
            let expandedSubforumsCount = 0;

            const hasSubforums = Boolean(document.querySelector('.p-body-pageContent .node-list'));
            const hasThreads = Boolean(document.querySelector('.p-body-pageContent .structItemContainer-group.js-threadList'));

            if (!hasSubforums && !hasThreads) {
                browser.runtime.sendMessage({
                    action: 'scanResults',
                    openedCount: 0,
                    markedCount: 0,
                    error: 'Not a valid subforum or thread list page.'
                }).catch(() => {});
                return { status: 'empty', error: 'Not a valid subforum or thread list page.' };
            }

            // Single batched storage read for both rule sets
            const storageData = await browser.storage.sync.get(['subforumRules', 'threadRules']);
            const subforumRules = storageData.subforumRules || [];
            const threadRules = storageData.threadRules || [];

            if (!expand) {
                // --- Standard Single-Page Scan ---
                if (hasSubforums) {
                    const subforumResult = processSubforumsFromDoc(document, window.location.href, subforumRules);
                    finalUrlsToOpen.push(...subforumResult.urlsToOpen.map(item => item.url));
                    finalSubforumUrlsToMarkAsRead.push(...subforumResult.urlsToMarkAsRead);
                }

                if (hasThreads) {
                    const threadResult = processThreadsFromDoc(document, window.location.href, threadRules);
                    finalUrlsToOpen.push(...threadResult.urlsToOpen.map(item => item.url));
                    finalThreadUrlsToMarkAsRead.push(...threadResult.urlsToMarkAsRead);
                }
            } else {
                // --- Hierarchical Deep Expand Scan ("Expand & Open All") ---
                const visitedSubforumNorms = new Set([normalizeUrl(window.location.href)]);

                if (hasSubforums) {
                    const rootSubResult = processSubforumsFromDoc(document, window.location.href, subforumRules);
                    finalSubforumUrlsToMarkAsRead.push(...rootSubResult.urlsToMarkAsRead);

                    const rootQueue = rootSubResult.urlsToOpen;
                    const rootScheduledNorms = new Set(rootQueue.map(item => normalizeUrl(item.url)));

                    // Track total subforums to expand for progress reporting
                    let totalToExpand = rootQueue.length;
                    let currentExpandIndex = 0;

                    async function expandSubforumNode(subforumItem, depth, parentRuleContext = null) {
                        const normUrl = normalizeUrl(subforumItem.url);
                        if (!normUrl || visitedSubforumNorms.has(normUrl) || depth > MAX_EXPAND_DEPTH) {
                            return;
                        }
                        visitedSubforumNorms.add(normUrl);

                        // 1. Place the subforum tab itself first in the hierarchy
                        finalUrlsToOpen.push(subforumItem.url);
                        currentExpandIndex++;
                        expandedSubforumsCount++;

                        if (totalToExpand < currentExpandIndex) {
                            totalToExpand = currentExpandIndex;
                        }

                        browser.runtime.sendMessage({
                            action: 'expandProgress',
                            pageUrl: window.location.href,
                            current: currentExpandIndex,
                            total: totalToExpand,
                            currentTitle: subforumItem.title || ''
                        }).catch(() => {});

                        // Polite pacing delay between subforum page fetches
                        if (expandedSubforumsCount > 1) {
                            await delay(EXPAND_FETCH_DELAY_MS);
                        }

                        let subDoc;
                        try {
                            subDoc = await fetchSubforumDocument(subforumItem.url);
                        } catch (fetchErr) {
                            console.warn(`Failed to fetch subforum during expand: ${subforumItem.url}`, fetchErr);
                            return;
                        }

                        if (!csrfToken) {
                            csrfToken = getCsrfTokenFromDoc(subDoc);
                        }

                        const subHasThreads = Boolean(subDoc.querySelector('.p-body-pageContent .structItemContainer-group.js-threadList'));
                        const subHasSubforums = Boolean(subDoc.querySelector('.p-body-pageContent .node-list'));

                        // 2. Immediately follow the subforum tab with its own unread threads (in its saved Thread Rule order)
                        if (subHasThreads) {
                            const subThreadResult = processThreadsFromDoc(subDoc, subforumItem.url, threadRules);
                            finalUrlsToOpen.push(...subThreadResult.urlsToOpen.map(t => t.url));
                            finalThreadUrlsToMarkAsRead.push(...subThreadResult.urlsToMarkAsRead);
                        }

                        // 3. If this subforum has nested child subforums, expand them in hierarchy order
                        if (subHasSubforums && depth < MAX_EXPAND_DEPTH) {
                            // Check if parent rule already curated specific children of this subforum
                            let inheritedFilter = null;
                            if (parentRuleContext && parentRuleContext.matchingRule && parentRuleContext.childToParentMap) {
                                const childNormsOfThisParent = [];
                                for (const [cNorm, pNorm] of parentRuleContext.childToParentMap.entries()) {
                                    if (pNorm === normUrl) childNormsOfThisParent.push(cNorm);
                                }
                                const parentCustomNorms = (parentRuleContext.matchingRule.subforumUrls || [])
                                    .map(s => normalizeUrl(s.trim()))
                                    .filter(Boolean);
                                const parentExplicitlySelectedChild = childNormsOfThisParent.some(cNorm =>
                                    parentCustomNorms.some(customNorm => isMatchingTargetUrl(cNorm, customNorm))
                                );
                                if (parentExplicitlySelectedChild) {
                                    inheritedFilter = parentRuleContext.matchingRule;
                                }
                            }

                            const nestedSubResult = processSubforumsFromDoc(
                                subDoc,
                                subforumItem.url,
                                subforumRules,
                                inheritedFilter
                            );
                            finalSubforumUrlsToMarkAsRead.push(...nestedSubResult.urlsToMarkAsRead);

                            // Filter out child subforums that are already scheduled at their own explicit slot in the root rule
                            const nestedToExpandNow = nestedSubResult.urlsToOpen.filter(childItem => {
                                const normChild = normalizeUrl(childItem.url);
                                if (visitedSubforumNorms.has(normChild)) return false;
                                if (depth === 1 && rootScheduledNorms.has(normChild)) {
                                    // Will be expanded at its exact position in rootQueue
                                    return false;
                                }
                                return true;
                            });

                            totalToExpand += nestedToExpandNow.length;

                            for (const childItem of nestedToExpandNow) {
                                await expandSubforumNode(childItem, depth + 1, nestedSubResult);
                            }
                        }
                    }

                    for (const subforumItem of rootQueue) {
                        await expandSubforumNode(subforumItem, 1, rootSubResult);
                    }

                    // Clear expanding state in background before handing off to processLinks
                    browser.runtime.sendMessage({
                        action: 'expandProgress',
                        pageUrl: window.location.href,
                        done: true
                    }).catch(() => {});
                }

                // Also process any direct unread threads on the starting page itself
                if (hasThreads) {
                    const rootThreadResult = processThreadsFromDoc(document, window.location.href, threadRules);
                    finalUrlsToOpen.push(...rootThreadResult.urlsToOpen.map(item => item.url));
                    finalThreadUrlsToMarkAsRead.push(...rootThreadResult.urlsToMarkAsRead);
                }
            }

            // Deduplicate based on normalized URL while preserving hierarchical order
            finalUrlsToOpen = deduplicateUrlStrings(finalUrlsToOpen);
            const openedNormSet = new Set(finalUrlsToOpen.map(normalizeUrl));

            // Never mark as read any subforum or thread that is being opened
            finalSubforumUrlsToMarkAsRead = deduplicateUrlStrings(finalSubforumUrlsToMarkAsRead)
                .filter(url => !openedNormSet.has(normalizeUrl(url)));
            finalThreadUrlsToMarkAsRead = deduplicateUrlStrings(finalThreadUrlsToMarkAsRead)
                .filter(url => !openedNormSet.has(normalizeUrl(url)));

            const hasItemsToProcess =
                finalUrlsToOpen.length > 0 ||
                finalSubforumUrlsToMarkAsRead.length > 0 ||
                finalThreadUrlsToMarkAsRead.length > 0;

            if (hasItemsToProcess) {
                const bgResponse = await browser.runtime.sendMessage({
                    action: 'processLinks',
                    pageUrl: window.location.href,
                    urlsToOpen: finalUrlsToOpen,
                    subforumUrlsToMarkAsRead: finalSubforumUrlsToMarkAsRead,
                    threadUrlsToMarkAsRead: finalThreadUrlsToMarkAsRead,
                    expandedSubforumsCount,
                    csrfToken
                });
                return {
                    status: (bgResponse && bgResponse.status) || 'started',
                    jobId: bgResponse && bgResponse.jobId,
                    queueLength: bgResponse && bgResponse.queueLength,
                    totalToOpen: finalUrlsToOpen.length,
                    totalToMark: finalSubforumUrlsToMarkAsRead.length + finalThreadUrlsToMarkAsRead.length,
                    expandedSubforumsCount
                };
            } else {
                browser.runtime.sendMessage({
                    action: 'scanResults',
                    openedCount: 0,
                    markedCount: 0,
                    error: 'No unread items found.'
                }).catch(() => {});
                return { status: 'empty', error: 'No unread items found.' };
            }
        } finally {
            isScanning = false;
        }
    }

    // Listen for messages from the popup script
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return false;
        if (message.action === 'ping') {
            sendResponse({ status: 'pong', isScanning });
            return true;
        }
        if (message.action === 'scanPage') {
            runScan({ expand: false })
                .then(result => {
                    sendResponse(result || { status: 'started' });
                })
                .catch(err => {
                    console.error('Scan failed:', err);
                    sendResponse({ status: 'error', error: err.message });
                });
            return true;
        }
        if (message.action === 'expandAll') {
            runScan({ expand: true })
                .then(result => {
                    sendResponse(result || { status: 'started' });
                })
                .catch(err => {
                    console.error('Expand scan failed:', err);
                    sendResponse({ status: 'error', error: err.message });
                });
            return true;
        }
        return false;
    });
}

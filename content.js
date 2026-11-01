// content.js

if (!window.__skyscraperContentScriptLoaded) {
    window.__skyscraperContentScriptLoaded = true;
    console.log('Content script loaded');

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    let isScanning = false;
    let lastScanTimestamp = 0;
    const SCAN_COOLDOWN_MS = 800;

    // Rate-limit-safe expansion constants
    const EXPAND_FETCH_CONCURRENCY = 2;
    const MIN_FETCH_INTERVAL_MS = 160;
    const MAX_FETCH_RETRIES = 3;
    const BASE_BACKOFF_MS = 1500;
    const MAX_EXPAND_DEPTH = 3;

    let nextAllowedFetchTime = 0;
    let fetchRateLimitPauseUntil = 0;

    /**
     * Token-bucket style pacer for subforum expansion fetches.
     */
    async function acquireFetchSlot() {
        while (true) {
            const now = Date.now();
            if (now < fetchRateLimitPauseUntil) {
                await delay(fetchRateLimitPauseUntil - now);
                continue;
            }
            const scheduledTime = Math.max(now, nextAllowedFetchTime);
            nextAllowedFetchTime = scheduledTime + MIN_FETCH_INTERVAL_MS;
            const waitMs = scheduledTime - now;
            if (waitMs > 0) {
                await delay(waitMs);
            }
            if (Date.now() < fetchRateLimitPauseUntil) {
                continue;
            }
            return;
        }
    }

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

    /**
     * Maps over `items` concurrently with at most `concurrency` active promises,
     * returning the results in the exact original index order of `items`.
     */
    async function mapWithConcurrency(items, concurrency, mapperFn) {
        const total = items.length;
        if (total === 0) return [];
        const results = new Array(total);
        let nextIndex = 0;
        const workerCount = Math.min(concurrency, total);

        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < total) {
                const idx = nextIndex++;
                results[idx] = await mapperFn(items[idx], idx);
            }
        });

        await Promise.all(workers);
        return results;
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
     * Fetches a subforum page and parses it into a DOM Document,
     * with token-bucket pacing and automatic 429/503 exponential backoff.
     */
    async function fetchSubforumDocument(url) {
        for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
            await acquireFetchSlot();

            const response = await fetch(url, {
                method: 'GET',
                credentials: 'same-origin'
            });

            if (response.status === 429 || response.status === 503) {
                const retryAfter = response.headers.get('Retry-After');
                let backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
                if (retryAfter) {
                    const sec = parseInt(retryAfter, 10);
                    if (!isNaN(sec) && sec > 0) backoffMs = Math.min(sec * 1000, 15000);
                }
                const jitter = Math.floor(Math.random() * 300);
                fetchRateLimitPauseUntil = Math.max(fetchRateLimitPauseUntil, Date.now() + backoffMs + jitter);
                console.warn(`Rate limited (${response.status}) fetching ${url}. Retrying in ${backoffMs + jitter}ms...`);
                if (attempt < MAX_FETCH_RETRIES) continue;
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} when fetching ${url}`);
            }

            const htmlText = await response.text();
            const parser = new DOMParser();
            return parser.parseFromString(htmlText, 'text/html');
        }
        throw new Error(`Max retries exceeded fetching ${url}`);
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
            // Subforums where all ignored threads are cleared in 1 single POST /mark-read request
            const bulkMarkReadSubforumNorms = new Set();
            let needsUnreadRedirectGrace = false;
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
                let openedSubforumsOnPage = 0;
                if (hasSubforums) {
                    const subforumResult = processSubforumsFromDoc(document, window.location.href, subforumRules);
                    openedSubforumsOnPage = subforumResult.urlsToOpen.length;
                    finalUrlsToOpen.push(...subforumResult.urlsToOpen.map(item => item.url));
                    finalSubforumUrlsToMarkAsRead.push(...subforumResult.urlsToMarkAsRead);
                }

                if (hasThreads) {
                    const threadResult = processThreadsFromDoc(document, window.location.href, threadRules);
                    finalUrlsToOpen.push(...threadResult.urlsToOpen.map(item => item.url));

                    // Request-reduction optimization:
                    // If no unexpanded child subforums on this page are waiting to be opened manually,
                    // and there are multiple ignored threads, 1 single POST /forums/.../mark-read
                    // clears all ignored threads at once instead of N separate thread GET requests!
                    const normCurrentForum = normalizeUrl(window.location.href);
                    if (
                        openedSubforumsOnPage === 0 &&
                        threadResult.urlsToMarkAsRead.length > 1 &&
                        normCurrentForum.includes('/forums/')
                    ) {
                        finalSubforumUrlsToMarkAsRead.push(normCurrentForum);
                        bulkMarkReadSubforumNorms.add(normCurrentForum);
                        if (threadResult.urlsToOpen.length > 0) {
                            needsUnreadRedirectGrace = true;
                        }
                    } else {
                        finalThreadUrlsToMarkAsRead.push(...threadResult.urlsToMarkAsRead);
                    }
                }
            } else {
                // --- Hierarchical Deep Expand Scan ("Expand & Open All") ---
                const visitedSubforumNorms = new Set([normalizeUrl(window.location.href)]);

                if (hasSubforums) {
                    const rootSubResult = processSubforumsFromDoc(document, window.location.href, subforumRules);
                    finalSubforumUrlsToMarkAsRead.push(...rootSubResult.urlsToMarkAsRead);

                    const rootQueue = rootSubResult.urlsToOpen.filter(item => {
                        const norm = normalizeUrl(item.url);
                        if (!norm || visitedSubforumNorms.has(norm)) return false;
                        visitedSubforumNorms.add(norm);
                        return true;
                    });
                    const rootScheduledNorms = new Set(rootQueue.map(item => normalizeUrl(item.url)));

                    let totalToExpand = rootQueue.length;
                    let completedExpands = 0;

                    /**
                     * Expands a single subforum node and returns its ordered subtree:
                     * { urlsToOpen, subforumUrlsToMarkAsRead, threadUrlsToMarkAsRead }
                     */
                    async function expandSubforumNodeToTree(subforumItem, depth, parentRuleContext = null) {
                        const normUrl = normalizeUrl(subforumItem.url);
                        const localOpen = [subforumItem.url];
                        const localSubforumsToMark = [];
                        const localThreadsToMark = [];

                        expandedSubforumsCount++;

                        let subDoc = null;
                        try {
                            subDoc = await fetchSubforumDocument(subforumItem.url);
                        } catch (fetchErr) {
                            console.warn(`Failed to fetch subforum during expand: ${subforumItem.url}`, fetchErr);
                        } finally {
                            completedExpands++;
                            browser.runtime.sendMessage({
                                action: 'expandProgress',
                                pageUrl: window.location.href,
                                current: Math.min(completedExpands, totalToExpand),
                                total: Math.max(completedExpands, totalToExpand),
                                currentTitle: subforumItem.title || ''
                            }).catch(() => {});
                        }

                        if (!subDoc) {
                            return {
                                urlsToOpen: localOpen,
                                subforumUrlsToMarkAsRead: localSubforumsToMark,
                                threadUrlsToMarkAsRead: localThreadsToMark
                            };
                        }

                        if (!csrfToken) {
                            csrfToken = getCsrfTokenFromDoc(subDoc);
                        }

                        const subHasThreads = Boolean(subDoc.querySelector('.p-body-pageContent .structItemContainer-group.js-threadList'));
                        const subHasSubforums = Boolean(subDoc.querySelector('.p-body-pageContent .node-list'));

                        let watchedThreadsCount = 0;
                        let pendingIgnoredThreads = [];

                        // 1. Immediately follow the subforum tab with its own unread threads (in its saved Thread Rule order)
                        if (subHasThreads) {
                            const subThreadResult = processThreadsFromDoc(subDoc, subforumItem.url, threadRules);
                            watchedThreadsCount = subThreadResult.urlsToOpen.length;
                            localOpen.push(...subThreadResult.urlsToOpen.map(t => t.url));
                            pendingIgnoredThreads = subThreadResult.urlsToMarkAsRead;
                        }

                        // 2. If this subforum has nested child subforums, expand them and merge in order
                        let nestedToExpandNow = [];
                        let hasDeferredRootScheduledChildren = false;
                        if (subHasSubforums && depth < MAX_EXPAND_DEPTH) {
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
                            localSubforumsToMark.push(...nestedSubResult.urlsToMarkAsRead);

                            nestedToExpandNow = nestedSubResult.urlsToOpen.filter(childItem => {
                                const normChild = normalizeUrl(childItem.url);
                                if (!normChild) return false;
                                if (depth === 1 && rootScheduledNorms.has(normChild)) {
                                    hasDeferredRootScheduledChildren = true;
                                    return false;
                                }
                                if (visitedSubforumNorms.has(normChild)) return false;
                                visitedSubforumNorms.add(normChild);
                                return true;
                            });

                            if (nestedToExpandNow.length > 0) {
                                totalToExpand += nestedToExpandNow.length;
                                const childTrees = await mapWithConcurrency(
                                    nestedToExpandNow,
                                    EXPAND_FETCH_CONCURRENCY,
                                    childItem => expandSubforumNodeToTree(childItem, depth + 1, nestedSubResult)
                                );
                                childTrees.forEach(tree => {
                                    localOpen.push(...tree.urlsToOpen);
                                    localSubforumsToMark.push(...tree.subforumUrlsToMarkAsRead);
                                    localThreadsToMark.push(...tree.threadUrlsToMarkAsRead);
                                });
                            }
                        }

                        // Request-reduction optimization:
                        // Since all watched threads (and any child subforums) of this subforum are already being opened,
                        // if this subforum has > 1 ignored unread threads and no unexpanded child subforums,
                        // replace N individual thread GET requests with 1 single POST /forums/.../mark-read!
                        if (
                            !hasDeferredRootScheduledChildren &&
                            nestedToExpandNow.length === 0 &&
                            pendingIgnoredThreads.length > 1 &&
                            normUrl.includes('/forums/')
                        ) {
                            localSubforumsToMark.push(normUrl);
                            bulkMarkReadSubforumNorms.add(normUrl);
                            if (watchedThreadsCount > 0) {
                                needsUnreadRedirectGrace = true;
                            }
                        } else {
                            localThreadsToMark.push(...pendingIgnoredThreads);
                        }

                        return {
                            urlsToOpen: localOpen,
                            subforumUrlsToMarkAsRead: localSubforumsToMark,
                            threadUrlsToMarkAsRead: localThreadsToMark
                        };
                    }

                    // Expand root subforums with rate-limited concurrency while preserving exact rootQueue order!
                    const rootTrees = await mapWithConcurrency(
                        rootQueue,
                        EXPAND_FETCH_CONCURRENCY,
                        subforumItem => expandSubforumNodeToTree(subforumItem, 1, rootSubResult)
                    );

                    rootTrees.forEach(tree => {
                        finalUrlsToOpen.push(...tree.urlsToOpen);
                        finalSubforumUrlsToMarkAsRead.push(...tree.subforumUrlsToMarkAsRead);
                        finalThreadUrlsToMarkAsRead.push(...tree.threadUrlsToMarkAsRead);
                    });

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

            // Never mark as read any subforum or thread that is being opened (unless it's a bulk mark-read subforum after its watched threads open)
            finalSubforumUrlsToMarkAsRead = deduplicateUrlStrings(finalSubforumUrlsToMarkAsRead).filter(url => {
                const norm = normalizeUrl(url);
                return !openedNormSet.has(norm) || bulkMarkReadSubforumNorms.has(norm);
            });
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
                    needsUnreadRedirectGrace,
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

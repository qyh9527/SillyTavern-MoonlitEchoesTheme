import { getSettings as getExtensionSettings } from '../services/settings-service.js';

function stripOrigin(url) {
    if (!url) return '';
    if (url.startsWith(window.location.origin)) {
        return url.replace(window.location.origin, '');
    }
    return url;
}

function parseAvatarSource(rawSrc) {
    if (!rawSrc) return null;

    const normalized = stripOrigin(rawSrc);
    const trimmed = normalized.startsWith('/') ? normalized.slice(1) : normalized;

    try {
        const parsed = new URL(normalized, window.location.origin);
        if (parsed.pathname.endsWith('thumbnail')) {
            const type = parsed.searchParams.get('type');
            const file = parsed.searchParams.get('file');
            if (type && file) {
                return { type, file: decodeURIComponent(file) };
            }
        }
    } catch (err) {
        // Ignore URL parse errors and fall back to path inspection
    }

    if (trimmed.startsWith('characters/')) {
        return { type: 'avatar', file: trimmed.replace(/^characters\//, '') };
    }

    if (trimmed.startsWith('User Avatars/')) {
        return { type: 'persona', file: trimmed.replace(/^User Avatars\//, '') };
    }

    return { type: null, file: trimmed };
}

function getAvatarSources(rawSrc) {
    const info = parseAvatarSource(rawSrc);
    if (!info) {
        return { thumb: null, original: null };
    }

    const { type, file } = info;
    const ensureAbsolute = (path) => {
        if (!path) return '';
        return path.startsWith('/') ? path : `/${path}`;
    };

    const thumb =
        type === 'avatar' || type === 'persona'
            ? `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`
            : ensureAbsolute(info.file);

    const original =
        type === 'avatar'
            ? ensureAbsolute(`characters/${file}`)
            : type === 'persona'
                ? ensureAbsolute(`User Avatars/${file}`)
                : ensureAbsolute(info.file);

    return {
        thumb: stripOrigin(thumb),
        original: stripOrigin(original),
    };
}

function formatSrcsetUrl(url) {
    try {
        return encodeURI(url).replace(/,/g, '%2C');
    } catch (err) {
        return url.replace(/,/g, '%2C');
    }
}

function applyAvatarSources(mes, avatarImg, preferOriginal) {
    const srcCandidate = avatarImg.getAttribute('src') || avatarImg.getAttribute('data-src');
    if (!srcCandidate) return;

    const { thumb, original } = getAvatarSources(srcCandidate);
    if (!thumb && !original) return;

    const thumbUrl = thumb || original;
    const originalUrl = original || thumbUrl;
    const targetUrl = preferOriginal ? originalUrl : thumbUrl;

    mes.dataset.avatarThumb = thumbUrl;
    mes.dataset.avatarOriginal = originalUrl;
    mes.dataset.avatar = targetUrl;

    mes.style.setProperty('--mes-avatar-thumb-url', `url('${thumbUrl}')`);
    mes.style.setProperty('--mes-avatar-original-url', `url('${originalUrl}')`);
    mes.style.setProperty('--mes-avatar-url', `url('${targetUrl}')`);

    const currentSrc = stripOrigin(avatarImg.getAttribute('src') || '');
    const desiredSrc = stripOrigin(thumbUrl);
    if (desiredSrc && currentSrc !== desiredSrc) {
        avatarImg.setAttribute('src', thumbUrl);
    }

    if (preferOriginal && originalUrl && originalUrl !== thumbUrl) {
        avatarImg.setAttribute('srcset', formatSrcsetUrl(originalUrl));
    } else {
        avatarImg.removeAttribute('srcset');
    }
}

/**
 * Initialize avatar injector observer.
 * Injects avatar URLs into message elements so they can be used in CSS.
 * @returns {function} Function to manually trigger avatar updates.
 */
export function initAvatarInjector() {
    function updateAvatars() {
        const context = SillyTavern.getContext();
        const settings = getExtensionSettings(context) || {};
        const preferOriginal =
            settings.useOriginalAvatarImages === true ||
            document.body.classList.contains('ripplestyle');

        document.querySelectorAll('.mes').forEach((mes) => {
            const avatarImg = mes.querySelector('.avatar img');
            if (!avatarImg) return;

            applyAvatarSources(mes, avatarImg, preferOriginal);
        });
    }

    updateAvatars();

    let debounceTimer;
    const observerCallback = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(updateAvatars, 100);
    };

    const chatContainer = document.getElementById('chat');
    if (chatContainer) {
        const observer = new MutationObserver(observerCallback);
        observer.observe(chatContainer, { childList: true, subtree: true });
    }

    window.updateAvatars = updateAvatars;
    return updateAvatars;
}

/**
 * Initialize monitoring of #form_sheld height and expose helper controls.
 * @returns {{update: function, start: function, stop: function}} Control helpers.
 */
export function initFormSheldHeightMonitor() {
    let isInitialized = false;
    let lastHeight = 0;
    let rafId = 0;

    function getAccurateHeight(element) {
        if (!element) return 0;
        const rect = element.getBoundingClientRect();
        return rect.height;
    }

    // A `--formSheldHeight: ... !important` rule (e.g. the user's rawCustomCss
    // freeze) means our writes never win anyway — skip the write to avoid the
    // "JS writes -> CSS !important overrides" tug-of-war.
    function isFrozen() {
        const inline = document.documentElement.style.getPropertyPriority('--formSheldHeight');
        return inline === 'important';
    }

    function updateFormSheldHeight() {
        const formSheld = document.getElementById('form_sheld');
        if (!formSheld) return;

        const height = getAccurateHeight(formSheld);
        // Dirty-check: skip the style write (and the forced sync layout it triggers)
        // when the height hasn't actually changed.
        if (height > 0 && height !== lastHeight) {
            lastHeight = height;
            if (!isFrozen()) {
                document.documentElement.style.setProperty('--formSheldHeight', `${height}px`);
            }
            isInitialized = true;
        }
    }

    // Coalesce every "measure now" request into a single rAF so that a burst of
    // resize/observer callbacks in the same frame measures at most once.
    function requestHeightUpdate() {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            updateFormSheldHeight();
        });
    }

    // The ResizeObserver covers every real height change (QR bar add/remove,
    // font-size hot-update, orientation, host re-layout). The MutationObserver
    // is only kept as a fallback for the case where #form_sheld itself is
    // removed/re-created. Neither touches #chat, so TT's per-message DOM
    // virtualization is never disturbed.
    const mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                for (const node of mutation.addedNodes) {
                    if (
                        node.id === 'form_sheld' ||
                        (node.nodeType === 1 && node.querySelector && node.querySelector('#form_sheld'))
                    ) {
                        setTimeout(startObservers, 50);
                        return;
                    }
                }
            }
        }
    });

    const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
            if (entry.target.id === 'form_sheld') {
                requestHeightUpdate();
            }
        }
    });

    function stopObservers() {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
    }

    function startObservers() {
        stopObservers();

        const formSheld = document.getElementById('form_sheld');
        if (formSheld) {
            resizeObserver.observe(formSheld);

            const parent = formSheld.parentElement;
            if (parent) {
                mutationObserver.observe(parent, {
                    childList: true,
                    attributes: true,
                    attributeFilter: ['style', 'class'],
                });
            }

            requestHeightUpdate();
        }
    }

    // Body-level observer kept only to re-attach everything if #form_sheld is
    // ever torn out of the DOM and re-inserted by the host app.
    const bodyObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (!mutation.addedNodes.length) continue;
            for (const node of mutation.addedNodes) {
                if (
                    node.id === 'form_sheld' ||
                    (node.nodeType === 1 && node.querySelector && node.querySelector('#form_sheld'))
                ) {
                    setTimeout(startObservers, 50);
                    return;
                }
            }
        }

        if (!isInitialized && document.getElementById('form_sheld')) {
            setTimeout(startObservers, 50);
        }
    });

    window.addEventListener('resize', requestHeightUpdate);
    window.addEventListener('orientationchange', () => {
        requestHeightUpdate();
        setTimeout(requestHeightUpdate, 300);
    });

    let booted = false;
    function boot() {
        if (booted) return;
        booted = true;

        // Deliberately no per-keystroke `input` listener and no QR/options click
        // listeners: the user's textarea height is CSS-fixed, and any change that
        // could move #form_sheld (QR bar, options drawer, font hot-update) already
        // surfaces through ResizeObserver / window resize. Skipping them removes
        // pure no-op forced layouts.
        startObservers();
        requestHeightUpdate();

        bodyObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    return {
        update: requestHeightUpdate,
        start: startObservers,
        stop: stopObservers,
    };
}

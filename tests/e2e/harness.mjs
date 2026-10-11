// Browser harness: a datascript-backed window.roamAlphaAPI and a fake
// extensionAPI, so the real extension.js can be loaded in a plain page and
// driven by Playwright. Bundled to tests/build/harness.js by e2e/build.mjs.

import { makeRoam } from "../roam-fake.mjs";

const store = new Map();
const commands = new Map();
const slashes = new Map();
const removed = [];
let panelConfig = null;

const extensionAPI = {
    settings: {
        // Roam answers null, not undefined, for a key never set.
        get: (key) => (store.has(key) ? store.get(key) : null),
        set: async (key, value) => {
            store.set(key, value);
        },
        getAll: () => Object.fromEntries(store),
        panel: {
            create: async (config) => {
                panelConfig = config;
            },
        },
    },
    ui: {
        commandPalette: {
            addCommand: async ({ label, callback }) => commands.set(label, callback),
            removeCommand: async ({ label }) => {
                removed.push(label);
                commands.delete(label);
            },
        },
        slashCommand: {
            addCommand: async ({ label, callback }) => slashes.set(label, callback),
            removeCommand: async ({ label }) => {
                removed.push(`slash:${label}`);
                slashes.delete(label);
            },
        },
    },
};

const roam = makeRoam();
window.roamAlphaAPI = roam.alpha;
window.__asyntaiTest = true;

window.__harness = {
    roam,
    extensionAPI,
    store,
    commands,
    slashes,
    removed,
    panelConfig: () => panelConfig,
    run: (label) => {
        const callback = commands.get(label);
        if (!callback) {
            throw new Error(`no command ${label}`);
        }
        return callback();
    },
    // Every toast ever shown, in order. The extension keeps three on screen
    // at most, so the DOM alone cannot tell which one is new.
    toasts: () => toastLog.slice(),
};

const toastLog = [];
new MutationObserver((records) => {
    for (const record of records) {
        for (const node of record.addedNodes) {
            if (node.nodeType === 1 && node.classList.contains("asyntai-toast")) {
                toastLog.push(node.textContent);
            }
        }
    }
}).observe(document.documentElement, { childList: true, subtree: true });

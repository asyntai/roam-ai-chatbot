// Extension entry point. Roam imports extension.js and calls onload with the
// extension API; everything onload adds, onunload takes away again.

import { AsyntaiApi, DEFAULT_ORIGIN, Transport, TransportRequest } from "./api";
import { RoamAlpha, RoamGraph } from "./graph";
import { MAP_KEY, parseMap, serializeMap } from "./store";
import { CSS, STYLE_ID } from "./styles";
import { SyncEngine, SyncMap, SyncOptions, errorText, parseNamespaces, refAllowed } from "./sync";
import { Panel } from "./ui";

/** The parts of Roam's extensionAPI this extension uses. */
export interface ExtensionAPI {
    settings: {
        get: (key: string) => unknown;
        set: (key: string, value: unknown) => unknown;
        panel: { create: (config: unknown) => unknown };
    };
    ui?: {
        commandPalette?: {
            addCommand: (cmd: { label: string; callback: () => void }) => unknown;
            removeCommand?: (cmd: { label: string }) => unknown;
        };
        slashCommand?: {
            addCommand: (cmd: { label: string; callback: (context: SlashContext) => unknown }) => unknown;
            removeCommand?: (cmd: { label: string }) => unknown;
        };
    };
}

export interface SlashContext {
    "block-uid"?: string;
    "window-id"?: string;
    indexes?: [number, number];
}

const KEY = {
    apiKey: "apiKey",
    namespaces: "namespaces",
    excluded: "excluded",
    journals: "journals",
    autoSync: "autoSync",
    origin: "origin",
};

/** How often the graph is checked for edited pages. */
export const WATCH_INTERVAL_MS = 15000;
/** A page is sent only once its writer has paused this long. */
export const QUIET_MS = 4000;

export const COMMANDS = {
    open: "Asyntai: open panel",
    sendPage: "Asyntai: send this page",
    removePage: "Asyntai: remove this page",
    sendAll: "Asyntai: send all pages",
    removeAll: "Asyntai: remove all pages",
    checkKey: "Asyntai: check API key",
};
export const SLASH_LABEL = "Asyntai ask";

const transport: Transport = async (req: TransportRequest) => {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    return { status: res.status, text: await res.text() };
};

/** The question in a block that also holds the half-typed slash command. */
export function questionFromBlock(text: string, indexes?: [number, number]): string {
    let value = text || "";
    if (Array.isArray(indexes) && indexes.length === 2 && indexes[0] <= indexes[1] && indexes[1] <= value.length) {
        // Roam's indexes cover the typed search text AFTER the "/" (seen in
        // real Roam: "there? /Asyntai ask" left "there? /"), so the slash
        // right before the span goes too.
        const start = value[indexes[0] - 1] === "/" ? indexes[0] - 1 : indexes[0];
        value = value.slice(0, start) + value.slice(indexes[1]);
    } else {
        value = value.replace(/\/[^/\n]*$/, "");
    }
    return value.trim();
}

interface Runtime {
    stop: () => void;
}

let runtime: Runtime | null = null;

const TOAST_BOX_ID = "asyntai-ai-chatbot-toasts";

/** Short notices at the bottom of the screen. Several stack, newest last. */
function toast(message: string, intent: "none" | "success" | "warning" | "danger" = "none"): void {
    let box = document.getElementById(TOAST_BOX_ID);
    if (!box) {
        box = document.createElement("div");
        box.id = TOAST_BOX_ID;
        box.style.cssText =
            "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:40;display:flex;" +
            "flex-direction:column;align-items:center;gap:8px;pointer-events:none;";
        document.body.appendChild(box);
    }
    const item = document.createElement("div");
    item.className = "asyntai-toast";
    item.textContent = message;
    item.setAttribute("role", "status");
    item.style.cssText =
        "padding:8px 14px;border-radius:6px;font-size:14px;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.18);" +
        "max-width:520px;text-align:center;background:" +
        (intent === "danger" ? "#b00020" : intent === "warning" ? "#8a5a00" : "#111");
    box.appendChild(item);
    // Three at most: an older notice is stale once a newer one is shown.
    while (box.children.length > 3) {
        box.firstElementChild?.remove();
    }
    setTimeout(() => item.remove(), 4500);
}

/** "1 page", "3 pages". */
export function pages(count: number): string {
    return `${count} ${count === 1 ? "page" : "pages"}`;
}

async function onload({ extensionAPI }: { extensionAPI: ExtensionAPI }): Promise<void> {
    const alpha = (window as unknown as { roamAlphaAPI: RoamAlpha }).roamAlphaAPI;
    const settings = extensionAPI.settings;

    const text = (key: string): string => {
        const value = settings.get(key);
        return typeof value === "string" ? value : "";
    };
    const flag = (key: string, fallback: boolean): boolean => {
        const value = settings.get(key);
        return typeof value === "boolean" ? value : fallback;
    };

    // First start: write the defaults, so the switches in the panel show them.
    // Roam answers null for a key that was never set (its docs), so test for
    // both null and undefined.
    if (settings.get(KEY.autoSync) == null) {
        await Promise.resolve(settings.set(KEY.autoSync, true));
    }
    if (settings.get(KEY.journals) == null) {
        await Promise.resolve(settings.set(KEY.journals, false));
    }
    if (!text(KEY.origin)) {
        await Promise.resolve(settings.set(KEY.origin, DEFAULT_ORIGIN));
    }

    await Promise.resolve(
        settings.panel.create({
            tabTitle: "Asyntai AI Chatbot",
            settings: [
                {
                    id: KEY.apiKey,
                    name: "Asyntai API key",
                    description: "Settings → API in your Asyntai dashboard. The API needs the Starter plan or higher.",
                    action: { type: "input", placeholder: "asyntai_..." },
                },
                {
                    id: KEY.namespaces,
                    name: "Pages to send",
                    description:
                        "Pages the Asyntai chatbot answers from, on your website and in this panel. " +
                        'Page title prefixes, comma separated: "Docs" sends "Docs" and "Docs/Refund policy". ' +
                        'Type "/" to send every page. Empty sends nothing.',
                    action: { type: "input", placeholder: "Docs, Help center" },
                },
                {
                    id: KEY.excluded,
                    name: "Pages to leave out",
                    description:
                        "Prefixes that stay out even when a parent is sent. A block reference to a block on one of " +
                        "these pages is left out of the sent text too.",
                    action: { type: "input", placeholder: "Docs/Drafts" },
                },
                {
                    id: KEY.journals,
                    name: "Send daily notes",
                    description:
                        "Daily notes are usually private, so they stay out unless you turn this on. While it is off, " +
                        "a block reference to a daily note is left out of the sent text too.",
                    action: { type: "switch" },
                },
                {
                    id: KEY.autoSync,
                    name: "Send changes automatically",
                    description: "Send a page to Asyntai a few seconds after you stop editing it.",
                    action: { type: "switch" },
                },
                {
                    id: KEY.origin,
                    name: "Asyntai address",
                    description: "Leave this as it is unless Asyntai support asks you to change it. Must start with https://.",
                    action: { type: "input", placeholder: DEFAULT_ORIGIN },
                },
            ],
        }),
    );

    const api = new AsyntaiApi(transport, () => text(KEY.apiKey), () => text(KEY.origin) || DEFAULT_ORIGIN);
    const graph = new RoamGraph(alpha);
    const options = (): SyncOptions => ({
        namespaces: parseNamespaces(text(KEY.namespaces)),
        excluded: parseNamespaces(text(KEY.excluded)),
        journals: flag(KEY.journals, false),
    });
    const saveMap = async (map: SyncMap): Promise<void> => {
        await Promise.resolve(settings.set(MAP_KEY, serializeMap(map)));
    };
    const engine = new SyncEngine(api, graph, parseMap(settings.get(MAP_KEY)), saveMap, options);
    // "Pages to leave out" and the daily notes switch hold for block
    // references too: a ((ref)) into a left-out page sends nothing.
    graph.refFilter = (page) => refAllowed(page, options());

    // Styles and the panel.
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);

    const host = document.createElement("div");
    host.className = "asyntai-host";
    host.id = "asyntai-ai-chatbot-panel";
    document.body.appendChild(host);

    // Where "Insert into page" writes: the block that was being edited when
    // the panel opened, otherwise the end of the open page.
    let insertTarget: string | null = null;

    const close = (): void => {
        host.classList.remove("asyntai-open");
    };

    const panel = new Panel(
        api,
        {
            insert: async (answer: string) => {
                try {
                    let parent = insertTarget && (await graph.exists(insertTarget)) ? insertTarget : null;
                    if (!parent) {
                        parent = await graph.openUid();
                    }
                    if (!parent) {
                        toast("Open a page first.", "warning");
                        return;
                    }
                    await graph.append(parent, answer);
                    toast("Answer added.", "success");
                } catch (err) {
                    toast(errorText(err), "danger");
                }
            },
            saveAsPage: async (title: string, body: string) => {
                try {
                    await graph.createPage(title, body.split("\n"));
                    toast(`Chat saved as [[${title}]].`, "success");
                } catch (err) {
                    toast(errorText(err), "danger");
                }
            },
            close,
        },
        host,
    );

    const open = (target?: string | null): void => {
        insertTarget = target !== undefined ? target : graph.focusedBlockUid();
        host.classList.add("asyntai-open");
    };
    const toggle = (): void => {
        if (host.classList.contains("asyntai-open")) {
            close();
        } else {
            open();
        }
    };

    const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape" && host.classList.contains("asyntai-open")) {
            close();
        }
    };
    document.addEventListener("keydown", onKey);

    // Top bar button.
    const button = document.createElement("span");
    button.className = "bp3-button bp3-minimal bp3-small bp3-icon-chat asyntai-topbar-button";
    button.setAttribute("title", "Asyntai AI Chatbot");
    button.setAttribute("role", "button");
    // Keep the editing block focused, so open() can still read it.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", toggle);
    // At the right end of the top bar, after Roam's own buttons, with the same
    // small spacer Roam puts between them.
    const spacer = document.createElement("div");
    spacer.className = "rm-topbar__spacer-sm asyntai-topbar-spacer";
    const placeButton = (): boolean => {
        if (button.isConnected) {
            return true;
        }
        const bar = document.querySelector(".rm-topbar");
        if (!bar) {
            return false;
        }
        bar.appendChild(spacer);
        bar.appendChild(button);
        return true;
    };
    // Roam re-renders the top bar, for example when the left sidebar opens or
    // closes, which drops the button. Put it back whenever the page changes
    // and it is missing; the check is one property read.
    const barObserver = new MutationObserver(() => {
        if (!button.isConnected) {
            placeButton();
        }
    });
    barObserver.observe(document.body, { childList: true, subtree: true });
    placeButton();

    // Commands.
    const pushCurrent = async (): Promise<void> => {
        const page = await graph.currentPage();
        if (!page) {
            toast("Open a page first.", "warning");
            return;
        }
        const result = await engine.push(page);
        toast(result.message, result.ok ? "success" : "danger");
    };
    const removeCurrent = async (): Promise<void> => {
        const page = await graph.currentPage();
        if (!page) {
            toast("Open a page first.", "warning");
            return;
        }
        if (!engine.isSynced(page.uid)) {
            toast("This page is not in Asyntai.", "warning");
            return;
        }
        const ok = await engine.remove(page.uid);
        toast(ok ? "Page removed from Asyntai." : "Asyntai did not remove the page.", ok ? "success" : "danger");
    };
    const sendAll = async (): Promise<void> => {
        toast("Sending pages to Asyntai…");
        const result = await engine.syncAll();
        const parts = [`${result.sent} sent`, `${result.skipped} skipped`];
        if (result.removed) {
            parts.push(`${result.removed} removed`);
        }
        if (result.failed) {
            parts.push(`${result.failed} failed`);
        }
        toast(parts.join(", "), result.failed ? "warning" : "success");
        if (result.errors.length) {
            console.error("[asyntai]", result.errors);
        }
    };
    const removeAll = async (): Promise<void> => {
        const removed = await engine.removeAll();
        toast(`${pages(removed)} removed from Asyntai.`, "success");
    };
    const checkKey = async (): Promise<void> => {
        try {
            const account = await api.account();
            toast(`Connected as ${account.email} on the ${account.plan} plan.`, "success");
        } catch (err) {
            toast(errorText(err), "danger");
        }
    };

    const palette = extensionAPI.ui?.commandPalette;
    const commands: Array<[string, () => void]> = [
        [COMMANDS.open, () => open()],
        [COMMANDS.sendPage, () => void pushCurrent()],
        [COMMANDS.removePage, () => void removeCurrent()],
        [COMMANDS.sendAll, () => void sendAll()],
        [COMMANDS.removeAll, () => void removeAll()],
        [COMMANDS.checkKey, () => void checkKey()],
    ];
    for (const [label, callback] of commands) {
        await Promise.resolve(palette?.addCommand({ label, callback }));
    }

    // "/Asyntai ask" opens the panel with the block's text as the question.
    // Returning "" tells Roam to drop the typed slash command from the block.
    const slash = extensionAPI.ui?.slashCommand;
    await Promise.resolve(
        slash?.addCommand({
            label: SLASH_LABEL,
            callback: (context: SlashContext) => {
                const active = document.activeElement as HTMLTextAreaElement | null;
                const value = active && active.tagName === "TEXTAREA" ? active.value : "";
                const question = questionFromBlock(value, context?.indexes);
                open(context?.["block-uid"] || graph.focusedBlockUid());
                panel.askAbout(question);
                return "";
            },
        }),
    );

    // Auto sync. Roam has no "something changed" event for the whole graph,
    // so each page's :page/edit-time is read on a timer. A page is handled
    // once it changed after the last time it was handled (or after the
    // extension started) and its writer paused. The handled times live in
    // memory only, so nothing is written to the settings for a page that did
    // not change.
    const startedAt = Date.now();
    const handled: Record<string, number> = {};
    let busy = false;
    const tick = async (): Promise<void> => {
        if (busy || !flag(KEY.autoSync, true) || !text(KEY.apiKey).trim()) {
            return;
        }
        // Roam runs offline too. Edits made offline are picked up on the
        // first check after the connection is back.
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            return;
        }
        busy = true;
        try {
            const times = await graph.editTimes();
            const now = Date.now();
            for (const [uid, edited] of Object.entries(times)) {
                if (edited <= (handled[uid] ?? startedAt) || now - edited < QUIET_MS) {
                    continue;
                }
                const page = await graph.page(uid);
                if (!page) {
                    continue;
                }
                let ok = true;
                if (engine.wanted(page)) {
                    ok = (await engine.push(page)).ok;
                } else if (engine.isSynced(uid)) {
                    // Renamed out of the chosen pages.
                    ok = await engine.remove(uid);
                }
                // A failed send is tried again on the next check.
                if (ok) {
                    handled[uid] = edited;
                }
            }
            // Deleted pages.
            for (const uid of Object.keys(engine.entries())) {
                if (!(uid in times) && !(await graph.exists(uid))) {
                    await engine.remove(uid);
                }
            }
        } catch (err) {
            console.error("[asyntai] auto sync", err);
        } finally {
            busy = false;
        }
    };
    const watchTimer = setInterval(() => void tick(), WATCH_INTERVAL_MS);

    runtime = {
        stop: () => {
            clearInterval(watchTimer);
            barObserver.disconnect();
            document.removeEventListener("keydown", onKey);
            button.remove();
            spacer.remove();
            host.remove();
            document.getElementById(TOAST_BOX_ID)?.remove();
            style.remove();
            for (const [label] of commands) {
                try {
                    void palette?.removeCommand?.({ label });
                } catch {
                    // Roam already removed it.
                }
            }
            try {
                void slash?.removeCommand?.({ label: SLASH_LABEL });
            } catch {
                // Roam already removed it.
            }
        },
    };

    // The end-to-end test sets this flag before loading, to drive the watcher
    // without waiting for the timer. Roam itself never sets it.
    const testHooks = window as unknown as Record<string, unknown>;
    if (testHooks.__asyntaiTest === true) {
        testHooks.__asyntaiRoam = { engine, graph, tick, panel };
    }
    console.log("[asyntai] extension ready");
}

function onunload(): void {
    runtime?.stop();
    runtime = null;
    delete (window as unknown as Record<string, unknown>).__asyntaiRoam;
    console.log("[asyntai] extension unloaded");
}

export default { onload, onunload };

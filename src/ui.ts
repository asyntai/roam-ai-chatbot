// The panel. Roam runs an extension inside its own page, so the panel is
// plain DOM in a fixed box at the right edge, styled by styles.ts.

import { AsyntaiApi, Lead, Message, Session, newAskSession } from "./api";
import { errorText } from "./sync";

type Tab = "ask" | "chats" | "leads";

export interface PanelHooks {
    /** Puts the answer into the block the writer was editing. */
    insert: (text: string) => Promise<void>;
    /** Makes a new page from a saved chat. */
    saveAsPage: (title: string, body: string) => Promise<void>;
    close: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/** "2026-10-11 visitor question", short enough to read in the sidebar. */
export function chatTitle(session: Session): string {
    const date = (session.first_message_at || session.last_message_at || "").slice(0, 10);
    const words = (session.first_message || session.session_id || "chat")
        .replace(/[\[\]#/{}()^*_~`|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60)
        .trim();
    return [date, words || session.session_id].filter(Boolean).join(" ");
}

function when(value: string): string {
    if (!value) {
        return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    return date.toLocaleString();
}

export class Panel {
    private api: AsyntaiApi;
    private hooks: PanelHooks;
    private root: HTMLElement;
    private body: HTMLElement;
    private tab: Tab = "ask";
    private tabButtons: Record<Tab, HTMLButtonElement>;
    private askSession = newAskSession();
    private askLog: Message[] = [];
    private busy = false;

    constructor(api: AsyntaiApi, hooks: PanelHooks, mount: HTMLElement) {
        this.api = api;
        this.hooks = hooks;

        this.root = el("div", "asyntai-panel");
        const head = el("div", "asyntai-head");
        head.appendChild(el("div", "asyntai-title", "Asyntai"));

        const tabs = el("div", "asyntai-tabs");
        const make = (tab: Tab, label: string): HTMLButtonElement => {
            const button = el("button", "asyntai-tab", label);
            button.addEventListener("click", () => this.show(tab));
            tabs.appendChild(button);
            return button;
        };
        this.tabButtons = {
            ask: make("ask", "Ask"),
            chats: make("chats", "Chats"),
            leads: make("leads", "Leads"),
        };
        head.appendChild(tabs);

        const close = el("button", "asyntai-close", "×");
        close.setAttribute("aria-label", "Close");
        close.addEventListener("click", () => this.hooks.close());
        head.appendChild(close);

        this.body = el("div", "asyntai-body");
        this.root.appendChild(head);
        this.root.appendChild(this.body);
        mount.appendChild(this.root);

        this.show("ask");
    }

    show(tab: Tab): void {
        this.tab = tab;
        for (const name of Object.keys(this.tabButtons) as Tab[]) {
            this.tabButtons[name].classList.toggle("asyntai-on", name === tab);
        }
        if (tab === "ask") {
            this.renderAsk();
        } else if (tab === "chats") {
            void this.renderChats();
        } else {
            void this.renderLeads();
        }
    }

    /** A fresh question thread, so an old topic never colours a new answer. */
    newThread(): void {
        this.askSession = newAskSession();
        this.askLog = [];
        if (this.tab === "ask") {
            this.renderAsk();
        }
    }

    private clear(): HTMLElement {
        this.body.textContent = "";
        return this.body;
    }

    private note(parent: HTMLElement, text: string, kind = "asyntai-note"): void {
        parent.appendChild(el("div", kind, text));
    }

    private renderAsk(prefill = ""): void {
        const body = this.clear();
        const log = el("div", "asyntai-log");
        if (this.askLog.length === 0) {
            this.note(log, "Ask about the pages you sent to Asyntai.");
        }
        for (const message of this.askLog) {
            const row = el("div", `asyntai-msg asyntai-${message.role}`);
            row.appendChild(el("div", "asyntai-who", message.role === "user" ? "You" : "Asyntai"));
            row.appendChild(el("div", "asyntai-text", message.content));
            if (message.role === "assistant") {
                const insert = el("button", "asyntai-link", "Insert into page");
                insert.addEventListener("click", () => {
                    void this.hooks.insert(message.content);
                });
                row.appendChild(insert);
            }
            log.appendChild(row);
        }
        body.appendChild(log);

        const form = el("div", "asyntai-form");
        const input = el("textarea", "asyntai-input");
        input.rows = 2;
        input.placeholder = "Ask a question";
        input.value = prefill;
        const send = el("button", "asyntai-send", this.busy ? "Asking…" : "Ask");
        send.disabled = this.busy;

        const submit = async (): Promise<void> => {
            const question = input.value.trim();
            if (!question || this.busy) {
                return;
            }
            this.busy = true;
            this.askLog.push({ role: "user", content: question, timestamp: "" });
            this.renderAsk();
            try {
                const answer = await this.api.chat(question, this.askSession);
                this.askLog.push({ role: "assistant", content: answer, timestamp: "" });
            } catch (err) {
                this.askLog.push({ role: "assistant", content: errorText(err), timestamp: "" });
            }
            this.busy = false;
            this.renderAsk();
            log.scrollTop = log.scrollHeight;
        };

        send.addEventListener("click", () => void submit());
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
            }
        });

        const reset = el("button", "asyntai-link", "New thread");
        reset.addEventListener("click", () => this.newThread());

        form.appendChild(input);
        const row = el("div", "asyntai-row");
        row.appendChild(send);
        row.appendChild(reset);
        form.appendChild(row);
        body.appendChild(form);

        log.scrollTop = log.scrollHeight;
        if (!this.busy) {
            input.focus();
        }
    }

    /** Opens the Ask tab with the question already typed. */
    askAbout(question: string): void {
        this.tab = "ask";
        for (const name of Object.keys(this.tabButtons) as Tab[]) {
            this.tabButtons[name].classList.toggle("asyntai-on", name === "ask");
        }
        this.renderAsk(question);
    }

    private async renderChats(): Promise<void> {
        const body = this.clear();
        this.note(body, "Loading…");
        let sessions: Session[];
        try {
            sessions = await this.api.sessions(30);
        } catch (err) {
            this.clear();
            this.note(this.body, errorText(err), "asyntai-error");
            return;
        }
        if (this.tab !== "chats") {
            return;
        }
        const list = this.clear();
        if (sessions.length === 0) {
            this.note(list, "No website chats yet.");
            return;
        }
        for (const session of sessions) {
            const item = el("div", "asyntai-item");
            item.appendChild(el("div", "asyntai-item-title", session.first_message || session.session_id));
            const meta = [when(session.last_message_at), session.country, `${session.message_count} messages`]
                .filter(Boolean)
                .join(" · ");
            item.appendChild(el("div", "asyntai-item-meta", meta));
            item.addEventListener("click", () => void this.openChat(session));
            list.appendChild(item);
        }
    }

    private async openChat(session: Session): Promise<void> {
        const body = this.clear();
        const back = el("button", "asyntai-link", "← Back to chats");
        back.addEventListener("click", () => void this.renderChats());
        body.appendChild(back);
        this.note(body, "Loading…");

        let messages: Message[];
        try {
            messages = await this.api.conversation(session.session_id);
        } catch (err) {
            this.clear();
            this.body.appendChild(back);
            this.note(this.body, errorText(err), "asyntai-error");
            return;
        }

        const view = this.clear();
        view.appendChild(back);
        const save = el("button", "asyntai-link", "Save as page");
        save.title = "Saved chats go under Asyntai chats/ and are never sent back to Asyntai.";
        save.addEventListener("click", () => {
            const lines = messages.map((m) => `${m.role === "user" ? "Visitor" : "Asyntai"}: ${m.content}`);
            const title = `Asyntai chats/${chatTitle(session)}`;
            void this.hooks.saveAsPage(title, lines.join("\n"));
        });
        view.appendChild(save);

        const log = el("div", "asyntai-log");
        for (const message of messages) {
            const row = el("div", `asyntai-msg asyntai-${message.role}`);
            row.appendChild(el("div", "asyntai-who", message.role === "user" ? "Visitor" : "Asyntai"));
            row.appendChild(el("div", "asyntai-text", message.content));
            log.appendChild(row);
        }
        view.appendChild(log);
    }

    private async renderLeads(): Promise<void> {
        const body = this.clear();
        this.note(body, "Loading…");
        let leads: Lead[];
        try {
            leads = await this.api.leads(30);
        } catch (err) {
            this.clear();
            this.note(this.body, errorText(err), "asyntai-error");
            return;
        }
        if (this.tab !== "leads") {
            return;
        }
        const list = this.clear();
        if (leads.length === 0) {
            this.note(list, "No leads yet.");
            return;
        }
        for (const lead of leads) {
            const item = el("div", "asyntai-item");
            item.appendChild(el("div", "asyntai-item-title", lead.email || lead.phone || lead.session_id));
            const meta = [when(lead.started_at), lead.phone && lead.email ? lead.phone : "", lead.page_url]
                .filter(Boolean)
                .join(" · ");
            item.appendChild(el("div", "asyntai-item-meta", meta));
            list.appendChild(item);
        }
    }
}

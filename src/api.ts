// One place for every call to Asyntai.
//
// The transport is injected: inside Roam it is the browser `fetch` (the
// Asyntai API answers cross-origin calls), in the tests it is node's fetch.
// Both hand back the status code and the raw body, nothing else is needed.

export const DEFAULT_ORIGIN = "https://asyntai.com";

export interface TransportRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

export interface TransportResponse {
    status: number;
    text: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export class ApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export interface Account {
    email: string;
    plan: string;
    messages_used: number;
    messages_limit: number;
}

export interface Session {
    session_id: string;
    message_count: number;
    first_message: string;
    first_message_at: string;
    last_message_at: string;
    page_url: string;
    country: string;
    category: string;
    website_domain: string;
}

export interface Message {
    role: "user" | "assistant";
    content: string;
    timestamp: string;
}

export interface Lead {
    session_id: string;
    email: string;
    phone: string;
    page_url: string;
    started_at: string;
}

export interface KnowledgeEntry {
    id: string;
    title: string;
}

// Questions asked from the panel go through the same endpoint as a visitor
// chat, so Asyntai stores them as sessions. They are the owner's own
// questions, so the Chats tab leaves them out. Every one carries this marker.
export const ASK_MARKER = "roam_ask_";

export function newAskSession(): string {
    return `${ASK_MARKER}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isOwnQuestion(sessionId: string): boolean {
    return typeof sessionId === "string" && sessionId.includes(ASK_MARKER);
}

/**
 * The API key and the page text go to this address, so only https is
 * accepted. Plain http is allowed for localhost and 127.0.0.1 only, which
 * never leaves the machine (used by the test suite).
 */
export function isSafeOrigin(origin: string): boolean {
    return /^https:\/\/[^\s/]+/i.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const name of Object.keys(params)) {
        const value = params[name];
        if (value !== undefined && value !== null && value !== "") {
            search.set(name, String(value));
        }
    }
    const text = search.toString();
    return text ? `?${text}` : "";
}

export class AsyntaiApi {
    private transport: Transport;
    private apiKey: () => string;
    private origin: () => string;

    constructor(transport: Transport, apiKey: () => string, origin: () => string = () => DEFAULT_ORIGIN) {
        this.transport = transport;
        this.apiKey = apiKey;
        this.origin = origin;
    }

    private async request(path: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
        const key = this.apiKey().trim();
        if (!key) {
            throw new ApiError("Add your Asyntai API key in Settings > Asyntai AI Chatbot.", 401);
        }
        const headers: Record<string, string> = {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
        };
        const origin = this.origin().trim().replace(/\/+$/, "");
        if (!isSafeOrigin(origin)) {
            throw new ApiError("The Asyntai address must start with https://.", 0);
        }
        const req: TransportRequest = {
            url: origin + path,
            method,
            headers,
        };
        if (body !== undefined) {
            headers["Content-Type"] = "application/json";
            req.body = JSON.stringify(body);
        }

        let res: TransportResponse;
        try {
            res = await this.transport(req);
        } catch {
            throw new ApiError("Asyntai did not answer. Check your connection.", 0);
        }

        let data: Record<string, unknown> = {};
        try {
            data = res.text ? (JSON.parse(res.text) as Record<string, unknown>) : {};
        } catch {
            data = {};
        }

        if (res.status === 401) {
            throw new ApiError("Asyntai does not accept this API key.", 401);
        }
        if (res.status === 403) {
            throw new ApiError(
                typeof data.error === "string" ? data.error : "The Asyntai API needs the Starter plan or higher.",
                403,
            );
        }
        if (res.status < 200 || res.status >= 300 || data.success === false) {
            const message = typeof data.error === "string" ? data.error : `Asyntai answered with status ${res.status}.`;
            throw new ApiError(message, res.status);
        }
        return data;
    }

    async account(): Promise<Account> {
        const data = await this.request("/api/v1/account/");
        return data.account as Account;
    }

    async sessions(limit = 30): Promise<Session[]> {
        const data = await this.request(`/api/v1/sessions/${query({ limit })}`);
        const list = (data.sessions as Session[]) || [];
        return list.filter((s) => !isOwnQuestion(s.session_id));
    }

    async conversation(sessionId: string): Promise<Message[]> {
        const data = await this.request(`/api/v1/conversations/${query({ session_id: sessionId, limit: 100 })}`);
        return (data.messages as Message[]) || [];
    }

    async leads(limit = 30): Promise<Lead[]> {
        const data = await this.request(`/api/v1/leads/${query({ limit })}`);
        return (data.leads as Lead[]) || [];
    }

    async chat(message: string, sessionId: string): Promise<string> {
        const data = await this.request("/api/v1/chat/", "POST", { message, session_id: sessionId });
        return String(data.response || "");
    }

    async addText(title: string, content: string): Promise<string> {
        const data = await this.request("/api/v1/knowledge/text/", "POST", { title, content });
        const id = data.id;
        if (typeof id !== "string" || !id) {
            throw new ApiError("Asyntai stored the note but returned no id.", 500);
        }
        return id;
    }

    // 404 counts as done: the entry is already gone on the Asyntai side.
    async deleteEntry(id: string): Promise<void> {
        try {
            await this.request(`/api/v1/knowledge/${encodeURIComponent(id)}/`, "DELETE");
        } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
                return;
            }
            throw err;
        }
    }

    async knowledge(limit = 100): Promise<KnowledgeEntry[]> {
        const data = await this.request(`/api/v1/knowledge/${query({ limit })}`);
        return (data.entries as KnowledgeEntry[]) || [];
    }
}

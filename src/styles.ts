// The panel's look. Injected as one <style> on load and removed on unload,
// so nothing is left behind in Roam when the extension is turned off.

export const STYLE_ID = "asyntai-ai-chatbot-style";

export const CSS = `
.asyntai-host { position: fixed; top: 50px; right: 16px; bottom: 16px; width: 380px; max-width: calc(100vw - 32px);
  z-index: 30; display: none; }
.asyntai-host.asyntai-open { display: block; }
.asyntai-panel { height: 100%; display: flex; flex-direction: column; background: #fff; color: #111;
  border: 1px solid #d8d8d8; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.12);
  font-size: 14px; line-height: 1.45; overflow: hidden; }
.asyntai-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eee; }
.asyntai-title { font-weight: 600; }
.asyntai-tabs { display: flex; gap: 4px; margin-left: 8px; flex: 1; }
.asyntai-tab { background: none; border: 1px solid transparent; border-radius: 6px; padding: 3px 9px; cursor: pointer; color: #444; }
.asyntai-tab.asyntai-on { border-color: #111; color: #111; }
.asyntai-close { background: none; border: none; font-size: 20px; line-height: 1; cursor: pointer; color: #666; }
.asyntai-body { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.asyntai-log { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.asyntai-msg { border: 1px solid #eee; border-radius: 6px; padding: 8px 10px; }
.asyntai-msg.asyntai-user { background: #f6f6f6; }
.asyntai-who { font-size: 12px; color: #666; margin-bottom: 2px; }
.asyntai-text { white-space: pre-wrap; word-wrap: break-word; }
.asyntai-form { display: flex; flex-direction: column; gap: 6px; }
.asyntai-input { width: 100%; box-sizing: border-box; resize: vertical; border: 1px solid #ccc; border-radius: 6px;
  padding: 7px 9px; font: inherit; }
.asyntai-row { display: flex; align-items: center; gap: 10px; }
.asyntai-send { background: #111; color: #fff; border: none; border-radius: 6px; padding: 6px 14px; cursor: pointer; }
.asyntai-send:disabled { opacity: .6; cursor: default; }
.asyntai-link { background: none; border: none; padding: 0; color: #111; text-decoration: underline; cursor: pointer;
  font-size: 13px; align-self: flex-start; }
.asyntai-note { color: #666; }
.asyntai-error { color: #b00020; }
.asyntai-item { border: 1px solid #eee; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
.asyntai-item:hover { border-color: #bbb; }
.asyntai-item-title { font-weight: 500; }
.asyntai-item-meta { font-size: 12px; color: #666; margin-top: 2px; }
.bp3-dark .asyntai-panel { background: #1e1e1e; color: #eee; border-color: #333; }
.bp3-dark .asyntai-msg, .bp3-dark .asyntai-item, .bp3-dark .asyntai-head { border-color: #333; }
.bp3-dark .asyntai-msg.asyntai-user { background: #2a2a2a; }
.bp3-dark .asyntai-tab.asyntai-on, .bp3-dark .asyntai-link { border-color: #eee; color: #eee; }
.bp3-dark .asyntai-send { background: #eee; color: #111; }
.bp3-dark .asyntai-input { background: #2a2a2a; color: #eee; border-color: #444; }
`;

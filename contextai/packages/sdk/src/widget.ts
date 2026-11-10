type WidgetResult = {
  answer?: string;
  conversationId?: string;
  limitations?: string[];
  citations?: { url: string; title: string; index?: number }[];
  searchSuggestions?: string | null;
};

const styles = `
  :host { all: initial; color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  .root { position: fixed; z-index: 2147483000; right: 20px; bottom: 20px; pointer-events: none; }
  button, input { font: inherit; }
  button { cursor: pointer; }
  .launcher { pointer-events: auto; display: flex; align-items: center; gap: 10px; margin-left: auto; padding: 12px 17px; border: 0; border-radius: 999px; background: var(--contextai-accent, #c4b5fd); color: #171323; box-shadow: 0 8px 32px #0008; font-size: 14px; font-weight: 700; }
  .launcher:hover { filter: brightness(1.06); }
  .panel { pointer-events: auto; display: none; flex-direction: column; width: min(390px, calc(100vw - 32px)); height: min(600px, calc(100dvh - 96px)); margin-bottom: 12px; overflow: hidden; border: 1px solid #ffffff20; border-radius: 20px; background: #111116; color: #f4f4f5; box-shadow: 0 24px 80px #000a; }
  .panel.open { display: flex; }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid #ffffff12; background: linear-gradient(120deg, #1d1b27, #121218); }
  .title { overflow: hidden; color: #fff; font-size: 14px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
  .subtitle { margin-top: 3px; color: #a1a1aa; font-size: 11px; }
  .close { width: 32px; height: 32px; flex: none; border: 1px solid #ffffff18; border-radius: 10px; background: #ffffff08; color: #d4d4d8; font-size: 19px; line-height: 1; }
  .close:hover { background: #ffffff14; }
  .messages { display: flex; flex: 1; flex-direction: column; gap: 12px; overflow: auto; padding: 16px; }
  .welcome { max-width: 90%; padding: 12px 14px; border: 1px solid #ffffff12; border-radius: 14px 14px 14px 4px; background: #ffffff09; color: #e4e4e7; font-size: 13px; line-height: 1.55; white-space: pre-wrap; }
  .message { max-width: 90%; padding: 11px 13px; border-radius: 14px; font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
  .message.user { align-self: flex-end; border: 1px solid #c4b5fd45; border-radius: 14px 14px 4px 14px; background: #8b5cf622; color: #f5f3ff; }
  .message.assistant { align-self: flex-start; border: 1px solid #ffffff12; border-radius: 14px 14px 14px 4px; background: #ffffff09; color: #e4e4e7; }
  .message.error { border-color: #ef444455; color: #fca5a5; }
  .message small { display: block; margin-top: 8px; color: #a1a1aa; font-size: 11px; }
  .message ol { margin: 8px 0 0; padding: 8px 0 0; border-top: 1px solid #ffffff12; list-style: none; font-size: 11px; white-space: normal; }
  .message ol a { color: #c4b5fd; text-decoration: none; }
  .message ol a:hover { text-decoration: underline; }
  .message iframe { display: block; width: 100%; height: 64px; margin-top: 8px; border: 0; border-radius: 10px; }
  .quick { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 16px 12px; }
  .quick button { padding: 7px 10px; border: 1px solid #ffffff18; border-radius: 999px; background: #ffffff06; color: #d4d4d8; font-size: 11px; }
  .quick button:hover { border-color: #c4b5fd80; color: #ddd6fe; }
  .composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #ffffff12; background: #0c0c10; }
  .composer input { min-width: 0; flex: 1; padding: 11px 12px; border: 1px solid #ffffff18; border-radius: 12px; outline: none; background: #ffffff08; color: #fff; font-size: 13px; }
  .composer input:focus { border-color: #c4b5fd90; }
  .composer input::placeholder { color: #71717a; }
  .send { padding: 0 14px; border: 0; border-radius: 12px; background: var(--contextai-accent, #c4b5fd); color: #171323; font-size: 12px; font-weight: 700; }
  .send:disabled { cursor: wait; opacity: .55; }
  .privacy { padding: 0 14px 10px; color: #71717a; font-size: 10px; text-align: center; }
  @media (max-width: 480px) {
    .root { right: 12px; bottom: 12px; }
    .panel { width: calc(100vw - 24px); height: min(620px, calc(100dvh - 84px)); }
  }
`;

const STATUS_PROMPTS = [
  'Check the current app status',
  'Is the service healthy right now?',
  'Are there any active issues or outages?',
];

export function defineContextAIWidget() {
  if (typeof window === 'undefined' || !('customElements' in window) || customElements.get('contextai-widget')) return;

  class ContextAIWidget extends HTMLElement {
    private conversationId?: string;
    private busy = false;
    private root?: ShadowRoot;

    connectedCallback() {
      if (this.root) return;
      this.root = this.attachShadow({ mode: 'open' });
      this.render();
    }

    private render() {
      if (!this.root) return;
      const title = this.getAttribute('title') || 'Ask us anything';
      const welcome = this.getAttribute('welcome') || 'Hi! Ask me about this app, its features, or current status.';
      this.root.innerHTML = `
        <style>${styles}</style>
        <div class="root">
          <section class="panel" role="dialog" aria-label="${this.escape(title)}" aria-modal="false">
            <header class="header">
              <div><div class="title">${this.escape(title)}</div><div class="subtitle">Project-aware answers, grounded in app data</div></div>
              <button class="close" type="button" aria-label="Close chat">×</button>
            </header>
            <div class="messages" aria-live="polite"><div class="welcome">${this.escape(welcome)}</div></div>
            <div class="quick" aria-label="Suggested questions">
              ${STATUS_PROMPTS.map((prompt) => `<button type="button" data-prompt="${this.escape(prompt)}">${this.escape(prompt)}</button>`).join('')}
            </div>
            <form class="composer">
              <input aria-label="Your question" maxlength="1000" placeholder="Ask a question…" autocomplete="off" />
              <button class="send" type="submit">Send</button>
            </form>
            <div class="privacy">Answers are generated from the connected project and its configured sources.</div>
          </section>
          <button class="launcher" type="button" aria-expanded="false"><span aria-hidden="true">✦</span><span>Chat</span></button>
        </div>`;

      const panel = this.root.querySelector<HTMLElement>('.panel')!;
      const launcher = this.root.querySelector<HTMLButtonElement>('.launcher')!;
      const close = this.root.querySelector<HTMLButtonElement>('.close')!;
      const input = this.root.querySelector<HTMLInputElement>('.composer input')!;
      const form = this.root.querySelector<HTMLFormElement>('.composer')!;

      const setOpen = (open: boolean) => {
        panel.classList.toggle('open', open);
        launcher.setAttribute('aria-expanded', String(open));
        launcher.querySelectorAll('span')[1].textContent = open ? 'Close' : 'Chat';
        if (open) input.focus();
      };
      launcher.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
      close.addEventListener('click', () => setOpen(false));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const question = input.value.trim();
        if (question) {
          input.value = '';
          void this.ask(question);
        }
      });
      this.root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach((button) => {
        button.addEventListener('click', () => void this.ask(button.dataset.prompt || ''));
      });
    }

    private escape(value: string) {
      return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
    }

    private addMessage(kind: 'user' | 'assistant' | 'error', text: string, limitations: string[] = [], result: WidgetResult = {}) {
      const messages = this.root?.querySelector<HTMLElement>('.messages');
      if (!messages) return;
      const message = document.createElement('div');
      message.className = `message ${kind === 'error' ? 'assistant error' : kind}`;
      message.textContent = text;
      const citations = (result.citations || []).filter((c) => /^https?:\/\//i.test(c.url));
      if (citations.length) {
        const list = document.createElement('ol');
        citations.forEach((c, i) => {
          const item = document.createElement('li');
          const link = document.createElement('a');
          link.href = c.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer nofollow';
          link.textContent = c.title || c.url;
          item.append(`[${c.index ?? i + 1}] `, link);
          list.append(item);
        });
        message.append(list);
      }
      // Google Search Suggestions are shown unmodified with grounded answers, isolated from the page.
      if (result.searchSuggestions) {
        const frame = document.createElement('iframe');
        frame.title = 'Google Search Suggestions';
        frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
        frame.srcdoc = `<base target="_blank">${result.searchSuggestions}`;
        message.append(frame);
      }
      if (limitations.length) {
        const note = document.createElement('small');
        note.textContent = limitations.join(' ');
        message.append(note);
      }
      messages.append(message);
      messages.scrollTop = messages.scrollHeight;
    }

    private async ask(question: string) {
      if (this.busy) return;
      const projectId = this.getAttribute('project-id');
      const publicKey = this.getAttribute('public-key');
      const baseUrl = this.getAttribute('base-url')?.replace(/\/+$/, '');
      if (!projectId || !publicKey || !baseUrl) {
        this.addMessage('error', 'Widget setup is incomplete. Provide project-id, public-key, and base-url.');
        return;
      }
      if (!publicKey.startsWith('pk_')) {
        this.addMessage('error', 'The widget requires a project public key (pk_…). Secret keys must never be used in a browser.');
        return;
      }

      this.addMessage('user', question);
      this.busy = true;
      const send = this.root?.querySelector<HTMLButtonElement>('.send');
      const input = this.root?.querySelector<HTMLInputElement>('.composer input');
      if (send) { send.disabled = true; send.textContent = '…'; }
      if (input) input.disabled = true;
      try {
        const response = await fetch(`${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Project-Key': publicKey },
          body: JSON.stringify({ question, ...(this.conversationId ? { conversationId: this.conversationId } : {}) }),
        });
        const result = await response.json() as WidgetResult & { error?: string; details?: string[] };
        if (!response.ok) throw new Error(result.details?.join('; ') || result.error || `Request failed (${response.status})`);
        this.conversationId = result.conversationId;
        this.addMessage('assistant', result.answer || 'I could not produce an answer for that question.', result.limitations || [], result);
      } catch (error) {
        this.addMessage('error', error instanceof Error ? error.message : 'The assistant could not be reached. Please try again.');
      } finally {
        this.busy = false;
        if (send) { send.disabled = false; send.textContent = 'Send'; }
        if (input) { input.disabled = false; input.focus(); }
      }
    }
  }

  customElements.define('contextai-widget', ContextAIWidget);
}

defineContextAIWidget();

export class LiveConnection {
  constructor({ streamUrl, poll, onEvent, onStatus }) {
    this.streamUrl = streamUrl;
    this.poll = poll;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.source = null;
    this.fallbackTimer = null;
    this.pollTimer = null;
  }

  open(eventNames = []) {
    this.close();
    this.onStatus('reconnecting');
    const source = new EventSource(this.streamUrl, { withCredentials: true });
    this.source = source;
    source.onopen = () => {
      this.onStatus('connected');
      this.stopFallback();
      void this.poll().then((state) => this.onEvent('snapshot', state)).catch(() => {});
    };
    source.onerror = () => {
      this.onStatus('reconnecting');
      this.startFallback();
    };
    const names = ['snapshot', 'presence', 'vote-progress', 'session-revoked', ...eventNames];
    for (const name of new Set(names)) {
      source.addEventListener(name, (event) => {
        try { this.onEvent(name, JSON.parse(event.data)); } catch {}
      });
    }
  }

  startFallback() {
    if (!this.fallbackTimer) {
      this.fallbackTimer = setTimeout(() => {
        this.fallbackTimer = null;
        if (this.pollTimer) return;
        const run = async () => {
          try { this.onEvent('snapshot', await this.poll()); } catch {}
        };
        void run();
        this.pollTimer = setInterval(run, 5000);
      }, 10000);
    }
  }

  stopFallback() {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.fallbackTimer = null;
    this.pollTimer = null;
  }

  close() {
    this.stopFallback();
    this.source?.close();
    this.source = null;
  }
}

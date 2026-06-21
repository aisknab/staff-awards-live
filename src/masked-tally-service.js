export class MaskedTallyService {
  constructor(resultService, config, onPublish = () => {}) {
    this.results = resultService;
    this.config = config;
    this.onPublish = onPublish;
    this.cache = new Map();
    this.pending = new Map();
  }

  get(round) {
    const cached = this.cache.get(round.id);
    if (cached && cached.roundVersion === round.version) return cached;
    const tally = this.results.publicTally(round);
    this.cache.set(round.id, tally);
    return tally;
  }

  initialise(round) {
    const tally = this.results.publicTally(round);
    this.cache.set(round.id, tally);
    return tally;
  }

  queue(round) {
    const now = Date.now();
    let entry = this.pending.get(round.id);
    if (!entry) {
      entry = { round, firstDirtyAt: now, dirtyChanges: 0, lastPublishedAt: this.cache.has(round.id) ? now : 0, timer: null, targetAt: 0 };
      this.pending.set(round.id, entry);
    }
    entry.round = round;
    entry.dirtyChanges += 1;
    const earliest = Math.max(now, entry.lastPublishedAt + this.config.maskedMinIntervalMs);
    const latest = entry.firstDirtyAt + this.config.maskedMaxDelayMs;
    const target = entry.dirtyChanges >= 2 ? earliest : latest;
    this.schedule(entry, Math.min(target, latest));
  }

  schedule(entry, targetAt) {
    if (entry.timer && entry.targetAt <= targetAt) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.targetAt = targetAt;
    entry.timer = setTimeout(() => this.publish(entry.round.id), Math.max(0, targetAt - Date.now()));
    entry.timer.unref?.();
  }

  publish(roundId, { force = false } = {}) {
    const entry = this.pending.get(roundId);
    const round = entry?.round;
    if (!round) return this.cache.get(roundId) ?? null;
    if (entry.timer) clearTimeout(entry.timer);
    const tally = this.results.publicTally(round);
    this.cache.set(roundId, tally);
    this.pending.delete(roundId);
    this.onPublish(round.event_id, roundId, tally, force);
    return tally;
  }

  force(round) {
    let entry = this.pending.get(round.id);
    if (!entry) {
      entry = { round, firstDirtyAt: Date.now(), dirtyChanges: 1, lastPublishedAt: 0, timer: null, targetAt: 0 };
      this.pending.set(round.id, entry);
    } else {
      entry.round = round;
    }
    return this.publish(round.id, { force: true });
  }

  clear(roundId) {
    const entry = this.pending.get(roundId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.pending.delete(roundId);
    this.cache.delete(roundId);
  }

  close() {
    for (const entry of this.pending.values()) if (entry.timer) clearTimeout(entry.timer);
    this.pending.clear();
    this.cache.clear();
  }
}

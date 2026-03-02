/**
 * SessionLifecycle — 会话生命周期管理。
 * 提供 warmup / touch / isExpired / cleanup 状态机，
 * 自动清理超时会话防止内存泄漏。
 */

const LIFECYCLE_STATES = {
    CREATED: 'created',
    WARMING_UP: 'warming_up',
    ACTIVE: 'active',
    PAUSED: 'paused',
    CLEANING_UP: 'cleaning_up',
    TERMINATED: 'terminated',
};

class SessionLifecycle {
    constructor({ sessionId, memoryStore, ttl = 3600000 }) {
        this.sessionId = sessionId;
        this.memoryStore = memoryStore;
        this.ttl = ttl;
        this.state = LIFECYCLE_STATES.CREATED;
        this.createdAt = Date.now();
        this.lastActivityAt = Date.now();
        this._ttlTimer = null;
    }

    async warmup() {
        this.state = LIFECYCLE_STATES.WARMING_UP;
        let memory = null;
        if (this.memoryStore) {
            try {
                memory = this.memoryStore.getSummary(this.sessionId);
            } catch (_) { /* no previous session */ }
        }
        this.state = LIFECYCLE_STATES.ACTIVE;
        this._startTTLTimer();
        return memory;
    }

    touch() {
        this.lastActivityAt = Date.now();
        if (this.state === LIFECYCLE_STATES.PAUSED) {
            this.state = LIFECYCLE_STATES.ACTIVE;
        }
    }

    isExpired() {
        return Date.now() - this.lastActivityAt > this.ttl;
    }

    isActive() {
        return this.state === LIFECYCLE_STATES.ACTIVE;
    }

    pause() {
        if (this.state === LIFECYCLE_STATES.ACTIVE) {
            this.state = LIFECYCLE_STATES.PAUSED;
        }
    }

    async cleanup() {
        this.state = LIFECYCLE_STATES.CLEANING_UP;
        if (this._ttlTimer) {
            clearInterval(this._ttlTimer);
            this._ttlTimer = null;
        }
        this.state = LIFECYCLE_STATES.TERMINATED;
    }

    _startTTLTimer() {
        if (this._ttlTimer) clearInterval(this._ttlTimer);
        this._ttlTimer = setInterval(() => {
            if (this.isExpired()) {
                this.cleanup().catch(() => {});
            }
        }, 60000);
        // Prevent timer from keeping process alive
        if (this._ttlTimer.unref) this._ttlTimer.unref();
    }
}

module.exports = { SessionLifecycle, LIFECYCLE_STATES };

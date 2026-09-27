use std::time::{Duration, Instant};

const WAIT_TIMEOUT_MS: u32 = 100;
const WAIT_TIMEOUTS_BEFORE_PAUSE: u32 = 3;
const WAIT_PAUSE: Duration = Duration::from_secs(2);
const WAIT_PROBE_MS: u32 = 50;

#[derive(Clone, Copy, Default)]
pub(crate) struct WaitState {
    timeouts: u32,
    paused_until: Option<Instant>,
}

impl WaitState {
    pub(crate) fn timeout_ms(&self, now: Instant) -> Option<u32> {
        match self.paused_until {
            Some(until) if now < until => None,
            Some(_) => Some(WAIT_PROBE_MS),
            None => Some(WAIT_TIMEOUT_MS),
        }
    }

    pub(crate) fn timed_out(&mut self, now: Instant) {
        self.timeouts += 1;
        if self.paused_until.is_some() || self.timeouts >= WAIT_TIMEOUTS_BEFORE_PAUSE {
            self.timeouts = 0;
            self.paused_until = Some(now + WAIT_PAUSE);
        }
    }

    pub(crate) fn signaled(&mut self) -> bool {
        let recovering = self.timeouts > 0 || self.paused_until.is_some();
        *self = Self::default();
        recovering
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_chain_cannot_reset_stalled_chain() {
        let now = Instant::now();
        let mut stalled = WaitState::default();
        let mut healthy = WaitState::default();
        for _ in 0..WAIT_TIMEOUTS_BEFORE_PAUSE {
            assert_eq!(stalled.timeout_ms(now), Some(WAIT_TIMEOUT_MS));
            stalled.timed_out(now);
            healthy.signaled();
        }
        assert_eq!(stalled.timeout_ms(now), None);
        assert_eq!(healthy.timeout_ms(now), Some(WAIT_TIMEOUT_MS));
    }

    #[test]
    fn failed_probe_pauses_only_its_chain() {
        let now = Instant::now();
        let mut stalled = WaitState::default();
        let healthy = WaitState::default();
        for _ in 0..WAIT_TIMEOUTS_BEFORE_PAUSE {
            stalled.timed_out(now);
        }
        let probe_at = now + WAIT_PAUSE;
        assert_eq!(stalled.timeout_ms(probe_at - Duration::from_millis(1)), None);
        assert_eq!(stalled.timeout_ms(probe_at), Some(WAIT_PROBE_MS));
        stalled.timed_out(probe_at);
        assert_eq!(stalled.timeout_ms(probe_at), None);
        assert_eq!(healthy.timeout_ms(probe_at), Some(WAIT_TIMEOUT_MS));
        assert_eq!(stalled.timeout_ms(probe_at + WAIT_PAUSE), Some(WAIT_PROBE_MS));
    }

    #[test]
    fn successful_probe_restores_normal_wait() {
        let now = Instant::now();
        let mut state = WaitState::default();
        for _ in 0..WAIT_TIMEOUTS_BEFORE_PAUSE {
            state.timed_out(now);
        }
        state.signaled();
        assert_eq!(state.timeout_ms(now + WAIT_PAUSE), Some(WAIT_TIMEOUT_MS));
        state.timed_out(now + WAIT_PAUSE);
        assert_eq!(state.timeout_ms(now + WAIT_PAUSE), Some(WAIT_TIMEOUT_MS));
    }
}

use serde::{Deserialize, Serialize};

// delta debugging (zeller's ddmin) over the things that differ from a setup that ran. a test keeps some of them as the
// player has them and switches the rest back, one kute start per test. pure, recovery.rs runs the starts

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase", tag = "stage", content = "index")]
pub enum Stage {
    // everything switched back: when that still crashes it is not the setup
    Baseline,
    Subset(usize),
    Complement(usize),
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", tag = "verdict", content = "items")]
pub enum Verdict {
    Culprit(Vec<usize>),
    NotTheSetup,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ddmin {
    pub suspects: Vec<usize>,
    pub n: usize,
    pub stage: Stage,
    pub verdict: Option<Verdict>,
}

fn chunks(items: &[usize], n: usize) -> Vec<Vec<usize>> {
    let n = n.clamp(1, items.len().max(1));
    (0..n).map(|index| items[index * items.len() / n..(index + 1) * items.len() / n].to_vec()).collect()
}

impl Ddmin {
    /// the full set crashed already, that is why the search runs
    pub fn new(count: usize) -> Ddmin {
        Ddmin {
            suspects: (0..count).collect(),
            n: 2,
            stage: Stage::Baseline,
            verdict: if count == 0 { Some(Verdict::NotTheSetup) } else { None },
        }
    }

    /// the items kept as the player has them in the next start, None once there is a verdict
    pub fn next(&self) -> Option<Vec<usize>> {
        if self.verdict.is_some() {
            return None;
        }
        let parts = chunks(&self.suspects, self.n);
        Some(match self.stage {
            Stage::Baseline => Vec::new(),
            Stage::Subset(index) => parts[index].clone(),
            Stage::Complement(index) => self.suspects.iter().copied().filter(|item| !parts[index].contains(item)).collect(),
        })
    }

    fn narrow(&mut self, suspects: Vec<usize>, n: usize) {
        if suspects.len() == 1 {
            self.verdict = Some(Verdict::Culprit(suspects));
            return;
        }
        self.n = n.min(suspects.len());
        self.suspects = suspects;
        self.stage = Stage::Subset(0);
    }

    // no part alone and no complement crashes: finer parts, or the suspects themselves when they can't be split further
    fn refine(&mut self) {
        if self.n < self.suspects.len() {
            self.n = (self.n * 2).min(self.suspects.len());
            self.stage = Stage::Subset(0);
        } else {
            self.verdict = Some(Verdict::Culprit(self.suspects.clone()));
        }
    }

    pub fn report(&mut self, crashed: bool) {
        let Some(tested) = self.next() else { return };
        match self.stage {
            Stage::Baseline if crashed => self.verdict = Some(Verdict::NotTheSetup),
            Stage::Baseline => {
                let suspects = self.suspects.clone();
                self.narrow(suspects, 2);
            }
            Stage::Subset(_) if crashed => self.narrow(tested, 2),
            Stage::Subset(index) if index + 1 < self.n => self.stage = Stage::Subset(index + 1),
            // with two parts the complements are the parts again
            Stage::Subset(_) if self.n == 2 => self.refine(),
            Stage::Subset(_) => self.stage = Stage::Complement(0),
            Stage::Complement(_) if crashed => {
                let n = self.n.saturating_sub(1).max(2);
                self.narrow(tested, n);
            }
            Stage::Complement(index) if index + 1 < self.n => self.stage = Stage::Complement(index + 1),
            Stage::Complement(_) => self.refine(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // runs the search against a crash rule, returns the verdict and how many starts it took
    fn run(count: usize, crashes: impl Fn(&[usize]) -> bool) -> (Verdict, usize) {
        let mut search = Ddmin::new(count);
        let mut starts = 0;
        while let Some(active) = search.next() {
            starts += 1;
            search.report(crashes(&active));
            assert!(starts < 100, "no verdict");
        }
        (search.verdict.unwrap(), starts)
    }

    #[test]
    fn finds_one_culprit() {
        for culprit in 0..9 {
            let (verdict, starts) = run(9, |active| active.contains(&culprit));
            assert_eq!(verdict, Verdict::Culprit(vec![culprit]));
            // the baseline, then at most two starts per halving
            assert!(starts <= 9, "{starts} starts for {culprit}");
        }
    }

    #[test]
    fn finds_a_pair_that_only_crashes_together() {
        let (verdict, _) = run(8, |active| active.contains(&2) && active.contains(&6));
        assert_eq!(verdict, Verdict::Culprit(vec![2, 6]));
    }

    #[test]
    fn baseline_crash_means_not_the_setup() {
        assert_eq!(run(5, |_| true), (Verdict::NotTheSetup, 1));
        assert_eq!(Ddmin::new(0).verdict, Some(Verdict::NotTheSetup));
    }

    #[test]
    fn single_suspect_needs_only_the_baseline() {
        assert_eq!(run(1, |active| !active.is_empty()), (Verdict::Culprit(vec![0]), 1));
    }

    #[test]
    fn survives_a_round_trip_through_json() {
        let mut search = Ddmin::new(4);
        search.report(false);
        let text = serde_json::to_string(&search).unwrap();
        let back: Ddmin = serde_json::from_str(&text).unwrap();
        assert_eq!(back.next(), search.next());
    }
}

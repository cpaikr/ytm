//! Pull the core's bounded metadata snapshot on the retrieval task itself.
use std::{future::Future, io::Write, time::Duration};
use ytm_core::{RetrievalProgress, RetrievalStatistics};

pub(super) async fn observe<T>(
    future: impl Future<Output = T>,
    progress: RetrievalProgress,
    detailed: bool,
) -> T {
    tokio::pin!(future);
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            result = &mut future => {
                if detailed {
                    if let Some(statistics) = progress.snapshot() { emit(&statistics, true); }
                }
                return result;
            }
            _ = interval.tick() => {
                if let Some(statistics) = progress.snapshot() { emit(&statistics, detailed); }
            }
        }
    }
}

fn emit(statistics: &RetrievalStatistics, detailed: bool) {
    // Diagnostic output is best-effort, like the existing terminal display.
    // It never changes the structured stdout result or runs caller callbacks.
    if detailed {
        if let Ok(encoded) = serde_json::to_string(statistics) {
            let _ = writeln!(std::io::stderr(), "YTM retrieval: {encoded}");
        }
    } else {
        let _ = writeln!(std::io::stderr(), "YTM history: {} dated discoveries, {} date/category fetches started (including fallback).", statistics.discovery_count, statistics.matrix_lookup_count);
    }
}

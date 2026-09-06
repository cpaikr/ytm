//! Suppress panic diagnostics only while this binding owns the current poll.
//! The chained process hook retains its behavior for unrelated Rust extensions.
use std::{
    any::Any,
    cell::Cell,
    future::Future,
    panic::{self, AssertUnwindSafe, UnwindSafe},
    sync::Once,
};

use futures_util::{future::poll_fn, FutureExt};

thread_local! {
    static CONTAINED: Cell<bool> = const { Cell::new(false) };
}

pub(crate) fn install() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            if !CONTAINED.with(Cell::get) {
                previous(info);
            }
        }));
    });
}

struct Scope(bool);

impl Scope {
    fn enter() -> Self {
        Self(CONTAINED.with(|value| value.replace(true)))
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        CONTAINED.with(|value| value.set(self.0));
    }
}

pub(crate) fn catch<T>(
    operation: impl FnOnce() -> T + UnwindSafe,
) -> Result<T, Box<dyn Any + Send>> {
    let _scope = Scope::enter();
    panic::catch_unwind(operation)
}

pub(crate) async fn catch_future<F: Future>(future: F) -> Result<F::Output, Box<dyn Any + Send>> {
    let future = AssertUnwindSafe(future).catch_unwind();
    tokio::pin!(future);
    poll_fn(|context| {
        // Never retain thread-local state across an await or a task migration.
        let _scope = Scope::enter();
        future.as_mut().poll(context)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        task::{Context, Poll},
    };

    #[test]
    fn containment_is_scoped_to_each_poll_and_chains_unrelated_panics() {
        let original = panic::take_hook();
        let observed = Arc::new(AtomicUsize::new(0));
        let counter = observed.clone();
        panic::set_hook(Box::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        install();
        assert!(catch(|| panic!("sync private payload")).is_err());
        let mut first = true;
        let mut future = Box::pin(catch_future(poll_fn(|_| {
            assert!(CONTAINED.with(Cell::get));
            if first {
                first = false;
                Poll::<()>::Pending
            } else {
                panic!("async private payload");
            }
        })));
        let mut context = Context::from_waker(futures_util::task::noop_waker_ref());
        assert!(future.as_mut().poll(&mut context).is_pending());
        assert!(!CONTAINED.with(Cell::get));
        assert!(matches!(
            future.as_mut().poll(&mut context),
            Poll::Ready(Err(_))
        ));
        assert!(!CONTAINED.with(Cell::get));
        assert_eq!(observed.load(Ordering::SeqCst), 0);
        assert!(panic::catch_unwind(|| panic!("unrelated diagnostic")).is_err());
        assert_eq!(observed.load(Ordering::SeqCst), 1);
        panic::set_hook(original);
    }
}

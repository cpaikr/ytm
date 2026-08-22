#![doc = include_str!("../README.md")]

#[cfg(all(feature = "judge-fixtures", not(debug_assertions)))]
compile_error!("the judge-fixtures transport cannot be compiled into a release artifact");

mod error;
mod model;
mod nexacro;
mod request;
mod service;
mod transport;

#[cfg(feature = "judge-fixtures")]
pub mod judge;

pub use error::{ErrorDetails, YtmError};
pub use model::{
    BaseDate, Capabilities, DateResolution, FallbackMode, FallbackPolicy, InputError, Kind,
    KindSelector, KindsInput, KindsResult, LookbackDays, MatrixInput, MatrixResult, MatrixRow,
    SourceMetadata, SourceParameters, SourceRequest, DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS,
};
pub use service::YtmService;
pub use tokio_util::sync::CancellationToken;
pub use transport::{HttpTransport, PreparedRequest, Transport};

pub type YtmClient = YtmService;

pub const MAX_RESPONSE_BODY_BYTES: usize = 1_048_576;
pub const MAX_ELEMENT_DEPTH: usize = 64;
pub const REQUEST_DEADLINE_SECONDS: u64 = 20;

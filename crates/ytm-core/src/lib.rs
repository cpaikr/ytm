mod error;
mod model;
mod nexacro;
mod request;
mod service;
mod transport;

#[cfg(feature = "judge-fixtures")]
pub mod judge;

pub use error::{ErrorDetails, YtmError};
pub use model::{Capabilities, Kind, KindsInput, MatrixInput};
pub use service::YtmService;
pub use transport::{HttpTransport, PreparedRequest, Transport};

pub const MAX_RESPONSE_BODY_BYTES: usize = 1_048_576;
pub const MAX_ELEMENT_DEPTH: usize = 64;
pub const REQUEST_DEADLINE_SECONDS: u64 = 20;

use std::fmt;
#[derive(Debug)]
pub struct Error {
    pub code: String,
    pub exit_code: i32,
    pub message: String,
    pub details: Option<serde_json::Value>,
}
impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            exit_code: 1,
            message: message.into(),
            details: None,
        }
    }
}
impl Error {
    pub fn with_exit_code(mut self, code: i32) -> Self {
        self.exit_code = code;
        self
    }
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new("IO_ERROR", e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new("CONFIG_INVALID", e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Error>;
pub mod git;

pub mod cli;

pub mod config;
pub mod status;

pub mod init;

pub mod list;

pub mod operations;

pub mod prune;

pub mod selection;

pub mod managed;

pub mod coordinated;

pub mod paths;

pub mod doctor;

pub mod status_human;

pub mod sync;

pub mod execution;
pub mod process;

mod hooks;

mod materialization;

use std::fmt;
use std::io::{self, Read, Write};

use serde::Serialize;
use serde_json::Value;

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

const HEADER_PREFIX: &[u8] = b"Content-Length: ";
const HEADER_END: &[u8] = b"\r\n\r\n";
const MAX_HEADER_BYTES: usize = 64;

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    InvalidHeader,
    TooLarge,
    Truncated,
    InvalidJson(serde_json::Error),
}

impl fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "frame I/O error: {error}"),
            Self::InvalidHeader => formatter.write_str("invalid Content-Length frame header"),
            Self::TooLarge => formatter.write_str("frame exceeds maximum size"),
            Self::Truncated => formatter.write_str("truncated frame"),
            Self::InvalidJson(error) => write!(formatter, "invalid frame JSON: {error}"),
        }
    }
}

impl std::error::Error for FrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::InvalidJson(error) => Some(error),
            Self::InvalidHeader | Self::TooLarge | Self::Truncated => None,
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for FrameError {
    fn from(error: serde_json::Error) -> Self {
        Self::InvalidJson(error)
    }
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Value>, FrameError> {
    let mut header = Vec::with_capacity(32);
    let mut byte = [0_u8; 1];

    loop {
        match reader.read(&mut byte) {
            Ok(0) if header.is_empty() => return Ok(None),
            Ok(0) => return Err(FrameError::Truncated),
            Ok(_) => {
                let value = byte[0];
                header.push(value);

                if header.len() > MAX_HEADER_BYTES {
                    return Err(FrameError::InvalidHeader);
                }

                let index = header.len() - 1;
                if index < HEADER_PREFIX.len() && value != HEADER_PREFIX[index] {
                    return Err(FrameError::InvalidHeader);
                }
                if value == b'\n' && header.get(index.wrapping_sub(1)) != Some(&b'\r') {
                    return Err(FrameError::InvalidHeader);
                }

                if header.ends_with(HEADER_END) {
                    break;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(FrameError::Io(error)),
        }
    }

    let header_text = std::str::from_utf8(&header).map_err(|_| FrameError::InvalidHeader)?;
    let length_text = header_text
        .strip_prefix("Content-Length: ")
        .and_then(|value| value.strip_suffix("\r\n\r\n"))
        .ok_or(FrameError::InvalidHeader)?;

    if length_text.is_empty()
        || !length_text.bytes().all(|byte| byte.is_ascii_digit())
        || (length_text.len() > 1 && length_text.starts_with('0'))
    {
        return Err(FrameError::InvalidHeader);
    }

    let declared = length_text
        .parse::<u64>()
        .map_err(|_| FrameError::InvalidHeader)?;
    if declared > MAX_FRAME_BYTES as u64 {
        return Err(FrameError::TooLarge);
    }

    let length = usize::try_from(declared).map_err(|_| FrameError::TooLarge)?;
    let mut body = vec![0_u8; length];
    if let Err(error) = reader.read_exact(&mut body) {
        return if error.kind() == io::ErrorKind::UnexpectedEof {
            Err(FrameError::Truncated)
        } else {
            Err(FrameError::Io(error))
        };
    }

    let value = serde_json::from_slice(&body)?;
    Ok(Some(value))
}

pub fn write_frame<W: Write, T: Serialize + ?Sized>(
    writer: &mut W,
    value: &T,
) -> Result<(), FrameError> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }

    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    Ok(())
}

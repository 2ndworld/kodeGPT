mod audit;
mod dispatcher;
mod execution;
mod rpc;
mod spool;

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::thread;

use audit::AuditSink;
#[cfg(feature = "runtime-test-methods")]
use audit::AuditFaults;
use kodegpt_protocol::{read_frame, write_frame};
use tokio::runtime::Builder;
use tokio::sync::mpsc;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(io::stderr().lock(), "kodegpt-runtime: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let test_methods_enabled = test_methods_enabled();
    let state_root = std::env::var_os("KODEGPT_STATE_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| "missing KODEGPT_STATE_ROOT".to_owned())?;
    let audit = Arc::new(create_audit_sink(&state_root));
    let (request_tx, request_rx) = mpsc::unbounded_channel();
    let (response_tx, mut response_rx) = mpsc::unbounded_channel();

    let reader = thread::Builder::new()
        .name("kodegpt-runtime-reader".to_owned())
        .spawn(move || -> Result<(), String> {
            let stdin = io::stdin();
            let mut input = stdin.lock();

            while let Some(request) = read_frame(&mut input).map_err(|error| error.to_string())? {
                if request_tx.send(request).is_err() {
                    break;
                }
            }
            Ok(())
        })
        .map_err(|error| format!("failed to start protocol reader: {error}"))?;

    let writer = thread::Builder::new()
        .name("kodegpt-runtime-writer".to_owned())
        .spawn(move || -> Result<(), String> {
            let stdout = io::stdout();
            let mut output = stdout.lock();

            while let Some(response) = response_rx.blocking_recv() {
                write_frame(&mut output, &response).map_err(|error| error.to_string())?;
                output.flush().map_err(|error| error.to_string())?;
            }
            Ok(())
        })
        .map_err(|error| format!("failed to start protocol writer: {error}"))?;

    let runtime = Builder::new_multi_thread()
        .enable_time()
        .build()
        .map_err(|error| format!("failed to initialize async runtime: {error}"))?;

    runtime.block_on(dispatcher::run_dispatcher(
        request_rx,
        response_tx,
        test_methods_enabled,
        audit,
    ));
    drop(runtime);

    reader
        .join()
        .map_err(|_| "protocol reader thread panicked".to_owned())??;
    writer
        .join()
        .map_err(|_| "protocol writer thread panicked".to_owned())??;

    Ok(())
}

fn create_audit_sink(state_root: &Path) -> AuditSink {
    #[cfg(feature = "runtime-test-methods")]
    {
        return AuditSink::open_with_faults(
            state_root,
            AuditFaults {
                fail_next_decision: test_env_flag("KODEGPT_RUNTIME_TEST_AUDIT_FAIL_DECISION"),
                fail_next_outcome: test_env_flag("KODEGPT_RUNTIME_TEST_AUDIT_FAIL_OUTCOME"),
            },
        );
    }

    #[cfg(not(feature = "runtime-test-methods"))]
    {
        AuditSink::open(state_root)
    }
}

fn test_methods_enabled() -> bool {
    if !cfg!(feature = "runtime-test-methods") {
        return false;
    }

    matches!(
        std::env::var("KODEGPT_RUNTIME_TEST_METHODS").as_deref(),
        Ok("1")
    )
}

#[cfg(feature = "runtime-test-methods")]
fn test_env_flag(name: &str) -> bool {
    matches!(std::env::var(name).as_deref(), Ok("1"))
}

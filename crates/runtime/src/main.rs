mod dispatcher;
mod rpc;

use std::io::{self, Write};
use std::process::ExitCode;
use std::thread;

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

fn test_methods_enabled() -> bool {
    if !cfg!(feature = "runtime-test-methods") {
        return false;
    }

    matches!(
        std::env::var("KODEGPT_RUNTIME_TEST_METHODS").as_deref(),
        Ok("1")
    )
}

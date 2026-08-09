use std::io::{self, Write};

use kodegpt_protocol::{read_frame, write_frame};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    while let Some(value) = read_frame(&mut reader)? {
        write_frame(&mut writer, &value)?;
        writer.flush()?;
    }

    Ok(())
}

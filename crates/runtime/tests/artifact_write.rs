use std::fs;
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use kodegpt_protocol::{read_frame, write_frame};
use serde_json::{Value, json};

fn state_root() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "kodegpt-artifact-write-it-{}-{nonce}",
        std::process::id()
    ))
}

fn rpc(stdin: &mut impl Write, stdout: &mut impl std::io::Read, value: Value) -> Value {
    write_frame(stdin, &value).expect("request frame written");
    stdin.flush().expect("request flushed");
    read_frame(stdout)
        .expect("response frame readable")
        .expect("response present")
}

fn audit_text(root: &Path) -> String {
    let mut combined = String::new();
    let security = root.join("logs/security");
    if let Ok(entries) = fs::read_dir(security) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                if let Ok(text) = fs::read_to_string(path) {
                    combined.push_str(&text);
                }
            }
        }
    }
    combined
}

#[test]
fn private_artifact_write_round_trips_binary_bytes_without_widening_protocol() {
    let root = state_root();
    fs::create_dir_all(&root).expect("state root created");
    let mut child = Command::new(env!("CARGO_BIN_EXE_kodegpt-runtime"))
        .env_clear()
        .env("KODEGPT_STATE_ROOT", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("runtime starts");
    let mut stdin = child.stdin.take().expect("runtime stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("runtime stdout"));

    let written = rpc(
        &mut stdin,
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": "req_artifact_write_it",
            "method": "artifact.write",
            "params": { "mediaType": "image/png", "dataBase64": "AAEC/w==" }
        }),
    );
    assert_eq!(written["result"]["schemaVersion"], 1);
    assert_eq!(written["result"]["mediaType"], "image/png");
    assert_eq!(written["result"]["bytesWritten"], 4);
    let artifact_id = written["result"]["artifactId"]
        .as_str()
        .expect("artifact id returned")
        .to_owned();
    assert!(artifact_id.starts_with("ka_"));
    assert!(!written.to_string().contains("/home/"));

    let read = rpc(
        &mut stdin,
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": "req_artifact_read_it",
            "method": "artifact.read",
            "params": { "artifactId": artifact_id, "offset": 0, "maxBytes": 16 }
        }),
    );
    assert_eq!(read["result"]["dataBase64"], "AAEC/w==");
    assert_eq!(read["result"]["bytesRead"], 4);
    assert_eq!(read["result"]["eof"], true);

    let rejected = rpc(
        &mut stdin,
        &mut stdout,
        json!({
            "jsonrpc": "2.0",
            "id": "req_artifact_bad_it",
            "method": "artifact.write",
            "params": { "mediaType": "image/png", "dataBase64": "!!!!" }
        }),
    );
    assert_eq!(rejected["error"]["message"], "INVALID_PARAMS");

    drop(stdin);
    let status = child.wait().expect("runtime exits");
    assert!(status.success());
    let audit = audit_text(&root);
    assert!(audit.contains("artifact_spool_create"));
    assert!(!audit.contains("AAEC/w=="));
    fs::remove_dir_all(root).expect("state root removed");
}

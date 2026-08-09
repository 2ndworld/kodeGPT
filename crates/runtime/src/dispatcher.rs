use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::rpc::{error_response, parse_request, success_response};

#[cfg(feature = "runtime-test-methods")]
use serde::Deserialize;

#[cfg(feature = "runtime-test-methods")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SleepParams {
    delay_ms: u64,
}

#[cfg(feature = "runtime-test-methods")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EchoAfterParams {
    value: Value,
    delay_ms: u64,
}

pub async fn run_dispatcher(
    mut requests: mpsc::UnboundedReceiver<Value>,
    responses: mpsc::UnboundedSender<Value>,
    test_methods_enabled: bool,
) {
    let mut tasks = JoinSet::new();

    while let Some(value) = requests.recv().await {
        let response_tx = responses.clone();
        tasks.spawn(async move {
            let response = dispatch_one(value, test_methods_enabled).await;
            let _ = response_tx.send(response);
        });
    }

    while tasks.join_next().await.is_some() {}
}

async fn dispatch_one(value: Value, test_methods_enabled: bool) -> Value {
    let request = match parse_request(value) {
        Ok(request) => request,
        Err(response) => return response,
    };

    match request.method.as_str() {
        "runtime.hello" => {
            if request.params.as_object().is_none_or(|params| !params.is_empty()) {
                return error_response(Some(request.id), -32602, "INVALID_PARAMS");
            }

            success_response(
                request.id,
                json!({
                    "runtimeVersion": "0.1",
                    "testMethods": cfg!(feature = "runtime-test-methods") && test_methods_enabled
                }),
            )
        }
        #[cfg(feature = "runtime-test-methods")]
        "test.sleep" if test_methods_enabled => {
            let params = match serde_json::from_value::<SleepParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            tokio::time::sleep(std::time::Duration::from_millis(params.delay_ms)).await;
            success_response(request.id, json!({ "sleptMs": params.delay_ms }))
        }
        #[cfg(feature = "runtime-test-methods")]
        "test.echo_after" if test_methods_enabled => {
            let params = match serde_json::from_value::<EchoAfterParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            tokio::time::sleep(std::time::Duration::from_millis(params.delay_ms)).await;
            success_response(request.id, json!({ "value": params.value }))
        }
        _ => error_response(Some(request.id), -32601, "METHOD_NOT_FOUND"),
    }
}

#[cfg(all(test, feature = "runtime-test-methods"))]
mod tests {
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use super::run_dispatcher;

    fn request(id: &str, method: &str, params: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatcher_keeps_runtime_hello_responsive_while_sleep_is_pending() {
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(request_rx, response_tx, true));

        request_tx
            .send(request("req_sleep", "test.sleep", json!({ "delayMs": 500 })))
            .expect("sleep request accepted");
        let started = Instant::now();
        request_tx
            .send(request("req_hello", "runtime.hello", json!({})))
            .expect("hello request accepted");

        let first = tokio::time::timeout(Duration::from_millis(200), response_rx.recv())
            .await
            .expect("hello must complete within 200 ms")
            .expect("response channel open");
        assert_eq!(first["id"], "req_hello");
        assert!(started.elapsed() < Duration::from_millis(200));

        let second = tokio::time::timeout(Duration::from_millis(700), response_rx.recv())
            .await
            .expect("sleep eventually completes")
            .expect("response channel open");
        assert_eq!(second["id"], "req_sleep");

        drop(request_tx);
        dispatcher.await.expect("dispatcher task joins");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatcher_correlates_out_of_order_test_responses_by_id() {
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(request_rx, response_tx, true));

        for (id, value, delay_ms) in [
            ("req_a", "A", 120_u64),
            ("req_b", "B", 10_u64),
            ("req_c", "C", 60_u64),
        ] {
            request_tx
                .send(request(
                    id,
                    "test.echo_after",
                    json!({ "value": value, "delayMs": delay_ms }),
                ))
                .expect("request accepted");
        }

        let mut seen = Vec::new();
        for _ in 0..3 {
            let response = tokio::time::timeout(Duration::from_millis(300), response_rx.recv())
                .await
                .expect("response arrives")
                .expect("response channel open");
            seen.push((
                response["id"].as_str().expect("id string").to_owned(),
                response["result"]["value"]
                    .as_str()
                    .expect("echo value")
                    .to_owned(),
            ));
        }

        assert_eq!(
            seen,
            vec![
                ("req_b".to_owned(), "B".to_owned()),
                ("req_c".to_owned(), "C".to_owned()),
                ("req_a".to_owned(), "A".to_owned()),
            ]
        );

        drop(request_tx);
        dispatcher.await.expect("dispatcher task joins");
    }
}

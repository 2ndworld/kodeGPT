use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: String,
    pub method: String,
    pub params: Value,
}

pub fn parse_request(value: Value) -> Result<RpcRequest, Value> {
    let fallback_id = value
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    let request = serde_json::from_value::<RpcRequest>(value)
        .map_err(|_| error_response(fallback_id, -32600, "INVALID_REQUEST"))?;

    if request.jsonrpc != "2.0" {
        return Err(error_response(Some(request.id), -32600, "INVALID_REQUEST"));
    }

    Ok(request)
}

pub fn success_response(id: String, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

pub fn error_response(id: Option<String>, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

pub fn error_response_with_data_code(
    id: Option<String>,
    code: i64,
    message: &str,
    data_code: &str,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
            "data": {
                "code": data_code
            }
        }
    })
}

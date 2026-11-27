//! OpenRouter speech to text (legacy `openrouterTranscription.ts`).
//!
//! The client uploads a Whisper-style multipart form; OpenRouter's dedicated
//! endpoint takes JSON with a base64 `input_audio`. This module parses the
//! form and builds that JSON, so the request then travels the ordinary proxy
//! path (key policy, model routing, provider credentials).

use base64::Engine;
use serde_json::{json, Map, Value};

/// A parsed multipart form: text fields and the uploaded files.
#[derive(Default)]
pub(crate) struct Form {
    fields: Vec<(String, String)>,
    files: Vec<UploadedFile>,
}

pub(crate) struct UploadedFile {
    name: String,
    file_name: Option<String>,
    content_type: Option<String>,
    bytes: Vec<u8>,
}

impl Form {
    fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn all(&self, name: &str) -> Vec<&str> {
        self.fields
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
            .collect()
    }

    fn file(&self, name: &str) -> Option<&UploadedFile> {
        self.files.iter().find(|file| file.name == name)
    }
}

/// The multipart boundary of a `Content-Type` header value.
pub(crate) fn boundary(content_type: &str) -> Option<String> {
    let mut parts = content_type.split(';');
    if !parts
        .next()?
        .trim()
        .eq_ignore_ascii_case("multipart/form-data")
    {
        return None;
    }
    parts.find_map(|part| {
        let (key, value) = part.split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case("boundary")
            .then(|| value.trim().trim_matches('"').to_owned())
            .filter(|value| !value.is_empty() && value.len() <= 200)
    })
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|position| position + from)
}

fn header_parameter(header: &str, parameter: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();
    let marker = format!("{parameter}=");
    let mut search = 0;
    while let Some(position) = lower[search..].find(&marker) {
        let start = search + position;
        // `name=` must start a parameter, not end `filename=`.
        let boundary_ok = start == 0 || matches!(lower.as_bytes()[start - 1], b';' | b' ' | b'\t');
        let value = &header[start + marker.len()..];
        if boundary_ok {
            return Some(match value.strip_prefix('"') {
                Some(quoted) => quoted.split('"').next().unwrap_or_default().to_owned(),
                None => value
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
            });
        }
        search = start + marker.len();
    }
    None
}

/// Parses a `multipart/form-data` body.
pub(crate) fn parse_form(body: &[u8], boundary: &str) -> Result<Form, &'static str> {
    let delimiter = format!("--{boundary}").into_bytes();
    let mut form = Form::default();
    let mut cursor = find(body, &delimiter, 0).ok_or("Invalid multipart body")?;
    loop {
        cursor += delimiter.len();
        // `--` after a delimiter closes the form.
        if body[cursor..].starts_with(b"--") {
            return Ok(form);
        }
        if !body[cursor..].starts_with(b"\r\n") {
            return Err("Invalid multipart body");
        }
        cursor += 2;
        let headers_end = find(body, b"\r\n\r\n", cursor).ok_or("Invalid multipart body")?;
        let headers = std::str::from_utf8(&body[cursor..headers_end])
            .map_err(|_| "Invalid multipart body")?;
        let content_start = headers_end + 4;
        let next = find(
            body,
            &[b"\r\n".as_slice(), &delimiter].concat(),
            content_start,
        )
        .ok_or("Invalid multipart body")?;
        let content = &body[content_start..next];
        let mut disposition = None;
        let mut content_type = None;
        for line in headers.split("\r\n") {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            match key.trim().to_ascii_lowercase().as_str() {
                "content-disposition" => disposition = Some(value.trim().to_owned()),
                "content-type" => content_type = Some(value.trim().to_owned()),
                _ => {}
            }
        }
        let disposition = disposition.ok_or("Invalid multipart body")?;
        let name = header_parameter(&disposition, "name").ok_or("Invalid multipart body")?;
        match header_parameter(&disposition, "filename") {
            Some(file_name) => form.files.push(UploadedFile {
                name,
                file_name: Some(file_name),
                content_type,
                bytes: content.to_vec(),
            }),
            None => form.fields.push((
                name,
                String::from_utf8(content.to_vec()).map_err(|_| "Invalid multipart body")?,
            )),
        }
        cursor = next + 2;
    }
}

/// Legacy `resolveOpenRouterAudioFormat`: the container format from the file
/// extension first, then the MIME type; `wav` when neither is recognisable.
pub(crate) fn audio_format(file_name: Option<&str>, content_type: Option<&str>) -> &'static str {
    let extension = file_name
        .map(str::to_lowercase)
        .and_then(|name| {
            name.rsplit_once('.')
                .map(|(_, extension)| extension.to_owned())
        })
        .unwrap_or_default();
    // `.opus` is Ogg-encapsulated Opus (RFC 7845).
    match extension.as_str() {
        "opus" => return "ogg",
        "wav" => return "wav",
        "mp3" => return "mp3",
        "flac" => return "flac",
        "m4a" => return "m4a",
        "ogg" => return "ogg",
        "webm" => return "webm",
        "aac" => return "aac",
        _ => {}
    }
    let mime = content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    match mime.as_str() {
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/mp4" => "m4a",
        "audio/ogg" | "audio/opus" => "ogg",
        "audio/webm" => "webm",
        "audio/aac" => "aac",
        _ => "wav",
    }
}

/// Legacy handler front: `model` and `file` are required; the JSON body carries
/// `input_audio` and the optional language, response format, numeric
/// temperature and timestamp granularities.
pub(crate) fn json_body(form: &Form) -> Result<Vec<u8>, &'static str> {
    let model = form
        .field("model")
        .filter(|model| !model.is_empty())
        .ok_or("model is required")?;
    let file = form.file("file").ok_or("file is required")?;
    let mut body = Map::new();
    body.insert("model".to_owned(), json!(model));
    body.insert(
        "input_audio".to_owned(),
        json!({
            "data": base64::engine::general_purpose::STANDARD.encode(&file.bytes),
            "format": audio_format(file.file_name.as_deref(), file.content_type.as_deref()),
        }),
    );
    for field in ["language", "response_format"] {
        if let Some(value) = form.field(field) {
            body.insert(field.to_owned(), json!(value));
        }
    }
    // `Number.parseFloat`: a leading number counts, anything else is dropped.
    if let Some(temperature) = form.field("temperature").and_then(leading_float) {
        body.insert("temperature".to_owned(), json!(temperature));
    }
    let granularities = form.all("timestamp_granularities[]");
    if !granularities.is_empty() {
        body.insert("timestamp_granularities".to_owned(), json!(granularities));
    }
    serde_json::to_vec(&Value::Object(body)).map_err(|_| "Invalid multipart body")
}

fn leading_float(text: &str) -> Option<f64> {
    let text = text.trim_start();
    let mut end = 0;
    let mut seen_dot = false;
    for (index, byte) in text.bytes().enumerate() {
        let accepted = byte.is_ascii_digit()
            || (index == 0 && matches!(byte, b'-' | b'+'))
            || (byte == b'.' && !seen_dot);
        if !accepted {
            break;
        }
        seen_dot |= byte == b'.';
        end = index + 1;
    }
    text[..end]
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    type Part<'a> = (&'a str, Option<&'a str>, Option<&'a str>, &'a [u8]);

    fn form_body(boundary: &str, parts: &[Part]) -> Vec<u8> {
        let mut body = Vec::new();
        for (name, file_name, content_type, content) in parts {
            body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
            let mut disposition = format!("Content-Disposition: form-data; name=\"{name}\"");
            if let Some(file_name) = file_name {
                disposition.push_str(&format!("; filename=\"{file_name}\""));
            }
            body.extend_from_slice(format!("{disposition}\r\n").as_bytes());
            if let Some(content_type) = content_type {
                body.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
            }
            body.extend_from_slice(b"\r\n");
            body.extend_from_slice(content);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        body
    }

    #[test]
    fn the_boundary_comes_from_a_multipart_content_type() {
        assert_eq!(
            boundary("multipart/form-data; boundary=abc123").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            boundary("Multipart/Form-Data; charset=x; boundary=\"q-1\"").as_deref(),
            Some("q-1")
        );
        assert_eq!(boundary("application/json"), None);
        assert_eq!(boundary("multipart/form-data"), None);
    }

    #[test]
    fn a_form_becomes_the_openrouter_json_body() {
        let audio: &[u8] = b"RIFF\r\n--not-a-boundary\r\n\x00\xff";
        let body = form_body(
            "XyZ",
            &[
                ("model", None, None, b"openrouter/openai/whisper-1"),
                ("language", None, None, b"pt"),
                ("temperature", None, None, b"0.2abc"),
                ("timestamp_granularities[]", None, None, b"word"),
                ("timestamp_granularities[]", None, None, b"segment"),
                ("file", Some("voice.OPUS"), Some("audio/wav"), audio),
            ],
        );
        let form = parse_form(&body, "XyZ").unwrap();
        let json: Value = serde_json::from_slice(&json_body(&form).unwrap()).unwrap();
        assert_eq!(
            json,
            json!({
                "model":"openrouter/openai/whisper-1",
                "input_audio":{
                    "data": base64::engine::general_purpose::STANDARD.encode(audio),
                    "format":"ogg"
                },
                "language":"pt","temperature":0.2,
                "timestamp_granularities":["word","segment"]
            })
        );
    }

    #[test]
    fn model_and_file_are_required() {
        let no_file = form_body("b", &[("model", None, None, b"m")]);
        assert_eq!(
            json_body(&parse_form(&no_file, "b").unwrap()).unwrap_err(),
            "file is required"
        );
        let no_model = form_body("b", &[("file", Some("a.mp3"), None, b"x")]);
        assert_eq!(
            json_body(&parse_form(&no_model, "b").unwrap()).unwrap_err(),
            "model is required"
        );
        let blank = form_body(
            "b",
            &[
                ("model", None, None, b""),
                ("file", Some("a.mp3"), None, b"x"),
            ],
        );
        assert_eq!(
            json_body(&parse_form(&blank, "b").unwrap()).unwrap_err(),
            "model is required"
        );
        assert!(parse_form(b"not multipart", "b").is_err());
        assert!(parse_form(b"--b\r\nbroken", "b").is_err());
    }

    #[test]
    fn the_format_follows_the_extension_then_the_mime_type() {
        assert_eq!(audio_format(Some("a.MP3"), None), "mp3");
        assert_eq!(audio_format(Some("a.opus"), None), "ogg");
        assert_eq!(audio_format(Some("noext"), Some("audio/mpeg")), "mp3");
        assert_eq!(audio_format(None, Some("audio/webm;codecs=opus")), "webm");
        assert_eq!(audio_format(Some("a.xyz"), Some("audio/x-flac")), "flac");
        assert_eq!(audio_format(Some("a.xyz"), Some("text/plain")), "wav");
        assert_eq!(audio_format(None, None), "wav");
    }

    #[test]
    fn temperature_reads_a_leading_number() {
        assert_eq!(leading_float("0.5"), Some(0.5));
        assert_eq!(leading_float(" -1.5x"), Some(-1.5));
        assert_eq!(leading_float("1.2.3"), Some(1.2));
        assert_eq!(leading_float("abc"), None);
        assert_eq!(leading_float(""), None);
    }
}

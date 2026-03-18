use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::{
  fs,
  path::{Path, PathBuf},
  time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfFlags {
  encrypted: bool,
  signed: bool,
  has_forms: bool,
  has_xfa: bool,
  has_javascript: bool,
  has_attachments: bool,
  tagged: bool,
  linearized: bool,
  likely_scanned: bool,
  mixed_content: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPdf {
  path: Option<String>,
  file_name: String,
  size: usize,
  version: String,
  bytes_base64: String,
  flags: PdfFlags,
}

#[tauri::command]
pub fn load_pdf(path: String) -> Result<LoadedPdf, String> {
  let path_buf = PathBuf::from(&path);
  let bytes = fs::read(&path_buf)
    .map_err(|error| format!("Failed to read PDF at {}: {error}", path_buf.display()))?;

  Ok(build_loaded_pdf(Some(path_buf), None, bytes))
}

#[tauri::command]
pub fn inspect_pdf_bytes(
  file_name: Option<String>,
  bytes_base64: String,
) -> Result<LoadedPdf, String> {
  let bytes = STANDARD
    .decode(bytes_base64)
    .map_err(|error| format!("Failed to decode document bytes: {error}"))?;

  Ok(build_loaded_pdf(None, file_name, bytes))
}

#[tauri::command]
pub fn save_file_bytes(path: String, bytes_base64: String) -> Result<(), String> {
  let target_path = PathBuf::from(&path);
  let bytes = STANDARD
    .decode(bytes_base64)
    .map_err(|error| format!("Failed to decode document bytes: {error}"))?;

  if let Some(parent) = target_path.parent() {
    fs::create_dir_all(parent).map_err(|error| {
      format!(
        "Failed to create output directory {}: {error}",
        parent.display()
      )
    })?;
  }

  let staging_path = build_staging_path(&target_path);
  fs::write(&staging_path, &bytes).map_err(|error| {
    format!(
      "Failed to write staged output {}: {error}",
      staging_path.display()
    )
  })?;

  fs::copy(&staging_path, &target_path).map_err(|error| {
    format!(
      "Failed to write output file {}: {error}",
      target_path.display()
    )
  })?;

  fs::remove_file(&staging_path).map_err(|error| {
    format!(
      "Failed to clean staging file {}: {error}",
      staging_path.display()
    )
  })?;

  Ok(())
}

fn build_loaded_pdf(
  path: Option<PathBuf>,
  file_name_override: Option<String>,
  bytes: Vec<u8>,
) -> LoadedPdf {
  let file_name = file_name_override.unwrap_or_else(|| {
    path
      .as_ref()
      .and_then(|candidate| candidate.file_name())
      .and_then(|candidate| candidate.to_str())
      .unwrap_or("document.pdf")
      .to_string()
  });

  LoadedPdf {
    path: path.map(|value| value.to_string_lossy().to_string()),
    file_name,
    size: bytes.len(),
    version: extract_pdf_version(&bytes),
    bytes_base64: STANDARD.encode(&bytes),
    flags: classify_pdf(&bytes),
  }
}

fn extract_pdf_version(bytes: &[u8]) -> String {
  let header = bytes
    .iter()
    .take(32)
    .copied()
    .collect::<Vec<_>>();
  let header = String::from_utf8_lossy(&header);

  if let Some(version) = header.strip_prefix("%PDF-") {
    return version
      .chars()
      .take_while(|value| value.is_ascii_digit() || *value == '.')
      .collect::<String>();
  }

  "unknown".to_string()
}

fn classify_pdf(bytes: &[u8]) -> PdfFlags {
  let text = String::from_utf8_lossy(bytes);
  let image_count = count_occurrences(&text, &["/Subtype /Image", "/Image", "/ImageB"]);
  let font_count = count_occurrences(&text, &["/Font", "/CIDFont"]);
  let text_op_count = count_occurrences(&text, &["\nBT", "\rBT", " BT", "\tBT"]);
  let page_count = count_occurrences(&text, &["/Type /Page"]);

  PdfFlags {
    encrypted: contains_any(&text, &["/Encrypt"]),
    signed: contains_any(&text, &["/ByteRange", "/Sig", "/DocMDP"]),
    has_forms: contains_any(&text, &["/AcroForm"]),
    has_xfa: contains_any(&text, &["/XFA"]),
    has_javascript: contains_any(&text, &["/JavaScript", "/JS"]),
    has_attachments: contains_any(&text, &["/EmbeddedFiles", "/Filespec", "/Collection"]),
    tagged: contains_any(&text, &["/StructTreeRoot", "/MarkInfo"]),
    linearized: contains_any(&text, &["/Linearized"]),
    likely_scanned: image_count > 0 && font_count < page_count.saturating_div(2) && text_op_count < 4,
    mixed_content: image_count > 0 && (font_count > 0 || text_op_count > 2),
  }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
  needles.iter().any(|needle| text.contains(needle))
}

fn count_occurrences(text: &str, needles: &[&str]) -> usize {
  needles
    .iter()
    .map(|needle| text.match_indices(needle).count())
    .sum()
}

fn build_staging_path(target: &Path) -> PathBuf {
  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis())
    .unwrap_or_default();

  let stem = target
    .file_stem()
    .and_then(|value| value.to_str())
    .unwrap_or("document");
  let extension = target.extension().and_then(|value| value.to_str()).unwrap_or("");
  let staged_name = if extension.is_empty() {
    format!("{stem}.sampadan.{timestamp}.tmp")
  } else {
    format!("{stem}.sampadan.{timestamp}.{extension}.tmp")
  };

  target.with_file_name(staged_name)
}

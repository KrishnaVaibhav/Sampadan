use crate::{
  ocr,
  pdf_inspect::{self, PdfFlags, PdfTrustReport},
  qpdf,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::{
  fs,
  path::{Path, PathBuf},
  time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPdf {
  path: Option<String>,
  file_name: String,
  size: usize,
  version: String,
  bytes_base64: String,
  flags: PdfFlags,
  trust_report: PdfTrustReport,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPdfResult {
  language: String,
  bytes_base64: String,
  duration_ms: u128,
  source_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedFileBytes {
  file_name: String,
  bytes_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedPdfAttachment {
  file_name: String,
  description: Option<String>,
  relationship: Option<String>,
  bytes_base64: String,
  notes: Vec<String>,
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
pub fn get_qpdf_status() -> qpdf::QpdfStatus {
  qpdf::probe_qpdf()
}

#[tauri::command]
pub fn protect_pdf_bytes(
  file_name: Option<String>,
  bytes_base64: String,
  options: qpdf::PdfProtectionOptions,
) -> Result<LoadedPdf, String> {
  let bytes = STANDARD
    .decode(bytes_base64)
    .map_err(|error| format!("Failed to decode document bytes: {error}"))?;
  let protected_bytes = qpdf::protect_pdf_bytes(&bytes, &options)?;

  Ok(build_loaded_pdf(None, file_name, protected_bytes))
}

#[tauri::command]
pub fn decrypt_pdf_bytes(
  file_name: Option<String>,
  bytes_base64: String,
  password: Option<String>,
) -> Result<LoadedPdf, String> {
  let bytes = STANDARD
    .decode(bytes_base64)
    .map_err(|error| format!("Failed to decode document bytes: {error}"))?;
  let decrypted_bytes = qpdf::decrypt_pdf_bytes(&bytes, password.as_deref())?;

  Ok(build_loaded_pdf(None, file_name, decrypted_bytes))
}

#[tauri::command]
pub fn load_file_bytes(path: String) -> Result<LoadedFileBytes, String> {
  let path_buf = PathBuf::from(&path);
  let bytes = fs::read(&path_buf)
    .map_err(|error| format!("Failed to read file at {}: {error}", path_buf.display()))?;

  Ok(LoadedFileBytes {
    file_name: path_buf
      .file_name()
      .and_then(|candidate| candidate.to_str())
      .unwrap_or("asset.bin")
      .to_string(),
    bytes_base64: STANDARD.encode(bytes),
  })
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

#[tauri::command]
pub fn extract_pdf_attachments(
  bytes_base64: String,
) -> Result<Vec<ExtractedPdfAttachment>, String> {
  let bytes = STANDARD
    .decode(bytes_base64)
    .map_err(|error| format!("Failed to decode document bytes: {error}"))?;

  let attachments = pdf_inspect::extract_pdf_attachments(&bytes)?;
  Ok(
    attachments
      .into_iter()
      .map(|attachment| ExtractedPdfAttachment {
        file_name: attachment.file_name,
        description: attachment.description,
        relationship: attachment.relationship,
        bytes_base64: STANDARD.encode(attachment.bytes),
        notes: attachment.notes,
      })
      .collect(),
  )
}

#[tauri::command]
pub fn get_ocr_status() -> ocr::OcrStatus {
  ocr::probe_tesseract()
}

#[tauri::command]
pub fn run_ocr_image(
  bytes_base64: String,
  language: Option<String>,
  source_label: Option<String>,
) -> Result<ocr::OcrTextResult, String> {
  let bytes = STANDARD
    .decode(bytes_base64)
    .map_err(|error| format!("Failed to decode OCR image bytes: {error}"))?;

  let resolved_label = source_label.unwrap_or_else(|| "page-preview".to_string());
  ocr::run_ocr_image(&bytes, language.as_deref(), &resolved_label)
}

#[tauri::command]
pub fn run_ocr_pdf(
  bytes_base64: String,
  language: Option<String>,
  source_label: Option<String>,
) -> Result<OcrPdfResult, String> {
  let bytes = STANDARD
    .decode(bytes_base64)
    .map_err(|error| format!("Failed to decode OCR image bytes: {error}"))?;

  let resolved_label = source_label.unwrap_or_else(|| "page-searchable-pdf".to_string());
  let result = ocr::run_ocr_pdf(&bytes, language.as_deref(), &resolved_label)?;

  Ok(OcrPdfResult {
    language: result.language,
    bytes_base64: STANDARD.encode(&result.pdf_bytes),
    duration_ms: result.duration_ms,
    source_label: result.source_label,
  })
}

fn build_loaded_pdf(
  path: Option<PathBuf>,
  file_name_override: Option<String>,
  bytes: Vec<u8>,
) -> LoadedPdf {
  let flags = pdf_inspect::classify_pdf(&bytes);
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
    version: pdf_inspect::extract_pdf_version(&bytes),
    bytes_base64: STANDARD.encode(&bytes),
    trust_report: pdf_inspect::build_trust_report(&bytes, &flags),
    flags,
  }
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

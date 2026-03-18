use serde::Serialize;
use std::{
  env,
  fs,
  path::{Path, PathBuf},
  process::Command,
  time::{Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrStatus {
  pub available: bool,
  pub binary_path: Option<String>,
  pub version: Option<String>,
  pub languages: Vec<String>,
  pub recommended_language: Option<String>,
  pub missing_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTextResult {
  pub language: String,
  pub text: String,
  pub duration_ms: u128,
  pub source_label: String,
}

#[derive(Debug, Clone)]
struct ResolvedTesseract {
  command: PathBuf,
  display_path: String,
  version: String,
}

pub fn probe_tesseract() -> OcrStatus {
  match resolve_tesseract() {
    Ok(tesseract) => {
      let languages = list_languages(&tesseract.command).unwrap_or_default();

      OcrStatus {
        available: true,
        binary_path: Some(tesseract.display_path),
        version: Some(tesseract.version),
        recommended_language: recommend_language(&languages),
        languages,
        missing_reason: None,
      }
    }
    Err(reason) => OcrStatus {
      available: false,
      binary_path: None,
      version: None,
      languages: Vec::new(),
      recommended_language: Some("eng".to_string()),
      missing_reason: Some(reason),
    },
  }
}

pub fn run_ocr_image(
  bytes: &[u8],
  language: Option<&str>,
  source_label: &str,
) -> Result<OcrTextResult, String> {
  let tesseract = resolve_tesseract()?;
  let languages = list_languages(&tesseract.command).unwrap_or_default();
  let selected_language = resolve_language(language, &languages)?;
  let temp_image_path = build_temp_image_path();

  fs::write(&temp_image_path, bytes).map_err(|error| {
    format!(
      "Failed to write OCR input image {}: {error}",
      temp_image_path.display()
    )
  })?;

  let start = Instant::now();
  let output = Command::new(&tesseract.command)
    .arg(&temp_image_path)
    .arg("stdout")
    .arg("-l")
    .arg(&selected_language)
    .arg("--dpi")
    .arg("300")
    .output()
    .map_err(|error| format!("Failed to launch Tesseract: {error}"))?;

  let _ = fs::remove_file(&temp_image_path);

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
      stderr
    } else if !stdout.is_empty() {
      stdout
    } else {
      "Tesseract exited without returning output.".to_string()
    };

    return Err(format!("OCR failed: {detail}"));
  }

  let text = String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n");

  Ok(OcrTextResult {
    language: selected_language,
    text: text.trim().to_string(),
    duration_ms: start.elapsed().as_millis(),
    source_label: source_label.to_string(),
  })
}

fn resolve_tesseract() -> Result<ResolvedTesseract, String> {
  if let Ok(configured_path) = env::var("SAMPADAN_TESSERACT_PATH") {
    let candidate = PathBuf::from(configured_path);
    if let Some(version) = probe_candidate(&candidate) {
      return Ok(ResolvedTesseract {
        display_path: candidate.to_string_lossy().to_string(),
        command: candidate,
        version,
      });
    }
  }

  let path_candidate = PathBuf::from("tesseract");
  if let Some(version) = probe_candidate(&path_candidate) {
    return Ok(ResolvedTesseract {
      command: path_candidate,
      display_path: "tesseract".to_string(),
      version,
    });
  }

  for candidate in common_tesseract_locations() {
    if let Some(version) = probe_candidate(&candidate) {
      return Ok(ResolvedTesseract {
        display_path: candidate.to_string_lossy().to_string(),
        command: candidate,
        version,
      });
    }
  }

  Err(
    "Tesseract is not installed or not reachable. Install it locally or set SAMPADAN_TESSERACT_PATH."
      .to_string(),
  )
}

fn probe_candidate(candidate: &Path) -> Option<String> {
  let output = Command::new(candidate).arg("--version").output().ok()?;
  if !output.status.success() {
    return None;
  }

  let stdout = String::from_utf8_lossy(&output.stdout);
  let first_line = stdout.lines().next()?.trim();
  if first_line.is_empty() {
    return None;
  }

  Some(first_line.to_string())
}

fn list_languages(command: &Path) -> Result<Vec<String>, String> {
  let output = Command::new(command)
    .arg("--list-langs")
    .output()
    .map_err(|error| format!("Failed to list OCR languages: {error}"))?;

  if !output.status.success() {
    return Err(
      String::from_utf8_lossy(&output.stderr)
        .trim()
        .to_string(),
    );
  }

  Ok(parse_languages_output(&String::from_utf8_lossy(&output.stdout)))
}

fn resolve_language(requested: Option<&str>, installed_languages: &[String]) -> Result<String, String> {
  let candidate = requested.unwrap_or("").trim();
  let language = if candidate.is_empty() {
    recommend_language(installed_languages).unwrap_or_else(|| "eng".to_string())
  } else {
    candidate.to_string()
  };

  if installed_languages.is_empty() {
    return Ok(language);
  }

  for part in language.split('+').map(str::trim).filter(|part| !part.is_empty()) {
    if !installed_languages.iter().any(|installed| installed == part) {
      return Err(format!(
        "OCR language \"{part}\" is not installed. Available languages: {}",
        installed_languages.join(", ")
      ));
    }
  }

  Ok(language)
}

fn recommend_language(installed_languages: &[String]) -> Option<String> {
  if installed_languages.iter().any(|language| language == "eng") {
    return Some("eng".to_string());
  }

  installed_languages.first().cloned()
}

fn build_temp_image_path() -> PathBuf {
  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis())
    .unwrap_or_default();
  let process_id = std::process::id();
  env::temp_dir().join(format!("sampadan-ocr-{timestamp}-{process_id}.png"))
}

fn common_tesseract_locations() -> Vec<PathBuf> {
  let mut candidates = Vec::new();

  #[cfg(target_os = "windows")]
  {
    if let Ok(program_files) = env::var("ProgramFiles") {
      candidates.push(PathBuf::from(program_files).join("Tesseract-OCR").join("tesseract.exe"));
    }

    if let Ok(program_files_x86) = env::var("ProgramFiles(x86)") {
      candidates.push(
        PathBuf::from(program_files_x86)
          .join("Tesseract-OCR")
          .join("tesseract.exe"),
      );
    }

    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
      candidates.push(
        PathBuf::from(local_app_data)
          .join("Programs")
          .join("Tesseract-OCR")
          .join("tesseract.exe"),
      );
    }
  }

  #[cfg(target_os = "macos")]
  {
    candidates.push(PathBuf::from("/opt/homebrew/bin/tesseract"));
    candidates.push(PathBuf::from("/usr/local/bin/tesseract"));
    candidates.push(PathBuf::from("/usr/bin/tesseract"));
  }

  #[cfg(target_os = "linux")]
  {
    candidates.push(PathBuf::from("/usr/bin/tesseract"));
    candidates.push(PathBuf::from("/usr/local/bin/tesseract"));
    candidates.push(PathBuf::from("/snap/bin/tesseract"));
  }

  candidates
}

fn parse_languages_output(output: &str) -> Vec<String> {
  let mut languages = output
    .lines()
    .map(str::trim)
    .filter(|line| !line.is_empty() && !line.starts_with("List of available languages"))
    .map(ToOwned::to_owned)
    .collect::<Vec<_>>();

  languages.sort();
  languages.dedup();

  languages
}

#[cfg(test)]
mod tests {
  use super::{parse_languages_output, recommend_language, resolve_language};

  #[test]
  fn parse_languages_output_skips_header_and_deduplicates() {
    let output = r#"
List of available languages in "/tmp/tessdata/" (4):
eng
hin
osd
hin
"#;

    let languages = parse_languages_output(output);

    assert_eq!(languages, vec!["eng", "hin", "osd"]);
  }

  #[test]
  fn recommend_language_prefers_english_when_available() {
    let languages = vec!["hin".to_string(), "eng".to_string(), "osd".to_string()];

    assert_eq!(recommend_language(&languages).as_deref(), Some("eng"));
  }

  #[test]
  fn resolve_language_uses_requested_language_when_installed() {
    let languages = vec!["eng".to_string(), "hin".to_string()];

    let resolved = resolve_language(Some("eng+hin"), &languages).expect("language should resolve");

    assert_eq!(resolved, "eng+hin");
  }

  #[test]
  fn resolve_language_errors_for_missing_language() {
    let languages = vec!["eng".to_string()];

    let error = resolve_language(Some("hin"), &languages).expect_err("language should fail");

    assert!(error.contains("Available languages: eng"));
  }
}

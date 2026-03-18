use serde::{Deserialize, Serialize};
use std::{
  env, fs,
  path::{Path, PathBuf},
  process::{Command, Output},
  sync::atomic::{AtomicU64, Ordering},
  time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QpdfStatus {
  pub available: bool,
  pub binary_path: Option<String>,
  pub version: Option<String>,
  pub missing_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfProtectionOptions {
  pub user_password: Option<String>,
  pub owner_password: String,
  pub print: String,
  pub modify: String,
  pub allow_extract: bool,
  pub encrypt_metadata: bool,
}

#[derive(Debug, Clone)]
struct ResolvedQpdf {
  command: PathBuf,
  display_path: String,
  version: String,
}

#[derive(Debug, Clone)]
struct ValidatedProtectionOptions {
  user_password: Option<String>,
  owner_password: String,
  print: String,
  modify: String,
  allow_extract: bool,
  encrypt_metadata: bool,
}

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn probe_qpdf() -> QpdfStatus {
  match resolve_qpdf() {
    Ok(qpdf) => QpdfStatus {
      available: true,
      binary_path: Some(qpdf.display_path),
      version: Some(qpdf.version),
      missing_reason: None,
    },
    Err(reason) => QpdfStatus {
      available: false,
      binary_path: None,
      version: None,
      missing_reason: Some(reason),
    },
  }
}

pub fn protect_pdf_bytes(bytes: &[u8], options: &PdfProtectionOptions) -> Result<Vec<u8>, String> {
  let options = validate_protection_options(options)?;
  let qpdf = resolve_qpdf()?;
  let stamp = build_temp_stamp();
  let input_path = env::temp_dir().join(format!("sampadan-qpdf-protect-input-{stamp}.pdf"));
  let output_path = env::temp_dir().join(format!("sampadan-qpdf-protect-output-{stamp}.pdf"));

  fs::write(&input_path, bytes).map_err(|error| {
    format!(
      "Failed to stage PDF protection input {}: {error}",
      input_path.display()
    )
  })?;

  let mut command = Command::new(&qpdf.command);
  command.arg("--encrypt");

  if let Some(user_password) = &options.user_password {
    command.arg(format!("--user-password={user_password}"));
  }

  command
    .arg(format!("--owner-password={}", options.owner_password))
    .arg("--bits=256")
    .arg(format!("--print={}", options.print))
    .arg(format!("--modify={}", options.modify))
    .arg(format!(
      "--extract={}",
      if options.allow_extract { "y" } else { "n" }
    ))
    .arg("--accessibility=y");

  if !options.encrypt_metadata {
    command.arg("--cleartext-metadata");
  }

  let output = command
    .arg("--")
    .arg(&input_path)
    .arg(&output_path)
    .output()
    .map_err(|error| {
      remove_if_exists(&input_path);
      format!("Failed to launch qpdf: {error}")
    })?;

  remove_if_exists(&input_path);

  if !output.status.success() {
    remove_if_exists(&output_path);
    return Err(format!(
      "Protected copy generation failed: {}",
      describe_failure(&output)
    ));
  }

  let protected_bytes = fs::read(&output_path).map_err(|error| {
    format!(
      "qpdf generated a protected PDF, but Sampadan could not read {}: {error}",
      output_path.display()
    )
  })?;

  remove_if_exists(&output_path);
  Ok(protected_bytes)
}

pub fn decrypt_pdf_bytes(bytes: &[u8], password: Option<&str>) -> Result<Vec<u8>, String> {
  let qpdf = resolve_qpdf()?;
  let stamp = build_temp_stamp();
  let input_path = env::temp_dir().join(format!("sampadan-qpdf-decrypt-input-{stamp}.pdf"));
  let output_path = env::temp_dir().join(format!("sampadan-qpdf-decrypt-output-{stamp}.pdf"));

  fs::write(&input_path, bytes).map_err(|error| {
    format!(
      "Failed to stage PDF unlock input {}: {error}",
      input_path.display()
    )
  })?;

  let resolved_password = password.unwrap_or_default();
  let output = Command::new(&qpdf.command)
    .arg(format!("--password={resolved_password}"))
    .arg("--decrypt")
    .arg("--")
    .arg(&input_path)
    .arg(&output_path)
    .output()
    .map_err(|error| {
      remove_if_exists(&input_path);
      format!("Failed to launch qpdf: {error}")
    })?;

  remove_if_exists(&input_path);

  if !output.status.success() {
    remove_if_exists(&output_path);
    return Err(format!("PDF unlock failed: {}", describe_failure(&output)));
  }

  let decrypted_bytes = fs::read(&output_path).map_err(|error| {
    format!(
      "qpdf generated an unlocked PDF, but Sampadan could not read {}: {error}",
      output_path.display()
    )
  })?;

  remove_if_exists(&output_path);
  Ok(decrypted_bytes)
}

fn resolve_qpdf() -> Result<ResolvedQpdf, String> {
  if let Ok(configured_path) = env::var("SAMPADAN_QPDF_PATH") {
    let candidate = PathBuf::from(configured_path);
    if let Some(version) = probe_candidate(&candidate) {
      return Ok(ResolvedQpdf {
        command: candidate.clone(),
        display_path: candidate.to_string_lossy().to_string(),
        version,
      });
    }
  }

  let path_candidate = PathBuf::from("qpdf");
  if let Some(version) = probe_candidate(&path_candidate) {
    return Ok(ResolvedQpdf {
      command: path_candidate,
      display_path: "qpdf".to_string(),
      version,
    });
  }

  for candidate in common_qpdf_locations() {
    if let Some(version) = probe_candidate(&candidate) {
      return Ok(ResolvedQpdf {
        command: candidate.clone(),
        display_path: candidate.to_string_lossy().to_string(),
        version,
      });
    }
  }

  Err(
    "qpdf is not installed or not reachable. Install it locally or set SAMPADAN_QPDF_PATH."
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

fn common_qpdf_locations() -> Vec<PathBuf> {
  let mut candidates = Vec::new();

  #[cfg(target_os = "windows")]
  {
    for env_name in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
      if let Ok(base) = env::var(env_name) {
        let base_path = PathBuf::from(base);
        push_unique(&mut candidates, base_path.join("qpdf").join("bin").join("qpdf.exe"));
        push_unique(&mut candidates, base_path.join("QPDF").join("bin").join("qpdf.exe"));

        if let Ok(entries) = fs::read_dir(&base_path) {
          let mut versioned_dirs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
              path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_ascii_lowercase().starts_with("qpdf"))
                .unwrap_or(false)
            })
            .collect();

          versioned_dirs.sort();
          versioned_dirs.reverse();

          for directory in versioned_dirs {
            push_unique(&mut candidates, directory.join("bin").join("qpdf.exe"));
          }
        }
      }
    }
  }

  #[cfg(target_os = "macos")]
  {
    for candidate in ["/opt/homebrew/bin/qpdf", "/usr/local/bin/qpdf", "/usr/bin/qpdf"] {
      push_unique(&mut candidates, PathBuf::from(candidate));
    }
  }

  #[cfg(all(unix, not(target_os = "macos")))]
  {
    for candidate in ["/usr/bin/qpdf", "/usr/local/bin/qpdf", "/snap/bin/qpdf"] {
      push_unique(&mut candidates, PathBuf::from(candidate));
    }
  }

  candidates
}

fn push_unique(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
  if !candidates.iter().any(|existing| existing == &candidate) {
    candidates.push(candidate);
  }
}

fn validate_protection_options(
  options: &PdfProtectionOptions,
) -> Result<ValidatedProtectionOptions, String> {
  let user_password = options
    .user_password
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string);
  let owner_password = options.owner_password.trim().to_string();

  if owner_password.is_empty() {
    return Err("Owner password is required to create a protected PDF copy.".to_string());
  }

  if user_password.as_deref() == Some(owner_password.as_str()) {
    return Err(
      "Use different open and owner passwords. Reusing the same value weakens PDF protection."
        .to_string(),
    );
  }

  let print = match options.print.trim() {
    "none" | "low" | "full" => options.print.trim().to_string(),
    other => {
      return Err(format!(
        "Unsupported print permission \"{other}\". Use none, low, or full."
      ))
    }
  };

  let modify = match options.modify.trim() {
    "none" | "assembly" | "form" | "annotate" | "all" => options.modify.trim().to_string(),
    other => {
      return Err(format!(
        "Unsupported modify permission \"{other}\". Use none, assembly, form, annotate, or all."
      ))
    }
  };

  Ok(ValidatedProtectionOptions {
    user_password,
    owner_password,
    print,
    modify,
    allow_extract: options.allow_extract,
    encrypt_metadata: options.encrypt_metadata,
  })
}

fn build_temp_stamp() -> u128 {
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or_default();
  let counter = u128::from(TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed));
  now.saturating_mul(1_000).saturating_add(counter)
}

fn remove_if_exists(path: &Path) {
  let _ = fs::remove_file(path);
}

fn describe_failure(output: &Output) -> String {
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  if !stderr.is_empty() {
    return stderr;
  }

  let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
  if !stdout.is_empty() {
    return stdout;
  }

  format!("qpdf exited with status {}", output.status)
}

#[cfg(test)]
mod tests {
  use super::{
    decrypt_pdf_bytes, protect_pdf_bytes, probe_qpdf, resolve_qpdf, PdfProtectionOptions,
    ResolvedQpdf,
  };
  use crate::pdf_inspect;
  use std::{
    env, fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
  };

  #[test]
  fn probe_qpdf_reports_local_runtime_when_installed() {
    let status = probe_qpdf();

    if !status.available {
      assert!(status.missing_reason.is_some());
      return;
    }

    assert!(status.binary_path.is_some());
    assert!(status.version.is_some());
  }

  #[test]
  fn protect_pdf_bytes_rejects_reused_passwords() {
    let result = protect_pdf_bytes(
      b"%PDF-1.4",
      &PdfProtectionOptions {
        user_password: Some("same-secret".to_string()),
        owner_password: "same-secret".to_string(),
        print: "full".to_string(),
        modify: "annotate".to_string(),
        allow_extract: true,
        encrypt_metadata: true,
      },
    );

    assert!(result.is_err());
    assert!(result
      .err()
      .unwrap_or_default()
      .contains("different open and owner passwords"));
  }

  #[test]
  fn protect_pdf_bytes_smoke_test_with_local_qpdf() {
    let qpdf = match resolve_qpdf() {
      Ok(runtime) => runtime,
      Err(_) => return,
    };

    let source = create_empty_pdf_bytes(&qpdf).expect("qpdf should create an empty source PDF");
    let protected = protect_pdf_bytes(
      &source,
      &PdfProtectionOptions {
        user_password: Some("viewer-secret".to_string()),
        owner_password: "owner-secret-2026".to_string(),
        print: "low".to_string(),
        modify: "annotate".to_string(),
        allow_extract: false,
        encrypt_metadata: false,
      },
    )
    .expect("qpdf should produce a protected PDF");

    let flags = pdf_inspect::classify_pdf(&protected);
    assert!(flags.encrypted);

    let report = pdf_inspect::build_trust_report(&protected, &flags);
    assert!(report.encryption.encrypted);
    assert_eq!(report.encryption.key_length_bits, Some(256));
  }

  #[test]
  fn decrypt_pdf_bytes_smoke_test_with_local_qpdf() {
    let qpdf = match resolve_qpdf() {
      Ok(runtime) => runtime,
      Err(_) => return,
    };

    let source = create_empty_pdf_bytes(&qpdf).expect("qpdf should create an empty source PDF");
    let protected = protect_pdf_bytes(
      &source,
      &PdfProtectionOptions {
        user_password: Some("viewer-secret".to_string()),
        owner_password: "owner-secret-2026".to_string(),
        print: "low".to_string(),
        modify: "annotate".to_string(),
        allow_extract: false,
        encrypt_metadata: false,
      },
    )
    .expect("qpdf should produce a protected PDF");

    let decrypted =
      decrypt_pdf_bytes(&protected, Some("viewer-secret")).expect("qpdf should unlock the PDF");

    let flags = pdf_inspect::classify_pdf(&decrypted);
    assert!(!flags.encrypted);

    let report = pdf_inspect::build_trust_report(&decrypted, &flags);
    assert!(!report.encryption.encrypted);
  }

  fn create_empty_pdf_bytes(qpdf: &ResolvedQpdf) -> Result<Vec<u8>, String> {
    let stamp = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|duration| duration.as_millis())
      .unwrap_or_default();
    let output_path = env::temp_dir().join(format!("sampadan-qpdf-empty-{stamp}.pdf"));
    let output = Command::new(&qpdf.command)
      .arg("--empty")
      .arg(&output_path)
      .output()
      .map_err(|error| format!("Failed to launch qpdf for empty-PDF smoke test: {error}"))?;

    if !output.status.success() {
      let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
      return Err(if stderr.is_empty() {
        format!("qpdf failed to create an empty PDF: {}", output.status)
      } else {
        stderr
      });
    }

    let bytes = fs::read(&output_path).map_err(|error| {
      format!(
        "qpdf created an empty PDF, but Sampadan could not read {}: {error}",
        output_path.display()
      )
    })?;
    let _ = fs::remove_file(&output_path);
    Ok(bytes)
  }
}

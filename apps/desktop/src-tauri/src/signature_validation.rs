use std::{
  env, fs,
  path::{Path, PathBuf},
  process::{Command, Output},
  time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone)]
pub struct SignatureValidationRuntime {
  pub available: bool,
  pub binary_path: Option<String>,
  pub version: Option<String>,
  pub missing_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SignatureValidationResult {
  pub integrity_status: String,
  pub integrity_message: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedOpenSsl {
  command: PathBuf,
  display_path: String,
  version: String,
}

pub(crate) fn resolve_openssl() -> Result<ResolvedOpenSsl, String> {
  if let Ok(configured_path) = env::var("SAMPADAN_OPENSSL_PATH") {
    let candidate = PathBuf::from(configured_path);
    if let Some(version) = probe_candidate(&candidate) {
      return Ok(ResolvedOpenSsl {
        display_path: candidate.to_string_lossy().to_string(),
        command: candidate,
        version,
      });
    }
  }

  let path_candidate = PathBuf::from("openssl");
  if let Some(version) = probe_candidate(&path_candidate) {
    return Ok(ResolvedOpenSsl {
      command: path_candidate,
      display_path: "openssl".to_string(),
      version,
    });
  }

  for candidate in common_openssl_locations() {
    if let Some(version) = probe_candidate(&candidate) {
      return Ok(ResolvedOpenSsl {
        display_path: candidate.to_string_lossy().to_string(),
        command: candidate,
        version,
      });
    }
  }

  Err(
    "OpenSSL is not installed or not reachable. Install it locally or set SAMPADAN_OPENSSL_PATH."
      .to_string(),
  )
}

pub(crate) fn runtime_from_resolved(openssl: &ResolvedOpenSsl) -> SignatureValidationRuntime {
  SignatureValidationRuntime {
    available: true,
    binary_path: Some(openssl.display_path.clone()),
    version: Some(openssl.version.clone()),
    missing_reason: None,
  }
}

pub(crate) fn validate_detached_signature(
  openssl: &ResolvedOpenSsl,
  signature_bytes: &[u8],
  signed_content: &[u8],
  sub_filter: Option<&str>,
) -> SignatureValidationResult {
  let sub_filter = sub_filter.unwrap_or("").trim();
  if !supports_detached_cms(sub_filter) {
    let detail = if sub_filter.is_empty() {
      "Signature SubFilter is missing. Sampadan currently validates detached CMS signatures only."
        .to_string()
    } else {
      format!(
        "Unsupported signature SubFilter \"{sub_filter}\". Sampadan currently validates detached CMS signatures only."
      )
    };

    return SignatureValidationResult {
      integrity_status: "unsupported".to_string(),
      integrity_message: Some(detail),
    };
  }

  let signature_bytes = trim_der_padding(signature_bytes);
  if signature_bytes.is_empty() {
    return SignatureValidationResult {
      integrity_status: "missing-data".to_string(),
      integrity_message: Some(
        "The signature /Contents entry could not be decoded into a CMS payload.".to_string(),
      ),
    };
  }

  let stamp = build_temp_stamp();
  let signature_path = env::temp_dir().join(format!("sampadan-signature-{stamp}.der"));
  let content_path = env::temp_dir().join(format!("sampadan-signed-content-{stamp}.bin"));
  let output_path = env::temp_dir().join(format!("sampadan-verified-content-{stamp}.bin"));

  if let Err(error) = fs::write(&signature_path, &signature_bytes) {
    return SignatureValidationResult {
      integrity_status: "unavailable".to_string(),
      integrity_message: Some(format!(
        "Failed to stage the signature payload {}: {error}",
        signature_path.display()
      )),
    };
  }

  if let Err(error) = fs::write(&content_path, signed_content) {
    remove_if_exists(&signature_path);
    return SignatureValidationResult {
      integrity_status: "unavailable".to_string(),
      integrity_message: Some(format!(
        "Failed to stage the signed PDF bytes {}: {error}",
        content_path.display()
      )),
    };
  }

  let output = Command::new(&openssl.command)
    .arg("cms")
    .arg("-verify")
    .arg("-binary")
    .arg("-inform")
    .arg("DER")
    .arg("-in")
    .arg(&signature_path)
    .arg("-content")
    .arg(&content_path)
    .arg("-noverify")
    .arg("-out")
    .arg(&output_path)
    .output();

  remove_if_exists(&signature_path);
  remove_if_exists(&content_path);
  remove_if_exists(&output_path);

  match output {
    Ok(output) if output.status.success() => SignatureValidationResult {
      integrity_status: "verified".to_string(),
      integrity_message: Some(
        "Detached CMS signature verified locally against the PDF ByteRange content."
          .to_string(),
      ),
    },
    Ok(output) => SignatureValidationResult {
      integrity_status: "failed".to_string(),
      integrity_message: Some(describe_validation_failure(&output)),
    },
    Err(error) => SignatureValidationResult {
      integrity_status: "unavailable".to_string(),
      integrity_message: Some(format!("Failed to launch OpenSSL: {error}")),
    },
  }
}

pub(crate) fn build_signed_content(bytes: &[u8], byte_range: &[u64]) -> Result<Vec<u8>, String> {
  if byte_range.len() < 2 || byte_range.len() % 2 != 0 {
    return Err("ByteRange must contain offset-length pairs.".to_string());
  }

  let mut signed_content = Vec::new();
  for pair in byte_range.chunks_exact(2) {
    let start = usize::try_from(pair[0])
      .map_err(|_| "ByteRange offset is too large for this platform.".to_string())?;
    let length = usize::try_from(pair[1])
      .map_err(|_| "ByteRange length is too large for this platform.".to_string())?;
    let end = start
      .checked_add(length)
      .ok_or_else(|| "ByteRange offset and length overflowed.".to_string())?;

    if end > bytes.len() {
      return Err(format!(
        "ByteRange segment {start}..{end} exceeds the PDF length {}.",
        bytes.len()
      ));
    }

    signed_content.extend_from_slice(&bytes[start..end]);
  }

  Ok(signed_content)
}

fn probe_candidate(candidate: &Path) -> Option<String> {
  let output = Command::new(candidate).arg("version").output().ok()?;
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

fn supports_detached_cms(sub_filter: &str) -> bool {
  matches!(sub_filter, "" | "adbe.pkcs7.detached" | "ETSI.CAdES.detached")
}

fn trim_der_padding(bytes: &[u8]) -> Vec<u8> {
  let trimmed = bytes
    .iter()
    .rposition(|byte| *byte != 0)
    .map(|index| &bytes[..=index])
    .unwrap_or(&[]);

  if trimmed.len() < 2 || trimmed[0] != 0x30 {
    return trimmed.to_vec();
  }

  let (header_len, content_len) = match trimmed[1] {
    value if value & 0x80 == 0 => (2usize, usize::from(value)),
    value => {
      let length_len = usize::from(value & 0x7F);
      if length_len == 0 || length_len > 4 || trimmed.len() < 2 + length_len {
        return trimmed.to_vec();
      }

      let mut content_len = 0usize;
      for byte in &trimmed[2..2 + length_len] {
        content_len = (content_len << 8) | usize::from(*byte);
      }

      (2 + length_len, content_len)
    }
  };

  let total_len = header_len.saturating_add(content_len);
  if total_len == 0 || total_len > trimmed.len() {
    return trimmed.to_vec();
  }

  trimmed[..total_len].to_vec()
}

fn describe_validation_failure(output: &Output) -> String {
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  if !stderr.is_empty() {
    return stderr;
  }

  let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
  if !stdout.is_empty() {
    return stdout;
  }

  "OpenSSL reported a detached signature verification failure.".to_string()
}

fn common_openssl_locations() -> Vec<PathBuf> {
  let mut candidates = Vec::new();

  #[cfg(target_os = "windows")]
  {
    if let Ok(program_files) = env::var("ProgramFiles") {
      let program_files = PathBuf::from(program_files);
      candidates.push(program_files.join("OpenSSL-Win64").join("bin").join("openssl.exe"));
      candidates.push(program_files.join("OpenSSL-Win32").join("bin").join("openssl.exe"));
      candidates.push(program_files.join("Git").join("usr").join("bin").join("openssl.exe"));
    }

    if let Ok(program_files_x86) = env::var("ProgramFiles(x86)") {
      let program_files_x86 = PathBuf::from(program_files_x86);
      candidates.push(
        program_files_x86
          .join("OpenSSL-Win32")
          .join("bin")
          .join("openssl.exe"),
      );
      candidates.push(
        program_files_x86
          .join("Git")
          .join("usr")
          .join("bin")
          .join("openssl.exe"),
      );
    }
  }

  #[cfg(target_os = "macos")]
  {
    candidates.push(PathBuf::from("/opt/homebrew/bin/openssl"));
    candidates.push(PathBuf::from("/opt/homebrew/opt/openssl@3/bin/openssl"));
    candidates.push(PathBuf::from("/usr/local/bin/openssl"));
    candidates.push(PathBuf::from("/usr/bin/openssl"));
  }

  #[cfg(target_os = "linux")]
  {
    candidates.push(PathBuf::from("/usr/bin/openssl"));
    candidates.push(PathBuf::from("/usr/local/bin/openssl"));
    candidates.push(PathBuf::from("/snap/bin/openssl"));
  }

  candidates
}

fn build_temp_stamp() -> String {
  let timestamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or_default();
  let process_id = std::process::id();
  format!("{timestamp}-{process_id}")
}

fn remove_if_exists(path: &Path) {
  if path.exists() {
    let _ = fs::remove_file(path);
  }
}

#[cfg(test)]
mod tests {
  use super::{
    build_signed_content, resolve_openssl, runtime_from_resolved, trim_der_padding,
    validate_detached_signature,
  };
  use std::{env, fs, process::Command};

  #[test]
  fn build_signed_content_joins_all_ranges() {
    let bytes = b"abcdefghijklmnop";
    let signed = build_signed_content(bytes, &[0, 4, 8, 4]).expect("ranges should resolve");

    assert_eq!(signed, b"abcdijkl");
  }

  #[test]
  fn trim_der_padding_respects_declared_length() {
    let der = vec![0x30, 0x03, 0x02, 0x01, 0x05, 0x00, 0x00, 0x00];

    assert_eq!(trim_der_padding(&der), vec![0x30, 0x03, 0x02, 0x01, 0x05]);
  }

  #[test]
  fn detached_signature_verifies_with_openssl_when_available() {
    let Ok(openssl) = resolve_openssl() else {
      return;
    };

    let temp_dir = env::temp_dir().join(format!("sampadan-signature-test-{}", std::process::id()));
    let _ = fs::create_dir_all(&temp_dir);

    let content_path = temp_dir.join("content.bin");
    let config_path = temp_dir.join("openssl.cnf");
    let key_path = temp_dir.join("key.pem");
    let cert_path = temp_dir.join("cert.pem");
    let signature_path = temp_dir.join("signature.der");
    let content_bytes = b"Sampadan detached validation".to_vec();

    fs::write(&content_path, &content_bytes).expect("content should write");
    fs::write(
      &config_path,
      "[req]\ndistinguished_name=req_distinguished_name\nprompt=no\n[req_distinguished_name]\nCN=Sampadan Test\n",
    )
    .expect("config should write");

    let req_output = Command::new(&openssl.command)
      .arg("req")
      .arg("-x509")
      .arg("-newkey")
      .arg("rsa:2048")
      .arg("-keyout")
      .arg(&key_path)
      .arg("-out")
      .arg(&cert_path)
      .arg("-days")
      .arg("1")
      .arg("-nodes")
      .arg("-config")
      .arg(&config_path)
      .arg("-batch")
      .output()
      .expect("openssl req should launch");
    assert!(
      req_output.status.success(),
      "{}",
      String::from_utf8_lossy(&req_output.stderr)
    );

    let sign_output = Command::new(&openssl.command)
      .arg("cms")
      .arg("-sign")
      .arg("-binary")
      .arg("-in")
      .arg(&content_path)
      .arg("-signer")
      .arg(&cert_path)
      .arg("-inkey")
      .arg(&key_path)
      .arg("-outform")
      .arg("DER")
      .arg("-out")
      .arg(&signature_path)
      .arg("-md")
      .arg("sha256")
      .output()
      .expect("openssl cms -sign should launch");
    assert!(
      sign_output.status.success(),
      "{}",
      String::from_utf8_lossy(&sign_output.stderr)
    );

    let signature_bytes = fs::read(&signature_path).expect("signature should be readable");
    let runtime = runtime_from_resolved(&openssl);
    assert!(runtime.available);

    let result = validate_detached_signature(
      &openssl,
      &signature_bytes,
      &content_bytes,
      Some("adbe.pkcs7.detached"),
    );

    assert_eq!(result.integrity_status, "verified");
    assert!(result
      .integrity_message
      .as_deref()
      .unwrap_or_default()
      .contains("verified locally"));

    let _ = fs::remove_file(&content_path);
    let _ = fs::remove_file(&config_path);
    let _ = fs::remove_file(&key_path);
    let _ = fs::remove_file(&cert_path);
    let _ = fs::remove_file(&signature_path);
    let _ = fs::remove_dir(&temp_dir);
  }
}

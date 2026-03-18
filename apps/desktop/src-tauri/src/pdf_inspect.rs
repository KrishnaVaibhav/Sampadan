use crate::signature_validation;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfFlags {
  pub encrypted: bool,
  pub signed: bool,
  pub has_forms: bool,
  pub has_xfa: bool,
  pub has_javascript: bool,
  pub has_attachments: bool,
  pub tagged: bool,
  pub linearized: bool,
  pub likely_scanned: bool,
  pub mixed_content: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSignatureSummary {
  pub field_name: Option<String>,
  pub signer_name: Option<String>,
  pub reason: Option<String>,
  pub location: Option<String>,
  pub contact_info: Option<String>,
  pub modification_time: Option<String>,
  pub filter: Option<String>,
  pub sub_filter: Option<String>,
  pub byte_range: Option<Vec<u64>>,
  pub covers_whole_document: bool,
  pub is_timestamp: bool,
  pub doc_mdp: bool,
  pub integrity_status: String,
  pub integrity_message: Option<String>,
  pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfTrustReport {
  pub signature_count: usize,
  pub signatures: Vec<PdfSignatureSummary>,
  pub signature_validation_runtime: Option<PdfSignatureValidationRuntime>,
  pub attachment_count: usize,
  pub attachments: Vec<PdfAttachmentSummary>,
  pub encryption: PdfEncryptionSummary,
  pub recommendations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSignatureValidationRuntime {
  pub available: bool,
  pub binary_path: Option<String>,
  pub version: Option<String>,
  pub missing_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAttachmentSummary {
  pub file_name: Option<String>,
  pub description: Option<String>,
  pub relationship: Option<String>,
  pub embedded: bool,
  pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfEncryptionSummary {
  pub encrypted: bool,
  pub handler: Option<String>,
  pub algorithm: Option<String>,
  pub version: Option<i32>,
  pub revision: Option<i32>,
  pub key_length_bits: Option<i32>,
  pub permissions: Option<i64>,
  pub stream_filter: Option<String>,
  pub string_filter: Option<String>,
  pub encrypt_metadata: Option<bool>,
  pub notes: Vec<String>,
}

#[derive(Debug, Clone)]
struct ExtractedSignature {
  summary: PdfSignatureSummary,
  contents_bytes: Option<Vec<u8>>,
}

pub fn extract_pdf_version(bytes: &[u8]) -> String {
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

pub fn classify_pdf(bytes: &[u8]) -> PdfFlags {
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

pub fn build_trust_report(bytes: &[u8], flags: &PdfFlags) -> PdfTrustReport {
  let mut extracted_signatures = extract_signatures(bytes);
  let signature_validation_runtime = validate_signatures(bytes, &mut extracted_signatures);
  let signatures = extracted_signatures
    .into_iter()
    .map(|signature| signature.summary)
    .collect::<Vec<_>>();
  let attachments = extract_attachment_summaries(bytes);
  let encryption = build_encryption_summary(bytes, flags);
  let mut recommendations = Vec::new();

  if flags.signed && signatures.is_empty() {
    recommendations.push(
      "Signature markers were detected, but Sampadan could not parse a structured signature dictionary."
        .to_string(),
    );
  }

  if !signatures.is_empty() {
    recommendations.push(
      "Saving edits will create a new PDF revision and may invalidate existing signatures."
        .to_string(),
    );
  }

  if signatures
    .iter()
    .any(|signature| signature.integrity_status == "verified")
  {
    recommendations.push(
      "At least one detached CMS signature was verified locally against the PDF ByteRange content."
        .to_string(),
    );
  }

  if signatures
    .iter()
    .any(|signature| signature.integrity_status == "failed")
  {
    recommendations.push(
      "At least one signature failed cryptographic verification against the current PDF bytes."
        .to_string(),
    );
  }

  if signatures
    .iter()
    .any(|signature| signature.integrity_status == "unsupported")
  {
    recommendations.push(
      "Some signatures use SubFilter variants that Sampadan does not validate yet."
        .to_string(),
    );
  }

  if let Some(runtime) = &signature_validation_runtime {
    if !runtime.available {
      recommendations.push(
        runtime
          .missing_reason
          .clone()
          .unwrap_or_else(|| {
            "Cryptographic signature validation is unavailable on this device.".to_string()
          }),
      );
    }
  }

  if signatures.iter().any(|signature| !signature.covers_whole_document) {
    recommendations.push(
      "At least one signature does not cover the final saved bytes. The file may contain incremental updates after signing."
        .to_string(),
    );
  }

  if signatures.iter().any(|signature| signature.doc_mdp) {
    recommendations.push(
      "This PDF includes DocMDP certification data. Modification permissions may be restricted."
        .to_string(),
    );
  }

  if attachments.len() > 0 {
    recommendations.push(
      "This PDF contains embedded attachments. Inspect bundled files before sharing or archiving."
        .to_string(),
    );
  }

  if encryption.encrypted {
    let algorithm = encryption
      .algorithm
      .clone()
      .unwrap_or_else(|| "an unspecified security handler".to_string());
    recommendations.push(format!(
      "This PDF is encrypted with {algorithm}. Password-aware editing and validation paths may be required."
    ));
  }

  if flags.has_javascript {
    recommendations.push(
      "Embedded JavaScript is present. Review the document carefully before redistribution."
        .to_string(),
    );
  }

  if flags.has_xfa {
    recommendations.push(
      "XFA forms are present. Editing fidelity may vary across PDF engines."
        .to_string(),
    );
  }

  if recommendations.is_empty() {
    recommendations.push("No digital signature dictionaries were detected.".to_string());
  }

  PdfTrustReport {
    signature_count: signatures.len(),
    signatures,
    signature_validation_runtime,
    attachment_count: attachments.len(),
    attachments,
    encryption,
    recommendations,
  }
}

fn extract_signatures(bytes: &[u8]) -> Vec<ExtractedSignature> {
  let mut hint_positions = find_occurrences(bytes, b"/ByteRange");
  if hint_positions.is_empty() {
    hint_positions = find_occurrences(bytes, b"/Type /Sig");
  }

  let mut signatures = Vec::new();
  let mut seen = HashSet::new();

  for hint in hint_positions {
    let Some((start, end)) = extract_dictionary_bounds(bytes, hint, 32 * 1024, 256 * 1024) else {
      continue;
    };

    if !seen.insert(start) {
      continue;
    }

    let dictionary_bytes = &bytes[start..end];
    let dictionary_text = String::from_utf8_lossy(dictionary_bytes);
    if !dictionary_text.contains("/ByteRange") && !dictionary_text.contains("/Type /Sig") {
      continue;
    }

    let context_start = hint.saturating_sub(2048);
    let context_end = (hint + 2048).min(bytes.len());
    let context_text = String::from_utf8_lossy(&bytes[context_start..context_end]);

    signatures.push(parse_signature_entry(
      &dictionary_text,
      &context_text,
      bytes.len() as u64,
    ));
  }

  signatures
}

fn parse_signature_entry(
  dictionary_text: &str,
  context_text: &str,
  file_length: u64,
) -> ExtractedSignature {
  let byte_range = extract_byte_range(dictionary_text);
  let covers_whole_document = byte_range
    .as_ref()
    .map(|values| covers_whole_document(values, file_length))
    .unwrap_or(false);
  let sub_filter = extract_name_value(dictionary_text, "/SubFilter");
  let is_timestamp = dictionary_text.contains("/Type /DocTimeStamp")
    || sub_filter.as_deref() == Some("ETSI.RFC3161");
  let doc_mdp = dictionary_text.contains("/DocMDP") || dictionary_text.contains("/TransformMethod /DocMDP");
  let contents_bytes = extract_contents_bytes(dictionary_text);

  let mut notes = Vec::new();
  if is_timestamp {
    notes.push("Timestamp signature".to_string());
  }
  if doc_mdp {
    notes.push("Contains DocMDP certification policy".to_string());
  }
  if !covers_whole_document && byte_range.is_some() {
    notes.push("Signature byte range does not end at the final byte of the current file".to_string());
  }

  if contents_bytes.is_none() {
    notes.push("Signature /Contents payload could not be decoded for cryptographic verification".to_string());
  }

  ExtractedSignature {
    summary: PdfSignatureSummary {
      field_name: extract_string_value(context_text, "/T"),
      signer_name: extract_string_value(dictionary_text, "/Name")
        .or_else(|| extract_string_value(context_text, "/TU")),
      reason: extract_string_value(dictionary_text, "/Reason"),
      location: extract_string_value(dictionary_text, "/Location"),
      contact_info: extract_string_value(dictionary_text, "/ContactInfo"),
      modification_time: extract_string_value(dictionary_text, "/M"),
      filter: extract_name_value(dictionary_text, "/Filter"),
      sub_filter,
      byte_range,
      covers_whole_document,
      is_timestamp,
      doc_mdp,
      integrity_status: "not-checked".to_string(),
      integrity_message: None,
      notes,
    },
    contents_bytes,
  }
}

fn validate_signatures(
  bytes: &[u8],
  signatures: &mut [ExtractedSignature],
) -> Option<PdfSignatureValidationRuntime> {
  if signatures.is_empty() {
    return None;
  }

  let mut eligible_indices = Vec::new();
  for (index, signature) in signatures.iter_mut().enumerate() {
    if signature.summary.byte_range.is_none() {
      signature.summary.integrity_status = "missing-data".to_string();
      signature.summary.integrity_message =
        Some("Signature dictionary does not contain a usable /ByteRange entry.".to_string());
      continue;
    }

    if signature.contents_bytes.is_none() {
      signature.summary.integrity_status = "missing-data".to_string();
      signature.summary.integrity_message =
        Some("Signature dictionary does not contain a decodable /Contents payload.".to_string());
      continue;
    }

    eligible_indices.push(index);
  }

  if eligible_indices.is_empty() {
    return None;
  }

  let openssl = match signature_validation::resolve_openssl() {
    Ok(openssl) => openssl,
    Err(reason) => {
      for index in eligible_indices {
        signatures[index].summary.integrity_status = "unavailable".to_string();
        signatures[index].summary.integrity_message = Some(reason.clone());
      }

      return Some(PdfSignatureValidationRuntime {
        available: false,
        binary_path: None,
        version: None,
        missing_reason: Some(reason),
      });
    }
  };

  for index in eligible_indices {
    let signature = &mut signatures[index];
    let byte_range = signature.summary.byte_range.clone().unwrap_or_default();
    let contents_bytes = signature.contents_bytes.as_deref().unwrap_or_default();

    let signed_content = match signature_validation::build_signed_content(bytes, &byte_range) {
      Ok(signed_content) => signed_content,
      Err(error) => {
        signature.summary.integrity_status = "missing-data".to_string();
        signature.summary.integrity_message = Some(error);
        continue;
      }
    };

    let validation = signature_validation::validate_detached_signature(
      &openssl,
      contents_bytes,
      &signed_content,
      signature.summary.sub_filter.as_deref(),
    );
    signature.summary.integrity_status = validation.integrity_status;
    signature.summary.integrity_message = validation.integrity_message;
  }

  let runtime = signature_validation::runtime_from_resolved(&openssl);
  Some(PdfSignatureValidationRuntime {
    available: runtime.available,
    binary_path: runtime.binary_path,
    version: runtime.version,
    missing_reason: runtime.missing_reason,
  })
}

fn covers_whole_document(byte_range: &[u64], file_length: u64) -> bool {
  if byte_range.len() < 2 || byte_range.len() % 2 != 0 || byte_range[0] != 0 {
    return false;
  }

  let mut last_end = 0u64;
  for pair in byte_range.chunks_exact(2) {
    let start = pair[0];
    let length = pair[1];
    let end = start.saturating_add(length);
    if start < last_end {
      return false;
    }
    last_end = end;
  }

  last_end == file_length
}

fn extract_contents_bytes(text: &str) -> Option<Vec<u8>> {
  extract_raw_bytes_value(text, "/Contents")
}

fn extract_attachment_summaries(bytes: &[u8]) -> Vec<PdfAttachmentSummary> {
  let mut hint_positions = find_occurrences(bytes, b"/Type /Filespec");
  if hint_positions.is_empty() {
    hint_positions = find_occurrences(bytes, b"/Filespec");
  }

  let mut attachments = Vec::new();
  let mut seen = HashSet::new();

  for hint in hint_positions {
    let Some((start, end)) = extract_dictionary_bounds(bytes, hint, 16 * 1024, 128 * 1024) else {
      continue;
    };

    if !seen.insert(start) {
      continue;
    }

    let dictionary_text = String::from_utf8_lossy(&bytes[start..end]);
    if !dictionary_text.contains("/Filespec") {
      continue;
    }

    let file_name = extract_string_value(&dictionary_text, "/UF")
      .or_else(|| extract_string_value(&dictionary_text, "/F"));
    let description = extract_string_value(&dictionary_text, "/Desc");
    let relationship = extract_name_value(&dictionary_text, "/AFRelationship");
    let embedded = dictionary_text.contains("/EF");

    if file_name.is_none() && description.is_none() && !embedded {
      continue;
    }

    let mut notes = Vec::new();
    if embedded {
      notes.push("Embedded file stream reference present".to_string());
    }
    if let Some(relationship_value) = relationship.clone() {
      notes.push(format!("Attachment relationship: {relationship_value}"));
    }

    attachments.push(PdfAttachmentSummary {
      file_name,
      description,
      relationship,
      embedded,
      notes,
    });
  }

  attachments
}

fn build_encryption_summary(bytes: &[u8], flags: &PdfFlags) -> PdfEncryptionSummary {
  if !flags.encrypted {
    return PdfEncryptionSummary {
      encrypted: false,
      handler: None,
      algorithm: None,
      version: None,
      revision: None,
      key_length_bits: None,
      permissions: None,
      stream_filter: None,
      string_filter: None,
      encrypt_metadata: None,
      notes: Vec::new(),
    };
  }

  let dictionary_text = extract_encryption_dictionary(bytes);
  let handler = dictionary_text
    .as_deref()
    .and_then(|dictionary| extract_name_value(dictionary, "/Filter"));
  let version = dictionary_text
    .as_deref()
    .and_then(|dictionary| extract_integer_value(dictionary, "/V"));
  let revision = dictionary_text
    .as_deref()
    .and_then(|dictionary| extract_integer_value(dictionary, "/R"));
  let key_length_bits = dictionary_text
    .as_deref()
    .and_then(|dictionary| extract_integer_value(dictionary, "/Length"));
  let permissions = dictionary_text
    .as_deref()
    .and_then(|dictionary| extract_integer_value(dictionary, "/P"))
    .map(i64::from);
  let stream_filter = dictionary_text
    .as_deref()
    .and_then(|dictionary| extract_name_value(dictionary, "/StmF"));
  let string_filter = dictionary_text
    .as_deref()
    .and_then(|dictionary| extract_name_value(dictionary, "/StrF"));
  let encrypt_metadata = dictionary_text
    .as_deref()
    .and_then(|dictionary| extract_bool_value(dictionary, "/EncryptMetadata"));

  let algorithm = infer_encryption_algorithm(
    dictionary_text.as_deref(),
    revision,
    key_length_bits,
    stream_filter.as_deref(),
    string_filter.as_deref(),
  );

  let mut notes = Vec::new();
  if dictionary_text.is_none() {
    notes.push(
      "Encryption marker detected, but Sampadan could not isolate the encryption dictionary."
        .to_string(),
    );
  }
  if encrypt_metadata == Some(false) {
    notes.push("Metadata is excluded from encryption.".to_string());
  }
  if stream_filter.as_deref() == Some("Identity") || string_filter.as_deref() == Some("Identity") {
    notes.push("Some PDF objects are left unencrypted via Identity filters.".to_string());
  }

  PdfEncryptionSummary {
    encrypted: true,
    handler,
    algorithm,
    version,
    revision,
    key_length_bits,
    permissions,
    stream_filter,
    string_filter,
    encrypt_metadata,
    notes,
  }
}

fn extract_encryption_dictionary(bytes: &[u8]) -> Option<String> {
  let mut hint_positions = find_occurrences(bytes, b"/Filter /Standard");
  if hint_positions.is_empty() {
    hint_positions = find_occurrences(bytes, b"/EncryptMetadata");
  }
  if hint_positions.is_empty() {
    hint_positions = find_occurrences(bytes, b"/StmF");
  }
  if hint_positions.is_empty() {
    hint_positions = find_occurrences(bytes, b"/StrF");
  }
  if hint_positions.is_empty() {
    hint_positions = find_occurrences(bytes, b"/CFM /AESV");
  }

  for hint in hint_positions {
    let Some((start, end)) = extract_dictionary_bounds(bytes, hint, 24 * 1024, 128 * 1024) else {
      continue;
    };

    let dictionary_text = String::from_utf8_lossy(&bytes[start..end]).to_string();
    if dictionary_text.contains("/Filter /Standard")
      || dictionary_text.contains("/EncryptMetadata")
      || dictionary_text.contains("/StmF")
      || dictionary_text.contains("/StrF")
      || dictionary_text.contains("/CFM /AESV")
    {
      return Some(dictionary_text);
    }
  }

  None
}

fn infer_encryption_algorithm(
  dictionary_text: Option<&str>,
  revision: Option<i32>,
  key_length_bits: Option<i32>,
  stream_filter: Option<&str>,
  string_filter: Option<&str>,
) -> Option<String> {
  let text = dictionary_text.unwrap_or("");
  if text.contains("AESV3")
    || revision.unwrap_or_default() >= 6
    || key_length_bits.unwrap_or_default() >= 256
  {
    return Some("AES-256 standard security".to_string());
  }

  if text.contains("AESV2")
    || stream_filter == Some("StdCF")
    || string_filter == Some("StdCF")
    || key_length_bits.unwrap_or_default() >= 128
  {
    return Some("AES-128 or modern standard security".to_string());
  }

  if text.contains("/Filter /Standard") {
    return Some("legacy standard security handler".to_string());
  }

  None
}

fn extract_byte_range(text: &str) -> Option<Vec<u64>> {
  let tail = find_key_tail(text, "/ByteRange")?;
  let start = tail.find('[')?;
  let remainder = &tail[start + 1..];
  let end = remainder.find(']')?;

  let values = remainder[..end]
    .split_whitespace()
    .filter_map(|value| value.parse::<u64>().ok())
    .collect::<Vec<_>>();

  if values.is_empty() {
    None
  } else {
    Some(values)
  }
}

fn extract_name_value(text: &str, key: &str) -> Option<String> {
  let tail = find_key_tail(text, key)?;
  let value = tail.strip_prefix('/')?;

  let token = value
    .chars()
    .take_while(|character| {
      !character.is_whitespace()
        && !matches!(
          character,
          '/' | '<' | '>' | '[' | ']' | '(' | ')' | '{' | '}' | '%'
        )
    })
    .collect::<String>();

  if token.is_empty() {
    None
  } else {
    Some(token)
  }
}

fn extract_string_value(text: &str, key: &str) -> Option<String> {
  let tail = find_key_tail(text, key)?;
  let bytes = tail.as_bytes();
  if bytes.first().copied() != Some(b'(') {
    return extract_hex_string_value(tail);
  }

  let mut depth = 1usize;
  let mut cursor = 1usize;
  let mut escaped = false;

  while cursor < bytes.len() {
    let byte = bytes[cursor];
    if escaped {
      escaped = false;
      cursor += 1;
      continue;
    }

    if byte == b'\\' {
      escaped = true;
      cursor += 1;
      continue;
    }

    if byte == b'(' {
      depth += 1;
      cursor += 1;
      continue;
    }

    if byte == b')' {
      depth = depth.saturating_sub(1);
      if depth == 0 {
        let value = &tail[1..cursor];
        return Some(decode_pdf_literal_string(value));
      }
      cursor += 1;
      continue;
    }

    cursor += 1;
  }

  None
}

fn extract_hex_string_value(text: &str) -> Option<String> {
  let bytes = text.as_bytes();
  if bytes.first().copied() != Some(b'<') || bytes.get(1).copied() == Some(b'<') {
    return None;
  }

  let end = text.find('>')?;
  let raw = text[1..end]
    .chars()
    .filter(|character| !character.is_whitespace())
    .collect::<String>();

  if raw.is_empty() {
    return None;
  }

  let mut normalized = raw;
  if normalized.len() % 2 == 1 {
    normalized.push('0');
  }

  let mut decoded = Vec::new();
  let mut index = 0usize;
  while index + 1 < normalized.len() {
    let byte = u8::from_str_radix(&normalized[index..index + 2], 16).ok()?;
    decoded.push(byte);
    index += 2;
  }

  if decoded.starts_with(&[0xFE, 0xFF]) && decoded.len() >= 4 {
    let utf16 = decoded[2..]
      .chunks_exact(2)
      .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
      .collect::<Vec<_>>();
    return String::from_utf16(&utf16).ok().map(|value| value.trim().to_string());
  }

  String::from_utf8(decoded).ok().map(|value| value.trim().to_string())
}

fn extract_raw_bytes_value(text: &str, key: &str) -> Option<Vec<u8>> {
  let tail = find_key_tail(text, key)?;
  let bytes = tail.as_bytes();

  if bytes.first().copied() == Some(b'<') && bytes.get(1).copied() != Some(b'<') {
    let end = tail.find('>')?;
    let raw = tail[1..end]
      .chars()
      .filter(|character| !character.is_whitespace())
      .collect::<String>();

    if raw.is_empty() {
      return None;
    }

    let mut normalized = raw;
    if normalized.len() % 2 == 1 {
      normalized.push('0');
    }

    let mut decoded = Vec::new();
    let mut index = 0usize;
    while index + 1 < normalized.len() {
      let byte = u8::from_str_radix(&normalized[index..index + 2], 16).ok()?;
      decoded.push(byte);
      index += 2;
    }

    return Some(decoded);
  }

  if bytes.first().copied() != Some(b'(') {
    return None;
  }

  let mut depth = 1usize;
  let mut cursor = 1usize;
  let mut decoded = Vec::new();

  while cursor < bytes.len() {
    let byte = bytes[cursor];
    if byte == b'\\' {
      cursor += 1;
      if cursor >= bytes.len() {
        break;
      }

      let escaped = bytes[cursor];
      match escaped {
        b'n' => decoded.push(b'\n'),
        b'r' => decoded.push(b'\r'),
        b't' => decoded.push(b'\t'),
        b'b' => decoded.push(0x08),
        b'f' => decoded.push(0x0C),
        b'(' | b')' | b'\\' => decoded.push(escaped),
        b'\n' => {}
        b'\r' => {
          if cursor + 1 < bytes.len() && bytes[cursor + 1] == b'\n' {
            cursor += 1;
          }
        }
        b'0'..=b'7' => {
          let mut octal = vec![escaped];
          while cursor + 1 < bytes.len() && octal.len() < 3 {
            let next = bytes[cursor + 1];
            if !(b'0'..=b'7').contains(&next) {
              break;
            }
            cursor += 1;
            octal.push(next);
          }

          let value = u8::from_str_radix(
            &String::from_utf8_lossy(&octal),
            8,
          )
          .ok()?;
          decoded.push(value);
        }
        other => decoded.push(other),
      }

      cursor += 1;
      continue;
    }

    if byte == b'(' {
      depth += 1;
      decoded.push(byte);
      cursor += 1;
      continue;
    }

    if byte == b')' {
      depth = depth.saturating_sub(1);
      if depth == 0 {
        return Some(decoded);
      }
      decoded.push(byte);
      cursor += 1;
      continue;
    }

    decoded.push(byte);
    cursor += 1;
  }

  None
}

fn extract_integer_value(text: &str, key: &str) -> Option<i32> {
  let tail = find_key_tail(text, key)?;
  let token = tail
    .chars()
    .take_while(|character| character.is_ascii_digit() || *character == '-')
    .collect::<String>();

  if token.is_empty() {
    None
  } else {
    token.parse::<i32>().ok()
  }
}

fn extract_bool_value(text: &str, key: &str) -> Option<bool> {
  let tail = find_key_tail(text, key)?;
  if tail.starts_with("true") {
    Some(true)
  } else if tail.starts_with("false") {
    Some(false)
  } else {
    None
  }
}

fn find_key_tail<'a>(text: &'a str, key: &str) -> Option<&'a str> {
  let mut offset = 0usize;

  while offset < text.len() {
    let next_index = text[offset..].find(key)?;
    let absolute_index = offset + next_index;
    let after_index = absolute_index + key.len();

    let before_ok = if absolute_index == 0 {
      true
    } else {
      matches!(
        text[..absolute_index].chars().last(),
        Some(' ' | '\n' | '\r' | '\t' | '<' | '[' | '(' | '{')
      )
    };

    let after_ok = text[after_index..]
      .chars()
      .next()
      .map(|character| {
        character.is_whitespace()
          || matches!(
            character,
            '/' | '<' | '>' | '[' | ']' | '(' | ')' | '{' | '}' | '%'
          )
      })
      .unwrap_or(true);

    if before_ok && after_ok {
      return Some(text[after_index..].trim_start());
    }

    offset = after_index;
  }

  None
}

fn decode_pdf_literal_string(value: &str) -> String {
  let mut decoded = String::new();
  let mut chars = value.chars();

  while let Some(character) = chars.next() {
    if character != '\\' {
      decoded.push(character);
      continue;
    }

    match chars.next() {
      Some('n') => decoded.push('\n'),
      Some('r') => decoded.push('\r'),
      Some('t') => decoded.push('\t'),
      Some('b') => decoded.push('\u{0008}'),
      Some('f') => decoded.push('\u{000C}'),
      Some('(') => decoded.push('('),
      Some(')') => decoded.push(')'),
      Some('\\') => decoded.push('\\'),
      Some(other) => decoded.push(other),
      None => break,
    }
  }

  decoded.trim().to_string()
}

fn extract_dictionary_bounds(
  bytes: &[u8],
  hint: usize,
  lookback: usize,
  lookahead: usize,
) -> Option<(usize, usize)> {
  let search_start = hint.saturating_sub(lookback);
  let mut start = None;
  let mut cursor = hint.min(bytes.len().saturating_sub(1));

  while cursor > search_start {
    if bytes[cursor - 1] == b'<' && bytes[cursor] == b'<' {
      start = Some(cursor - 1);
      break;
    }
    cursor -= 1;
  }

  let start = start?;
  let mut depth = 0usize;
  let limit = (start + lookahead).min(bytes.len());
  let mut index = start;

  while index + 1 < limit {
    if bytes[index] == b'<' && bytes[index + 1] == b'<' {
      depth += 1;
      index += 2;
      continue;
    }

    if bytes[index] == b'>' && bytes[index + 1] == b'>' {
      depth = depth.saturating_sub(1);
      index += 2;
      if depth == 0 {
        return Some((start, index));
      }
      continue;
    }

    index += 1;
  }

  None
}

fn find_occurrences(bytes: &[u8], needle: &[u8]) -> Vec<usize> {
  if needle.is_empty() || bytes.len() < needle.len() {
    return Vec::new();
  }

  let mut positions = Vec::new();
  let mut index = 0usize;

  while index + needle.len() <= bytes.len() {
    if &bytes[index..index + needle.len()] == needle {
      positions.push(index);
      index += needle.len();
    } else {
      index += 1;
    }
  }

  positions
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

#[cfg(test)]
mod tests {
  use super::{
    build_trust_report, classify_pdf, decode_pdf_literal_string, extract_bool_value,
    extract_byte_range, extract_integer_value, extract_name_value, extract_string_value,
    find_occurrences, infer_encryption_algorithm,
  };

  #[test]
  fn extracts_name_and_literal_values() {
    let dictionary = "<< /Type /Sig /T (Signature 1) /Filter /Adobe.PPKLite /Reason (Approved\\) copy) >>";

    assert_eq!(extract_name_value(dictionary, "/Filter").as_deref(), Some("Adobe.PPKLite"));
    assert_eq!(extract_string_value(dictionary, "/T").as_deref(), Some("Signature 1"));
    assert_eq!(
      extract_string_value(dictionary, "/Reason").as_deref(),
      Some("Approved) copy")
    );
  }

  #[test]
  fn byte_range_is_parsed() {
    let dictionary = "<< /ByteRange [0 100 200 300] >>";

    assert_eq!(extract_byte_range(dictionary), Some(vec![0, 100, 200, 300]));
  }

  #[test]
  fn decode_literal_handles_basic_escapes() {
    assert_eq!(decode_pdf_literal_string(r"Hello\\World\)"), r"Hello\World)");
  }

  #[test]
  fn find_occurrences_returns_all_positions() {
    let bytes = b"/ByteRange /ByteRange";

    assert_eq!(find_occurrences(bytes, b"/ByteRange"), vec![0, 11]);
  }

  #[test]
  fn trust_report_extracts_signature_summary() {
    let bytes = br#"%PDF-1.7
1 0 obj
<<
/Type /Sig
/Filter /Adobe.PPKLite
/SubFilter /adbe.pkcs7.detached
/ByteRange [0 100 200 300]
/Name (Krishna Vaibhav)
/Reason (Approved)
/Location (Halifax)
/M (D:20260318070000Z)
/Reference [<< /TransformMethod /DocMDP >>]
>>
endobj
"#;

    let flags = classify_pdf(bytes);
    let report = build_trust_report(bytes, &flags);

    assert_eq!(report.signature_count, 1);
    assert_eq!(report.signatures[0].signer_name.as_deref(), Some("Krishna Vaibhav"));
    assert_eq!(report.signatures[0].sub_filter.as_deref(), Some("adbe.pkcs7.detached"));
    assert!(report.signatures[0].doc_mdp);
  }

  #[test]
  fn trust_report_extracts_attachments_and_encryption() {
    let bytes = br#"%PDF-1.7
1 0 obj
<<
/Type /Filespec
/F (report.xlsx)
/UF <FEFF007200650070006F00720074002E0078006C00730078>
/Desc (Quarterly workbook)
/AFRelationship /Data
/EF << /F 7 0 R >>
>>
endobj
2 0 obj
<<
/Filter /Standard
/V 5
/R 6
/Length 256
/P -4
/StmF /StdCF
/StrF /StdCF
/EncryptMetadata false
/CF << /StdCF << /CFM /AESV3 >> >>
>>
endobj
/Encrypt 2 0 R
"#;

    let flags = classify_pdf(bytes);
    let report = build_trust_report(bytes, &flags);

    assert_eq!(report.attachment_count, 1);
    assert_eq!(report.attachments[0].file_name.as_deref(), Some("report.xlsx"));
    assert!(report.attachments[0].embedded);
    assert!(report.encryption.encrypted);
    assert_eq!(report.encryption.revision, Some(6));
    assert_eq!(
      report.encryption.algorithm.as_deref(),
      Some("AES-256 standard security")
    );
  }

  #[test]
  fn extract_integer_and_bool_values_work() {
    let dictionary = "<< /Length 256 /EncryptMetadata false >>";

    assert_eq!(extract_integer_value(dictionary, "/Length"), Some(256));
    assert_eq!(extract_bool_value(dictionary, "/EncryptMetadata"), Some(false));
  }

  #[test]
  fn infer_encryption_algorithm_prefers_aes256() {
    assert_eq!(
      infer_encryption_algorithm(Some("<< /CFM /AESV3 >>"), Some(6), Some(256), None, None).as_deref(),
      Some("AES-256 standard security")
    );
  }
}

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
  pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfTrustReport {
  pub signature_count: usize,
  pub signatures: Vec<PdfSignatureSummary>,
  pub recommendations: Vec<String>,
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
  let signatures = extract_signature_summaries(bytes);
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

  if flags.encrypted {
    recommendations.push(
      "This PDF is encrypted. Password-aware editing and validation paths may be required."
        .to_string(),
    );
  }

  if flags.has_attachments {
    recommendations.push(
      "This PDF contains embedded attachments. Inspect bundled files before sharing or archiving."
        .to_string(),
    );
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
    recommendations,
  }
}

fn extract_signature_summaries(bytes: &[u8]) -> Vec<PdfSignatureSummary> {
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

    signatures.push(parse_signature_summary(
      &dictionary_text,
      &context_text,
      bytes.len() as u64,
    ));
  }

  signatures
}

fn parse_signature_summary(
  dictionary_text: &str,
  context_text: &str,
  file_length: u64,
) -> PdfSignatureSummary {
  let byte_range = extract_byte_range(dictionary_text);
  let covers_whole_document = byte_range
    .as_ref()
    .map(|values| values.len() == 4 && values[0] == 0 && values[2].saturating_add(values[3]) == file_length)
    .unwrap_or(false);
  let sub_filter = extract_name_value(dictionary_text, "/SubFilter");
  let is_timestamp = dictionary_text.contains("/Type /DocTimeStamp")
    || sub_filter.as_deref() == Some("ETSI.RFC3161");
  let doc_mdp = dictionary_text.contains("/DocMDP") || dictionary_text.contains("/TransformMethod /DocMDP");

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

  PdfSignatureSummary {
    field_name: extract_literal_string_value(context_text, "/T"),
    signer_name: extract_literal_string_value(dictionary_text, "/Name")
      .or_else(|| extract_literal_string_value(context_text, "/TU")),
    reason: extract_literal_string_value(dictionary_text, "/Reason"),
    location: extract_literal_string_value(dictionary_text, "/Location"),
    contact_info: extract_literal_string_value(dictionary_text, "/ContactInfo"),
    modification_time: extract_literal_string_value(dictionary_text, "/M"),
    filter: extract_name_value(dictionary_text, "/Filter"),
    sub_filter,
    byte_range,
    covers_whole_document,
    is_timestamp,
    doc_mdp,
    notes,
  }
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

fn extract_literal_string_value(text: &str, key: &str) -> Option<String> {
  let tail = find_key_tail(text, key)?;
  let bytes = tail.as_bytes();
  if bytes.first().copied() != Some(b'(') {
    return None;
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
    build_trust_report, classify_pdf, decode_pdf_literal_string, extract_byte_range,
    extract_literal_string_value, extract_name_value, find_occurrences,
  };

  #[test]
  fn extracts_name_and_literal_values() {
    let dictionary = "<< /Type /Sig /T (Signature 1) /Filter /Adobe.PPKLite /Reason (Approved\\) copy) >>";

    assert_eq!(extract_name_value(dictionary, "/Filter").as_deref(), Some("Adobe.PPKLite"));
    assert_eq!(extract_literal_string_value(dictionary, "/T").as_deref(), Some("Signature 1"));
    assert_eq!(
      extract_literal_string_value(dictionary, "/Reason").as_deref(),
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
}

mod commands;
mod ocr;
mod pdf_inspect;
mod qpdf;
mod signature_validation;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      commands::load_pdf,
      commands::load_file_bytes,
      commands::inspect_pdf_bytes,
      commands::get_qpdf_status,
      commands::protect_pdf_bytes,
      commands::decrypt_pdf_bytes,
      commands::save_file_bytes,
      commands::extract_pdf_attachments,
      commands::get_ocr_status,
      commands::run_ocr_image,
      commands::run_ocr_pdf
    ]);

  #[cfg(debug_assertions)]
  let builder = builder.plugin(
    tauri_plugin_log::Builder::default()
      .level(log::LevelFilter::Info)
      .build(),
  );

  builder
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

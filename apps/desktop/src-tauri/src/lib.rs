mod commands;
mod ocr;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      commands::load_pdf,
      commands::inspect_pdf_bytes,
      commands::save_file_bytes,
      commands::get_ocr_status,
      commands::run_ocr_image
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

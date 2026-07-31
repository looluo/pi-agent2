use std::{fs, io::Write, path::Path};

fn main() {
    let runtime_zip = Path::new("resources/runtime-bundle.zip");
    if !runtime_zip.exists() {
        fs::create_dir_all("resources").expect("create resources directory");
        let mut file = fs::File::create(runtime_zip).expect("create placeholder runtime bundle");
        file.write_all(include_bytes!("resources-placeholder.zip")).expect("write placeholder runtime bundle");
    }
    tauri_build::build();
}

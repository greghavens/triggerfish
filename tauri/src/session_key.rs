/// Read the Tidepool session key from the Triggerfish data directory.
///
/// Returns the trimmed key string or an error if the file is missing or unreadable.
pub fn read_session_key() -> Result<String, String> {
    let base_dir = resolve_base_dir()?;
    let key_path = std::path::Path::new(&base_dir).join("tidepool-session-key");
    std::fs::read_to_string(&key_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Session key read failed: {key_path:?}: {e}"))
}

/// Resolve the Triggerfish base directory (`~/.triggerfish`).
fn resolve_base_dir() -> Result<String, String> {
    if let Ok(val) = std::env::var("TRIGGERFISH_DATA_DIR") {
        if !val.is_empty() {
            return Ok(val);
        }
    }
    if let Ok(val) = std::env::var("TRIGGERFISH_HOME") {
        return Ok(val);
    }
    dirs_or_home().map(|home| format!("{}/.triggerfish", home))
}

/// Get the user home directory.
fn dirs_or_home() -> Result<String, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Cannot determine home directory".to_string())
}

use std::{fs, path::Path};
use zed::settings::{CommandSettings, LspSettings};
use zed_extension_api::{self as zed, Result};

const ASSETS: &[(&str, &[u8])] = &[
    ("server.mjs", include_bytes!("../server/dist/server.mjs")),
    (
        "analysis-worker.mjs",
        include_bytes!("../server/dist/analysis-worker.mjs"),
    ),
    ("base.bend", include_bytes!("../server/vendor/base.bend")),
    (
        "THIRD_PARTY_LICENSES.txt",
        include_bytes!("../server/dist/THIRD_PARTY_LICENSES.txt"),
    ),
];

struct Bend2;

impl zed::Extension for Bend2 {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let settings = LspSettings::for_worktree("bend2", worktree)?;
        if let Some(path) = settings
            .binary
            .as_ref()
            .and_then(|binary| binary.path.as_ref())
        {
            // Only an explicit override selects an external server. In particular,
            // never discover the unrelated community bend2-lsp on PATH.
            let command = worktree.which(path).unwrap_or_else(|| path.clone());
            return Ok(configure_command(command, Vec::new(), settings.binary));
        }

        let node = zed::node_binary_path()?;
        let output = zed::process::Command::new(&node)
            .arg("--version")
            .output()
            .map_err(|error| {
                format!("Could not check Bend2's Node.js runtime at {node}: {error}")
            })?;
        if output.status != Some(0) {
            return Err(format!(
                "Could not check Bend2's Node.js runtime at {node}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        require_node_22(&String::from_utf8_lossy(&output.stdout))?;

        // Zed runs extensions in their writable work directory. Absolute paths
        // keep the server independent of the language server's working directory.
        let directory = std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(concat!("bend2-", env!("CARGO_PKG_VERSION")));
        materialize(&directory, ASSETS)?;
        Ok(configure_command(
            node,
            vec![
                directory.join("server.mjs").to_string_lossy().into_owned(),
                "--stdio".into(),
            ],
            settings.binary,
        ))
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(LspSettings::for_worktree("bend2", worktree)?.initialization_options)
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(LspSettings::for_worktree("bend2", worktree)?.settings)
    }
}

fn configure_command(
    command: String,
    default_args: Vec<String>,
    settings: Option<CommandSettings>,
) -> zed::Command {
    let mut result = zed::Command {
        command,
        args: default_args,
        env: Vec::new(),
    };
    if let Some(settings) = settings {
        if let Some(arguments) = settings.arguments {
            result.args = arguments;
        }
        result.env = settings.env.unwrap_or_default().into_iter().collect();
        result.env.sort();
    }
    result
}

fn require_node_22(version: &str) -> Result<()> {
    let version = version.trim();
    let major = version
        .strip_prefix('v')
        .unwrap_or(version)
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok());
    match major {
        Some(22..) => Ok(()),
        _ => Err(format!(
            "The bundled Bend2 language server requires Node.js 22 or newer; \
             Zed's Node.js runtime reported {version:?}. Configure Zed to use \
             Node.js 22+ or set lsp.bend2.binary.path to a custom language server."
        )),
    }
}

fn materialize(directory: &Path, assets: &[(&str, &[u8])]) -> Result<()> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;
    for (name, bytes) in assets {
        let path = directory.join(name);
        // Compare content, not just existence: dev rebuilds retain the version.
        match fs::read(&path) {
            Ok(existing) if existing == *bytes => continue,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not read {}: {error}", path.display())),
        }
        fs::write(&path, bytes)
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    }
    Ok(())
}

zed::register_extension!(Bend2);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_minimum_version() {
        for version in ["v22.0.0\n", "24.1.0", "v23.0.0"] {
            assert!(require_node_22(version).is_ok(), "{version}");
        }
        for version in ["v20.19.0", "v21.7.3", "", "not node"] {
            assert!(require_node_22(version)
                .unwrap_err()
                .contains("22 or newer"));
        }
    }

    #[test]
    fn command_defaults_and_explicit_overrides() {
        let command = configure_command(
            "/node".into(),
            vec!["/extension/server.mjs".into(), "--stdio".into()],
            None,
        );
        assert_eq!(command.command, "/node");
        assert_eq!(command.args, ["/extension/server.mjs", "--stdio"]);
        assert!(command.env.is_empty());

        let settings = CommandSettings {
            path: Some("custom-server".into()),
            arguments: Some(vec!["--custom".into()]),
            env: Some([("BEND_TEST".into(), "1".into())].into()),
        };
        let command = configure_command("/resolved/custom-server".into(), vec![], Some(settings));
        assert_eq!(command.command, "/resolved/custom-server");
        assert_eq!(command.args, ["--custom"]);
        assert_eq!(command.env, [("BEND_TEST".into(), "1".into())]);
    }

    #[test]
    fn materialization_refreshes_changed_assets_only() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
                "materialization-test-{}-{unique}",
                std::process::id()
            ));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(directory.clone());
        materialize(&directory, ASSETS).unwrap();
        for (name, bytes) in ASSETS {
            assert_eq!(fs::read(directory.join(name)).unwrap(), *bytes);
        }
        let path = directory.join("server.mjs");
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        materialize(&directory, ASSETS).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        fs::write(&path, b"stale dev build").unwrap();
        materialize(&directory, ASSETS).unwrap();
        assert_eq!(fs::read(path).unwrap(), ASSETS[0].1);
    }
}

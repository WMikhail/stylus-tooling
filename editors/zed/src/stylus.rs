use std::{env, fs};

use zed_extension_api::{self as zed, serde_json, settings::LspSettings, Result};

const PACKAGE_NAME: &str = "stylus-lsp";
const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");
const SERVER_PATH: &str = "node_modules/stylus-lsp/dist/server.js";

struct StylusExtension {
    did_find_server: bool,
}

impl StylusExtension {
    fn server_exists(&self) -> bool {
        fs::metadata(SERVER_PATH).is_ok_and(|metadata| metadata.is_file())
    }

    fn binary_override(
        &self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::Command>> {
        let Some(binary) = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.binary)
        else {
            return Ok(None);
        };
        let Some(path) = binary.path else {
            return Ok(None);
        };

        let arguments = binary
            .arguments
            .unwrap_or_else(|| vec!["--stdio".to_string()]);
        let env: Vec<(String, String)> = binary.env.unwrap_or_default().into_iter().collect();

        if path.ends_with(".js") || path.ends_with(".mjs") {
            let mut node_arguments = vec![path];
            node_arguments.extend(arguments);
            return Ok(Some(zed::Command {
                command: zed::node_binary_path()?,
                args: node_arguments,
                env,
            }));
        }

        Ok(Some(zed::Command {
            command: path,
            args: arguments,
            env,
        }))
    }

    fn server_script_path(&mut self, language_server_id: &zed::LanguageServerId) -> Result<String> {
        if self.did_find_server && self.server_exists() {
            return Ok(SERVER_PATH.to_string());
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;
        if !self.server_exists() || installed_version.as_deref() != Some(PACKAGE_VERSION) {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            zed::npm_install_package(PACKAGE_NAME, PACKAGE_VERSION).map_err(|error| {
                format!("failed to install {PACKAGE_NAME}@{PACKAGE_VERSION}: {error}")
            })?;
        }

        if !self.server_exists() {
            return Err(format!(
                "installed package '{PACKAGE_NAME}' did not contain '{SERVER_PATH}'"
            ));
        }
        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;
        if installed_version.as_deref() != Some(PACKAGE_VERSION) {
            return Err(format!(
                "installed {PACKAGE_NAME} version {}; expected {PACKAGE_VERSION}",
                installed_version.as_deref().unwrap_or("<missing>")
            ));
        }

        self.did_find_server = true;
        Ok(SERVER_PATH.to_string())
    }
}

impl zed::Extension for StylusExtension {
    fn new() -> Self {
        Self {
            did_find_server: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        if let Some(command) = self.binary_override(language_server_id, worktree)? {
            return Ok(command);
        }

        let server_path = self.server_script_path(language_server_id)?;
        let absolute_server_path = env::current_dir()
            .map_err(|error| format!("failed to determine extension work directory: {error}"))?
            .join(server_path)
            .to_string_lossy()
            .to_string();

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![absolute_server_path, "--stdio".to_string()],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree).ok();
        let options = settings
            .as_ref()
            .and_then(|settings| settings.initialization_options.clone())
            .or_else(|| settings.and_then(|settings| settings.settings))
            .unwrap_or_else(|| serde_json::json!({}));
        Ok(Some(options))
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.settings)
            .unwrap_or_else(|| serde_json::json!({}));
        Ok(Some(settings))
    }
}

zed::register_extension!(StylusExtension);

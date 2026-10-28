//! Crate-owned requests for the built-in Electron command table.
//!
//! Pass these types to [`crate::Electron::call`]. Applications can still implement
//! [`crate::RpcRequest`] for additional commands. Requests use the canonical wire
//! shapes; legacy parameter aliases remain a JavaScript compatibility detail.
//! `command.execute` / `command.cancel` belong to [`crate::Command`], not this module.
//!
//! Commands outside the transport's synchronous whitelist are deferred while a
//! native popup callback is blocked. Answer the popup before awaiting such calls.
//! Platform-specific operations retain the JavaScript runtime's support/errors.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::RpcRequest;

// Keep the method and response beside the request, without a second registry.
macro_rules! requests {
  ($($(#[$meta:meta])* $name:ident { $($(#[$field_meta:meta])* $field:ident: $ty:ty),* $(,)? }
    => $response:ty, $method:literal $(, deferred = $deferred:literal)? $(, timeout = $timeout:literal)?;)*) => {
    $(
      $(#[$meta])*
      #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
      #[serde(rename_all = "camelCase")]
      pub struct $name { $($(#[$field_meta])* pub $field: $ty),* }

      impl RpcRequest for $name {
        type Response = $response;
        const METHOD: &'static str = $method;
        $(fn deferred(&self) -> bool { $deferred })?
        $(fn timeout(&self) -> std::time::Duration { std::time::Duration::from_secs($timeout) })?
      }
    )*
    #[cfg(test)]
    pub(super) const METHODS: &[&str] = &[$(<$name as RpcRequest>::METHOD),*];
    #[cfg(test)]
    pub(super) const SCHEDULING: &[(&str, bool)] = &[$((<$name as RpcRequest>::METHOD, false $(|| $deferred)?)),*];
  };
}

/// A theme override. `System` follows the OS; both app and window accept it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
  Dark,
  Light,
  #[default]
  System,
}

/// An effective theme, which has already resolved the system preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorScheme {
  Dark,
  Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
  pub x: i32,
  pub y: i32,
}

/// A logical-pixel position; fractional coordinates are preserved until applied.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LogicalPosition {
  pub x: f64,
  pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Size {
  pub width: u32,
  pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rectangle {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
}

/// Physical screen coordinates, including the full rectangle in `position`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
  pub name: String,
  pub position: Rectangle,
  pub size: Size,
  pub work_area: WorkArea,
  pub scale_factor: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkArea {
  pub position: Rectangle,
  pub size: Size,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DisplayList {
  pub displays: Vec<Display>,
  pub primary: Display,
}

/// CSS color or three/four byte RGBA channels (alpha defaults to 255).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Color {
  Css(String),
  Rgb([u8; 3]),
  Rgba([u8; 4]),
}

/// Window commands and their configuration/snapshot types.
pub mod window {
  use super::*;

  #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub enum ConstraintAxis {
    MinWidth,
    MinHeight,
    MaxWidth,
    MaxHeight,
  }

  #[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
  #[serde(untagged)]
  pub enum SizeConstraint {
    /// Logical pixels.
    Logical(f64),
    Scaled {
      value: f64,
      physical: bool,
    },
  }

  /// Missing axes are unchanged; `None` explicitly clears an axis.
  pub type SizeConstraints = BTreeMap<ConstraintAxis, Option<SizeConstraint>>;

  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct WindowGeometry {
    pub scale_factor: f64,
    pub bounds: Rectangle,
    pub content_bounds: Rectangle,
    /// Logical-pixel limits; zero denotes an unconstrained axis.
    pub content_constraints: BTreeMap<ConstraintAxis, f64>,
    pub maximized: bool,
    pub minimized: bool,
    pub focused: bool,
    pub visible: bool,
    pub fullscreen: bool,
    pub resizable: bool,
    pub always_on_top: bool,
    pub decorated: bool,
    pub title: String,
    pub maximizable: bool,
    pub minimizable: bool,
    pub closable: bool,
  }

  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct Created {
    pub window_id: u32,
  }

  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct NativeWindowHandle {
    /// Electron sends a JavaScript Number; native pointer precision is limited by that representation.
    pub handle: u64,
    pub process_id: u32,
  }

  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  pub struct ThemeState {
    pub theme: ColorScheme,
  }

  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum BackgroundMaterial {
    None,
    Acrylic,
    Mica,
    Tabbed,
  }

  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum ProgressState {
    None,
    Normal,
    Paused,
    Error,
  }

  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum TitleBarStyle {
    Visible,
    Transparent,
    Overlay,
  }

  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  pub struct Icon {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
  }

  /// Creation uses base64-encoded BGRA, unlike the RGBA update commands.
  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  pub struct CreationIcon {
    pub width: u32,
    pub height: u32,
    pub bgra: String,
  }

  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum MenuItemType {
    Separator,
  }

  #[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct MenuItem {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<MenuItemType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accelerator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submenu: Option<Vec<MenuItem>>,
  }

  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  #[serde(untagged)]
  pub enum PreventOverflow {
    Enabled(bool),
    Margin {
      width: Option<f64>,
      height: Option<f64>,
    },
  }

  /// Common window settings are typed; additional settings remain extensible.
  #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct Config {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_width: Option<SizeConstraint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_height: Option<SizeConstraint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_width: Option<SizeConstraint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_height: Option<SizeConstraint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transparent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decorations: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focusable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub center: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximized: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fullscreen: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resizable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximizable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimizable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always_on_top: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_taskbar: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_color: Option<Color>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_bar_style: Option<TitleBarStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_bar_hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_title: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traffic_light_position: Option<LogicalPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible_on_all_workspaces: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_protected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prevent_overflow: Option<PreventOverflow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<Theme>,
    #[serde(flatten)]
    pub additional: BTreeMap<String, Value>,
  }

  requests! {
    Create {
      window_id: u32,
      #[serde(default)] window: Config,
      #[serde(skip_serializing_if = "Option::is_none")] webview: Option<super::webview::Config>,
      #[serde(skip_serializing_if = "Option::is_none")] size_constraints: Option<SizeConstraints>,
      #[serde(skip_serializing_if = "Option::is_none")] new_window_request: Option<u64>,
      #[serde(skip_serializing_if = "Option::is_none")] defer_show: Option<bool>,
      #[serde(skip_serializing_if = "Option::is_none")] window_icon: Option<CreationIcon>,
      #[serde(skip_serializing_if = "Option::is_none")] icon: Option<String>,
    } => Created, "window.create";
    Ready { window_id: u32 } => (), "window.ready", deferred = true;
    SetTitle { window_id: u32, title: String } => (), "window.setTitle";
    Geometry { window_id: u32 } => WindowGeometry, "window.geometry";
    SetSize { window_id: u32, width: f64, height: f64, physical: bool } => (), "window.size";
    SetPosition { window_id: u32, x: f64, y: f64, physical: bool } => (), "window.position";
    SetMinSize {
      window_id: u32,
      #[serde(skip_serializing_if = "Option::is_none")] width: Option<f64>,
      #[serde(skip_serializing_if = "Option::is_none")] height: Option<f64>,
      physical: bool,
    } => (), "window.minSize";
    SetMaxSize {
      window_id: u32,
      #[serde(skip_serializing_if = "Option::is_none")] width: Option<f64>,
      #[serde(skip_serializing_if = "Option::is_none")] height: Option<f64>,
      physical: bool,
    } => (), "window.maxSize";
    SetSizeConstraints { window_id: u32, constraints: SizeConstraints } => (), "window.sizeConstraints";
    SetResizable { window_id: u32, resizable: bool } => (), "window.resizable";
    SetMaximizable { window_id: u32, maximizable: bool } => (), "window.maximizable";
    SetMinimizable { window_id: u32, minimizable: bool } => (), "window.minimizable";
    SetClosable { window_id: u32, closable: bool } => (), "window.closable";
    Maximize { window_id: u32 } => (), "window.maximize";
    Unmaximize { window_id: u32 } => (), "window.unmaximize";
    Minimize { window_id: u32 } => (), "window.minimize";
    Unminimize { window_id: u32 } => (), "window.unminimize", deferred = true, timeout = 15;
    SetFullscreen {
      window_id: u32, fullscreen: bool,
      #[serde(skip_serializing_if = "Option::is_none")] x: Option<f64>,
      #[serde(skip_serializing_if = "Option::is_none")] y: Option<f64>,
    } => (), "window.fullscreen", deferred = true, timeout = 25;
    SetAlwaysOnTop { window_id: u32, always_on_top: bool } => (), "window.alwaysOnTop";
    SetCursor { window_id: u32, cursor: String } => (), "window.cursor", deferred = true;
    SetCursorIcon { window_id: u32, cursor: String } => (), "window.setCursorIcon", deferred = true;
    SetCursorVisible { window_id: u32, visible: bool } => (), "window.setCursorVisible", deferred = true;
    /// `None` detaches the parent (the wire parameter must be explicit null).
    SetParentWindow { window_id: u32, parent_id: Option<u32> } => (), "window.setParentWindow";
    /// `None` removes the menu; an empty list creates an empty menu.
    SetMenu { window_id: u32, menu: Option<Vec<MenuItem>> } => (), "window.setMenu";
    SetSkipTaskbar { window_id: u32, skip: bool } => (), "window.skipTaskbar";
    SetFocusable { window_id: u32, focusable: bool } => (), "window.focusable";
    SetContentProtected { window_id: u32, protected: bool } => (), "window.contentProtected";
    Center { window_id: u32 } => (), "window.center";
    RequestAttention { window_id: u32, flash: bool } => (), "window.requestAttention";
    Show { window_id: u32 } => (), "window.show";
    Hide { window_id: u32 } => (), "window.hide";
    Focus { window_id: u32 } => (), "window.focus";
    NativeHandle { window_id: u32 } => NativeWindowHandle, "window.nativeHandle";
    Close { window_id: u32 } => (), "window.close";
    Destroy { window_id: u32 } => (), "window.destroy";
    SetVisibleOnAllWorkspaces { window_id: u32, value: bool } => (), "window.visibleOnAllWorkspaces";
    SetIcon { window_id: u32, icon: Icon } => (), "window.icon";
    SetEnabled { window_id: u32, enabled: bool } => (), "window.enabled";
    IsEnabled { window_id: u32 } => bool, "window.enabledQuery";
    SetSimpleFullscreen { window_id: u32, fullscreen: bool } => (), "window.simpleFullscreen";
    SetProgressBar { window_id: u32, state: ProgressState, progress: f64 } => (), "window.progressBar";
    SetShadow { window_id: u32, value: bool } => (), "window.shadow";
    SetDecorations { window_id: u32, value: bool } => (), "window.decorations";
    /// This updates the application badge, despite the legacy window namespace.
    SetBadgeCount { count: u32 } => (), "window.badgeCount";
    SetOverlayIcon { window_id: u32, icon: Option<Icon>, description: String } => (), "window.overlayIcon";
    SetBackgroundColor { window_id: u32, color: Option<Color> } => (), "window.backgroundColor";
    SetBackgroundMaterial { window_id: u32, material: BackgroundMaterial } => (), "window.backgroundMaterial";
    SetTheme { window_id: u32, theme: Theme } => (), "window.theme", deferred = true;
    IgnoreCursorEvents { window_id: u32, ignore: bool } => (), "window.ignoreCursorEvents";
    QueryTheme { window_id: u32 } => ThemeState, "window.themeQuery", deferred = true;
    Displays {} => DisplayList, "window.displays";
    CursorPosition {} => Point, "window.cursorPosition";
    CurrentDisplay { window_id: u32 } => Display, "window.currentDisplay";
    DisplayForPoint { x: f64, y: f64 } => Option<Display>, "window.displayForPoint";
    SetTitleBarStyle { window_id: u32, style: TitleBarStyle } => (), "window.titleBarStyle", deferred = true;
    SetTrafficLight { window_id: u32, x: f64, y: f64, physical: bool } => (), "window.trafficLight";
  }
}

/// Webview commands, policy answers, cookies and creation settings.
pub mod webview {
  use super::*;

  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct Created {
    pub webview_id: u32,
  }

  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct Snapshot {
    pub scale_factor: f64,
    pub bounds: Rectangle,
    pub content_bounds: Rectangle,
    pub visible: bool,
  }

  #[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
  pub struct Position {
    pub x: f64,
    pub y: f64,
    /// Omit to inherit `BoundsInput::physical`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physical: Option<bool>,
  }

  #[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
  pub struct Extent {
    pub width: f64,
    pub height: f64,
    /// Omit to inherit `BoundsInput::physical`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physical: Option<bool>,
  }

  #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
  pub struct BoundsInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<Extent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physical: Option<bool>,
  }

  #[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
  pub struct Policy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub navigation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<bool>,
  }

  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(untagged)]
  pub enum InitScript {
    Source(String),
    Detailed {
      script: String,
      #[serde(rename = "mainFrameOnly")]
      main_frame_only: bool,
    },
  }

  /// Shared by `webview.create` and the main webview in `window.create`.
  #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct Config {
    pub webview_id: u32,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_resize: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<BoundsInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<Policy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incognito: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_scripts: Option<Vec<InitScript>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_color: Option<Color>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transparent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accept_first_mouse: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub javascript_disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub devtools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_throttling: Option<String>,
    #[serde(flatten)]
    pub additional: BTreeMap<String, Value>,
  }

  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum NewWindowAction {
    Allow,
    Deny,
  }

  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct NewWindowDecision {
    pub action: NewWindowAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<u32>,
  }

  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum PermissionDecision {
    Allow,
    Deny,
    Default,
  }

  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "snake_case")]
  pub enum SameSite {
    Unspecified,
    NoRestriction,
    Lax,
    Strict,
  }

  /// Electron's cookie snapshot. Session cookies may omit `expirationDate`.
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct Cookie {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    pub session: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<f64>,
    pub same_site: SameSite,
  }

  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct CookieInit {
    pub url: String,
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_site: Option<SameSite>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<f64>,
  }

  requests! {
    Create { window_id: u32, #[serde(flatten)] config: Config } => Created, "webview.create", deferred = true;
    Url { webview_id: u32 } => String, "webview.url";
    Eval { webview_id: u32, script: String } => Value, "webview.eval", deferred = true;
    NewWindowResponse { id: u64, response: NewWindowDecision } => (), "webview.newWindowResponse";
    NavigationResponse { id: u64, allow: bool } => (), "webview.navigationResponse";
    DownloadResponse {
      id: u64, allow: bool,
      #[serde(skip_serializing_if = "Option::is_none")] destination: Option<String>,
    } => (), "webview.downloadResponse";
    PermissionResponse { id: u64, response: PermissionDecision } => (), "webview.permissionResponse";
    Navigate { webview_id: u32, url: String } => (), "webview.navigate", deferred = true;
    Reload { webview_id: u32 } => (), "webview.reload", deferred = true;
    SetAutoResize { webview_id: u32, auto_resize: bool } => (), "webview.setAutoResize", deferred = true;
    GoBack { webview_id: u32 } => (), "webview.goBack", deferred = true;
    CanGoBack { webview_id: u32 } => bool, "webview.canGoBack", deferred = true;
    GoForward { webview_id: u32 } => (), "webview.goForward", deferred = true;
    CanGoForward { webview_id: u32 } => bool, "webview.canGoForward", deferred = true;
    OpenDevtools { webview_id: u32 } => (), "webview.openDevtools", deferred = true, timeout = 15;
    CloseDevtools { webview_id: u32 } => (), "webview.closeDevtools", deferred = true;
    IsDevtoolsOpen { webview_id: u32 } => bool, "webview.isDevtoolsOpen", deferred = true;
    SetZoom { webview_id: u32, scale_factor: f64 } => (), "webview.setZoom", deferred = true;
    Reparent { webview_id: u32, window_id: u32 } => (), "webview.reparent", deferred = true;
    Bounds { webview_id: u32 } => Snapshot, "webview.bounds", deferred = true;
    SetBounds { webview_id: u32, #[serde(flatten)] bounds: BoundsInput } => (), "webview.setBounds", deferred = true;
    SetVisibility { webview_id: u32, visible: bool } => (), "webview.visibility", deferred = true;
    SetBackgroundColor { webview_id: u32, color: Option<String> } => (), "webview.backgroundColor", deferred = true;
    Focus { webview_id: u32 } => (), "webview.focus", deferred = true;
    Print { webview_id: u32 } => (), "webview.print", deferred = true;
    Close { webview_id: u32 } => (), "webview.close", deferred = true;
    Cookies {
      webview_id: u32,
      #[serde(skip_serializing_if = "Option::is_none")] url: Option<String>,
    } => Vec<Cookie>, "webview.cookies", deferred = true;
    SetCookie { webview_id: u32, #[serde(flatten)] cookie: CookieInit } => (), "webview.setCookie", deferred = true;
    DeleteCookie { webview_id: u32, url: String, name: String } => (), "webview.deleteCookie", deferred = true;
    ClearBrowsingData { webview_id: u32 } => (), "webview.clearBrowsingData", deferred = true;
  }
}

/// Custom protocol registration and replies to `protocol.request` events.
pub mod protocol {
  use super::*;

  requests! {
    Register { scheme: String } => (), "protocol.register";
    Respond {
      id: u64,
      #[serde(skip_serializing_if = "Option::is_none")] status: Option<u16>,
      #[serde(skip_serializing_if = "Option::is_none")] headers: Option<BTreeMap<String, String>>,
      /// Base64 bytes. Ignored for HEAD and statuses 204, 205 and 304.
      #[serde(skip_serializing_if = "Option::is_none")] body: Option<String>,
    } => (), "protocol.respond";
  }
}

/// Application-wide commands, including the root-re-exportable `SetTheme`.
pub mod app {
  use super::*;

  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum ActivationPolicy {
    Regular,
    Accessory,
    Prohibited,
  }

  requests! {
    SetBadgeLabel { label: String } => (), "app.badgeLabel", deferred = true;
    Focus { steal: bool } => (), "app.focus", deferred = true;
    Show {} => (), "app.show", deferred = true;
    Hide {} => (), "app.hide", deferred = true;
    SetActivationPolicy { policy: ActivationPolicy } => (), "app.activationPolicy", deferred = true;
    SetDockVisibility { visible: bool } => (), "app.dockVisibility", deferred = true;
    SetTheme { theme: Theme } => (), "app.theme", deferred = true;
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde::de::DeserializeOwned;
  use serde_json::json;
  use std::collections::BTreeSet;

  fn round_trip<R: RpcRequest + DeserializeOwned + PartialEq + std::fmt::Debug>(
    request: R,
    method: &str,
    params: Value,
  ) {
    assert_eq!(request.method(), method);
    assert_eq!(serde_json::to_value(&request).unwrap(), params);
    assert_eq!(serde_json::from_value::<R>(params).unwrap(), request);
  }

  #[test]
  fn request_names_cover_the_typescript_command_table() {
    // The command entries are quoted object keys. Include every namespace so
    // adding even a new domain requires an explicit decision in the Rust API.
    let source = include_str!("../src-ts/runtime/commands.ts");
    let commands: BTreeSet<_> = source
      .lines()
      .filter_map(|line| {
        let line = line.trim_start().strip_prefix('\'')?;
        let (method, rest) = line.split_once('\'')?;
        rest.starts_with(':').then_some(method)
      })
      .collect();
    let methods: Vec<_> = window::METHODS
      .iter()
      .chain(webview::METHODS)
      .chain(protocol::METHODS)
      .chain(app::METHODS)
      .copied()
      .collect();
    let registered: BTreeSet<_> = methods.iter().copied().collect();
    assert_eq!(registered.len(), methods.len(), "duplicate built-in method");
    let internal = BTreeSet::from(["command.execute", "command.cancel"]);
    assert!(internal.is_subset(&commands));
    assert!(
      registered.is_disjoint(&internal),
      "Command service requests must stay internal"
    );
    assert_eq!(
      registered,
      commands.difference(&internal).copied().collect()
    );
  }

  #[test]
  fn no_parameter_requests_are_objects() {
    round_trip(window::Displays {}, "window.displays", json!({}));
    round_trip(
      window::CursorPosition {},
      "window.cursorPosition",
      json!({}),
    );
    round_trip(app::Show {}, "app.show", json!({}));
    round_trip(app::Hide {}, "app.hide", json!({}));
  }

  #[test]
  fn camel_case_params_and_decisions_match_the_wire() {
    round_trip(
      app::SetTheme { theme: Theme::Dark },
      "app.theme",
      json!({"theme": "dark"}),
    );
    round_trip(
      window::SetTheme {
        window_id: 2,
        theme: Theme::System,
      },
      "window.theme",
      json!({"windowId": 2, "theme": "system"}),
    );
    // null would count as a supplied display coordinate in window.fullscreen.
    round_trip(
      window::SetFullscreen {
        window_id: 2,
        fullscreen: true,
        x: None,
        y: None,
      },
      "window.fullscreen",
      json!({"windowId": 2, "fullscreen": true}),
    );
    round_trip(
      window::SetParentWindow {
        window_id: 2,
        parent_id: None,
      },
      "window.setParentWindow",
      json!({"windowId": 2, "parentId": null}),
    );
    round_trip(
      window::SetSizeConstraints {
        window_id: 2,
        constraints: BTreeMap::from([
          (
            window::ConstraintAxis::MinWidth,
            Some(window::SizeConstraint::Scaled {
              value: 640.0,
              physical: true,
            }),
          ),
          (window::ConstraintAxis::MaxHeight, None),
        ]),
      },
      "window.sizeConstraints",
      json!({"windowId": 2, "constraints": {"minWidth": {"value": 640.0, "physical": true}, "maxHeight": null}}),
    );
    round_trip(
      webview::SetBounds {
        webview_id: 3,
        bounds: webview::BoundsInput {
          position: Some(webview::Position {
            x: 1.0,
            y: 2.0,
            physical: Some(true),
          }),
          size: None,
          physical: None,
        },
      },
      "webview.setBounds",
      json!({"webviewId": 3, "position": {"x": 1.0, "y": 2.0, "physical": true}}),
    );
    round_trip(
      webview::SetBounds {
        webview_id: 3,
        bounds: webview::BoundsInput {
          position: Some(webview::Position {
            x: 1.0,
            y: 2.0,
            physical: None,
          }),
          size: None,
          physical: Some(true),
        },
      },
      "webview.setBounds",
      json!({"webviewId": 3, "position": {"x": 1.0, "y": 2.0}, "physical": true}),
    );
    round_trip(
      webview::NewWindowResponse {
        id: 8,
        response: webview::NewWindowDecision {
          action: webview::NewWindowAction::Allow,
          window_id: Some(2),
        },
      },
      "webview.newWindowResponse",
      json!({"id": 8, "response": {"action": "allow", "windowId": 2}}),
    );
    round_trip(
      webview::PermissionResponse {
        id: 9,
        response: webview::PermissionDecision::Deny,
      },
      "webview.permissionResponse",
      json!({"id": 9, "response": "deny"}),
    );
    round_trip(
      protocol::Respond {
        id: 10,
        status: Some(200),
        headers: Some(BTreeMap::from([(
          "content-type".into(),
          "text/plain".into(),
        )])),
        body: Some("aGk=".into()),
      },
      "protocol.respond",
      json!({"id": 10, "status": 200, "headers": {"content-type": "text/plain"}, "body": "aGk="}),
    );
  }

  #[test]
  fn creation_configs_preserve_real_nesting_and_extensions() {
    let params = json!({
      "windowId": 2, "window": {"title": "Example", "width": 800.0, "titleBarStyle": "overlay", "theme": "system", "tabbingIdentifier": "documents", "trafficLightPosition": {"x": 12.5, "y": 8.25}},
      "webview": {"webviewId": 3, "url": "about:blank", "initScripts": [{"script": "void 0", "mainFrameOnly": true}]},
      "deferShow": true, "windowIcon": {"width": 1, "height": 1, "bgra": "AAAAAA=="},
    });
    let request: window::Create = serde_json::from_value(params.clone()).unwrap();
    assert_eq!(request.window.additional["tabbingIdentifier"], "documents");
    round_trip(request, "window.create", params);
    let params = json!({"windowId": 2, "webviewId": 4, "url": "about:blank", "autoResize": true, "incognito": true, "policy": {"navigation": true}, "customSetting": 123});
    let request: webview::Create = serde_json::from_value(params.clone()).unwrap();
    assert_eq!(request.config.additional["customSetting"], 123);
    round_trip(request, "webview.create", params);
  }

  fn response<R: RpcRequest>(value: Value) -> R::Response {
    serde_json::from_value(value).unwrap()
  }

  #[test]
  fn concrete_responses_deserialize_without_placeholder_shapes() {
    assert_eq!(
      response::<window::Create>(json!({"windowId": 2})).window_id,
      2
    );
    assert_eq!(
      response::<webview::Create>(json!({"webviewId": 3})).webview_id,
      3
    );
    let rect = json!({"x": -10, "y": 20, "width": 800, "height": 600});
    let geometry = response::<window::Geometry>(json!({
      "scaleFactor": 2.0, "bounds": rect, "contentBounds": rect,
      "contentConstraints": {"minWidth": 100, "minHeight": 0, "maxWidth": 0, "maxHeight": 0},
      "maximized": false, "minimized": false, "focused": true, "visible": true, "fullscreen": false,
      "resizable": true, "alwaysOnTop": false, "decorated": true, "title": "Example",
      "maximizable": true, "minimizable": true, "closable": true,
    }));
    assert_eq!(geometry.bounds.x, -10);
    assert_eq!(
      geometry.content_constraints[&window::ConstraintAxis::MinWidth],
      100.0
    );
    let display = json!({"name": "Primary", "position": rect, "size": {"width": 800, "height": 600}, "workArea": {"position": rect, "size": {"width": 800, "height": 600}}, "scaleFactor": 2.0});
    assert_eq!(
      response::<window::Displays>(
        json!({"displays": [display.clone()], "primary": display.clone()})
      )
      .primary
      .name,
      "Primary"
    );
    assert!(response::<window::DisplayForPoint>(Value::Null).is_none());
    assert_eq!(response::<window::CurrentDisplay>(display).position.x, -10);
    assert_eq!(
      response::<window::NativeHandle>(json!({"handle": 123, "processId": 456})).process_id,
      456
    );
    assert_eq!(
      response::<window::CursorPosition>(json!({"x": -1, "y": 2})).x,
      -1
    );
    assert_eq!(
      response::<window::QueryTheme>(json!({"theme": "light"})).theme,
      ColorScheme::Light
    );
    assert!(
      serde_json::from_value::<<window::QueryTheme as RpcRequest>::Response>(
        json!({"theme": "system"})
      )
      .is_err()
    );
    assert!(response::<window::IsEnabled>(json!(true)));
    assert_eq!(
      response::<webview::Url>(json!("about:blank")),
      "about:blank"
    );
    assert!(response::<webview::CanGoBack>(json!(true)));
    assert!(!response::<webview::CanGoForward>(json!(false)));
    assert!(response::<webview::IsDevtoolsOpen>(json!(true)));
    assert!(
      response::<webview::Bounds>(
        json!({"scaleFactor": 2.0, "bounds": rect, "contentBounds": rect, "visible": true})
      )
      .visible
    );
    assert_eq!(
      response::<webview::Eval>(json!({"arbitrary": [1, true]}))["arbitrary"][0],
      1
    );
    response::<webview::Print>(Value::Null);
    response::<webview::OpenDevtools>(Value::Null);
    response::<app::SetTheme>(Value::Null);
  }

  #[test]
  fn cookies_keep_typed_session_and_persistent_fields() {
    let cookies = response::<webview::Cookies>(json!([
      {"name": "session", "value": "a", "domain": "example.test", "hostOnly": true, "path": "/", "secure": true, "httpOnly": true, "session": true, "sameSite": "lax"},
      {"name": "persistent", "value": "b", "session": false, "expirationDate": 1800000000.5, "sameSite": "no_restriction"},
    ]));
    assert_eq!(cookies[0].expiration_date, None);
    assert_eq!(cookies[1].same_site, webview::SameSite::NoRestriction);
    let params = json!({"webviewId": 3, "url": "https://example.test/", "name": "key", "value": "value", "httpOnly": true, "sameSite": "strict", "expirationDate": 1800000000.5});
    let request: webview::SetCookie = serde_json::from_value(params.clone()).unwrap();
    round_trip(request, "webview.setCookie", params);
  }

  #[test]
  fn scheduling_matches_the_transports_synchronous_whitelist() {
    let source = include_str!("../src-ts/socket/transport.ts");
    let whitelist = source
      .split_once("const synchronousMethods = new Set([")
      .unwrap()
      .1
      .split_once("])")
      .unwrap()
      .0;
    let synchronous: BTreeSet<_> = whitelist
      .split('\'')
      .enumerate()
      .filter_map(|(index, part)| (index % 2 == 1).then_some(part))
      .collect();
    for &(method, deferred) in window::SCHEDULING
      .iter()
      .chain(webview::SCHEDULING)
      .chain(protocol::SCHEDULING)
      .chain(app::SCHEDULING)
    {
      assert_eq!(deferred, !synchronous.contains(method), "{method}");
    }
  }

  #[test]
  fn asynchronous_work_is_deferred_but_native_popup_answers_are_not() {
    assert!(window::SetFullscreen {
      window_id: 1,
      fullscreen: true,
      x: None,
      y: None
    }
    .deferred());
    assert!(window::QueryTheme { window_id: 1 }.deferred());
    assert!(webview::Eval {
      webview_id: 1,
      script: String::new()
    }
    .deferred());
    assert!(webview::OpenDevtools { webview_id: 1 }.timeout().as_secs() > 10);
    assert!(window::Unminimize { window_id: 1 }.timeout().as_secs() > 10);
    assert!(!protocol::Register {
      scheme: "example".into()
    }
    .deferred());
    assert!(!webview::NewWindowResponse {
      id: 1,
      response: webview::NewWindowDecision {
        action: webview::NewWindowAction::Deny,
        window_id: None
      }
    }
    .deferred());
    assert!(!window::Geometry { window_id: 1 }.notification());
  }
}

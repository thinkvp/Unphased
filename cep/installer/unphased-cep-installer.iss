; Unphased CEP installer (Windows).
;
; Replaces the manual install — clone the repo, run install-panel.ps1 with
; ExecutionPolicy Bypass, keep the clone around forever because the panel is
; junctioned into it — with an ordinary double-click installer. No admin rights
; needed: everything it touches lives under the current user's profile.
;
; Build with: iscc unphased-cep-installer.iss /DMyAppVersion=1.0.0
; (MyAppVersion falls back to "0.0.0-dev" for local test builds if omitted.)
;
; Expects the runtime files to already be staged at ..\dist\staging\ — run
; `node ..\scripts\stage.js` first. That staging step is what puts engine/
; INSIDE the extension folder; see scripts/stage.js for why it cannot be a
; sibling here the way it is in the repo.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif

#define MyAppName "Unphased"
#define MyAppPublisher "thinkvp"
#define MyAppURL "https://github.com/thinkvp/Unphased"
#define StagingDir "..\dist\staging"

[Setup]
AppId={{4C1F2A67-9D3B-4E85-A0C4-2F7B8E5D1A93}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={userappdata}\Adobe\CEP\extensions\com.unphased.panel
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Unphased-CEP-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
LicenseFile={#StagingDir}\LICENSE
UninstallDisplayIcon={app}\index.html
ArchitecturesInstallIn64BitMode=x64compatible

[Registry]
; Premiere only loads unsigned CEP extensions when the matching CSXS-version
; debug flag is set. Cover the whole range seen in the wild (Premiere ~2019
; through 2026) rather than trying to detect the installed version.
;
; Deliberately NOT using `uninsdeletevalue`: PlayerDebugMode is a shared,
; systemwide CEP developer flag, not something this installer owns. Deleting it
; on uninstall would silently break any other unsigned CEP extension the user
; has installed.
Root: HKCU; Subkey: "Software\Adobe\CSXS.9";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.14"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"

[Files]
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Code]
// scripts\install-panel.ps1 junctions cep/ into this exact path. If someone who
// installed that way runs this installer, Inno's file copy would follow the
// junction and write THROUGH it into their git clone — overwriting a working
// tree is a genuinely nasty surprise. Detect the reparse point and remove the
// link first. RemoveDir on a junction deletes the link, never the target.
const
  FILE_ATTRIBUTE_REPARSE_POINT = $400;
  INVALID_FILE_ATTRIBUTES      = $FFFFFFFF;

function GetFileAttributesW(lpFileName: string): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function DirIsJunction(const Path: string): Boolean;
var
  Attr: Cardinal;
begin
  Result := False;
  if not DirExists(Path) then
    Exit;
  Attr := GetFileAttributesW(Path);
  Result := (Attr <> INVALID_FILE_ATTRIBUTES) and
            ((Attr and FILE_ATTRIBUTE_REPARSE_POINT) <> 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Target: string;
begin
  Result := '';
  Target := ExpandConstant('{app}');
  if DirIsJunction(Target) then
  begin
    if not RemoveDir(Target) then
      Result := 'Unphased is currently installed as a junction to a source checkout, ' +
                'and Setup could not remove it. Close Premiere Pro, delete this folder ' +
                'by hand, then run Setup again:' + #13#10#13#10 + Target;
  end;
end;

[Messages]
FinishedLabel=Setup has installed Unphased.%n%nRestart Premiere Pro if it's running, then find the panel under Window %26 Extensions %26 Unphased.%n%nUnphased's CEP version also needs Node.js 18 or newer and ffmpeg on this machine — the panel's footer shows what it found, and Settings lets you point at them. On Premiere 26 or newer, prefer the UXP version instead: it needs neither.

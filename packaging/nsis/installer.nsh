!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "${PROJECT_DIR}\..\..\packaging\nsis\uninstaller.nsh"

!ifndef BUILD_UNINSTALLER
  !ifndef WHITELILY_COMPONENT_DATA_ROOT
    !define WHITELILY_COMPONENT_DATA_ROOT "$LOCALAPPDATA\WhiteLily"
  !endif

  Var WhiteLilyComponentsDialog
  Var WhiteLilyBridgeCheckbox
  Var WhiteLilyAvatarCheckbox
  Var WhiteLilyBridgeEnabled
  Var WhiteLilyAvatarEnabled
  Var WhiteLilyComponentConfigRoot
  Var WhiteLilyComponentPreferencesPath

  !ifndef WHITELILY_COMPONENT_VALIDATOR_SOURCE
    !define WHITELILY_COMPONENT_VALIDATOR_SOURCE "${PROJECT_DIR}\..\..\packaging\nsis\validate-minecraft-component-preferences.ps1"
  !endif

  !macro WhiteLilySetFixedInstallDirectory
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\WhiteLily"
  !macroend

  ; initMultiUser has already processed the registry and /D= when customInit
  ; runs. Silent installs therefore end initialization on the fixed path.
  !macro customInit
    !insertmacro WhiteLilySetFixedInstallDirectory
    StrCpy $WhiteLilyBridgeEnabled "true"
    StrCpy $WhiteLilyAvatarEnabled "true"
  !macroend

  Function WhiteLilyMinecraftComponentsPageCreate
    !insertmacro WhiteLilySetFixedInstallDirectory
    nsDialogs::Create 1018
    Pop $WhiteLilyComponentsDialog
    ${If} $WhiteLilyComponentsDialog == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 28u "为当前用户准备 WhiteLily 的 Minecraft 组件偏好。安装器不会查找或修改任何启动器、游戏实例或世界。$\r$\nChoose component preferences for this Windows user; no launcher, game instance, or world is searched or modified."
    Pop $0
    ${NSD_CreateCheckbox} 0 38u 100% 12u "WhiteLily Bridge（官方认证局域网连接，必需） / official-auth LAN bridge (required)"
    Pop $WhiteLilyBridgeCheckbox
    ${NSD_Check} $WhiteLilyBridgeCheckbox
    ${NSD_CreateCheckbox} 0 56u 100% 12u "WhiteLily Avatar（可选外观，包含 Fabric API 与 GeckoLib） / optional avatar with Fabric API and GeckoLib"
    Pop $WhiteLilyAvatarCheckbox
    ${NSD_Check} $WhiteLilyAvatarCheckbox
    nsDialogs::Show
  FunctionEnd

  Function WhiteLilyMinecraftComponentsPageLeave
    ${NSD_GetState} $WhiteLilyBridgeCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $WhiteLilyBridgeEnabled "true"
    ${Else}
      StrCpy $WhiteLilyBridgeEnabled "false"
    ${EndIf}
    ${NSD_GetState} $WhiteLilyAvatarCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $WhiteLilyAvatarEnabled "true"
    ${Else}
      StrCpy $WhiteLilyAvatarEnabled "false"
    ${EndIf}
    ${If} $WhiteLilyAvatarEnabled == "true"
      StrCpy $WhiteLilyBridgeEnabled "true"
    ${EndIf}
  FunctionEnd

  Function WhiteLilyRejectReparseDirectory
    System::Call 'kernel32::GetFileAttributesW(w r0) i .r1'
    ${If} $1 != -1
      IntOp $2 $1 & 0x400
      ${If} $2 != 0
        Abort
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function WhiteLilyRequireOrdinaryComponentDirectory
    System::Call 'kernel32::GetFileAttributesW(w r0) i .r1'
    ${If} $1 == -1
      Goto invalid_component_directory
    ${EndIf}
    IntOp $2 $1 & 0x410
    ${If} $2 != 16
      Goto invalid_component_directory
    ${EndIf}
    Return

  invalid_component_directory:
    SetErrors
    SetErrorLevel 1
    Abort
  FunctionEnd

  Function WhiteLilyClearMinecraftComponentPreferenceEnvironment
    System::Call 'kernel32::SetEnvironmentVariableW(w "WHITELILY_COMPONENT_PREFERENCES_PATH", p 0) i .r4'
    ${If} $4 == 0
      Goto environment_cleanup_failed
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariableW(w "WHITELILY_COMPONENT_PREFERENCES_OPERATION", p 0) i .r4'
    ${If} $4 == 0
      Goto environment_cleanup_failed
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariableW(w "WHITELILY_COMPONENT_BRIDGE_ENABLED", p 0) i .r4'
    ${If} $4 == 0
      Goto environment_cleanup_failed
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariableW(w "WHITELILY_COMPONENT_AVATAR_ENABLED", p 0) i .r4'
    ${If} $4 == 0
      Goto environment_cleanup_failed
    ${EndIf}
    Return

  environment_cleanup_failed:
    SetErrors
    SetErrorLevel 1
    Abort
  FunctionEnd

  Function WhiteLilyRunMinecraftComponentPreferenceAuthority
    SetOutPath "$PLUGINSDIR"
    File "/oname=validate-minecraft-component-preferences.ps1" "${WHITELILY_COMPONENT_VALIDATOR_SOURCE}"
    nsExec::ExecToStack /TIMEOUT=5000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\validate-minecraft-component-preferences.ps1"'
    Pop $3
    Pop $2
    Call WhiteLilyClearMinecraftComponentPreferenceEnvironment
    ${If} $3 != 0
      Goto invalid_preference_authority
    ${EndIf}
    ${If} $2 != ""
      Goto invalid_preference_authority
    ${EndIf}
    Return

  invalid_preference_authority:
    SetErrors
    SetErrorLevel 1
    Abort
  FunctionEnd

  Function WhiteLilyRequireValidMinecraftComponentPreferences
    Call WhiteLilyClearMinecraftComponentPreferenceEnvironment
    System::Call 'kernel32::SetEnvironmentVariableW(w "WHITELILY_COMPONENT_PREFERENCES_PATH", w r0) i .r3'
    ${If} $3 == 0
      Goto invalid_existing_preferences
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariableW(w "WHITELILY_COMPONENT_PREFERENCES_OPERATION", w "validate") i .r3'
    ${If} $3 == 0
      Goto invalid_existing_preferences
    ${EndIf}
    Call WhiteLilyRunMinecraftComponentPreferenceAuthority
    Return

  invalid_existing_preferences:
    Call WhiteLilyClearMinecraftComponentPreferenceEnvironment
    SetErrors
    SetErrorLevel 1
    Abort
  FunctionEnd

  Function WhiteLilyWriteMinecraftComponentPreferences
    StrCpy $0 "${WHITELILY_COMPONENT_DATA_ROOT}"
    Call WhiteLilyRejectReparseDirectory
    StrCpy $0 "$WhiteLilyComponentConfigRoot"
    Call WhiteLilyRejectReparseDirectory
    IfFileExists "$WhiteLilyComponentPreferencesPath" validate_existing

    ClearErrors
    CreateDirectory "${WHITELILY_COMPONENT_DATA_ROOT}"
    IfErrors publish_failed
    StrCpy $0 "$WhiteLilyComponentConfigRoot"
    Call WhiteLilyRejectReparseDirectory
    ClearErrors
    CreateDirectory "$WhiteLilyComponentConfigRoot"
    IfErrors publish_failed
    StrCpy $0 "${WHITELILY_COMPONENT_DATA_ROOT}"
    Call WhiteLilyRequireOrdinaryComponentDirectory
    StrCpy $0 "$WhiteLilyComponentConfigRoot"
    Call WhiteLilyRequireOrdinaryComponentDirectory

    Call WhiteLilyClearMinecraftComponentPreferenceEnvironment
    System::Call 'kernel32::SetEnvironmentVariableW(w "WHITELILY_COMPONENT_PREFERENCES_PATH", w "$WhiteLilyComponentPreferencesPath") i .r3'
    ${If} $3 == 0
      Goto publish_failed
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariableW(w "WHITELILY_COMPONENT_PREFERENCES_OPERATION", w "publish") i .r3'
    ${If} $3 == 0
      Goto publish_failed
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariableW(w "WHITELILY_COMPONENT_BRIDGE_ENABLED", w "$WhiteLilyBridgeEnabled") i .r3'
    ${If} $3 == 0
      Goto publish_failed
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariableW(w "WHITELILY_COMPONENT_AVATAR_ENABLED", w "$WhiteLilyAvatarEnabled") i .r3'
    ${If} $3 == 0
      Goto publish_failed
    ${EndIf}
    Call WhiteLilyRunMinecraftComponentPreferenceAuthority
    StrCpy $0 "${WHITELILY_COMPONENT_DATA_ROOT}"
    Call WhiteLilyRequireOrdinaryComponentDirectory
    StrCpy $0 "$WhiteLilyComponentConfigRoot"
    Call WhiteLilyRequireOrdinaryComponentDirectory
    StrCpy $0 "$WhiteLilyComponentPreferencesPath"
    Call WhiteLilyRequireValidMinecraftComponentPreferences
    Goto done

  publish_failed:
    Call WhiteLilyClearMinecraftComponentPreferenceEnvironment
    SetErrors
    SetErrorLevel 1
    Abort
  validate_existing:
    StrCpy $0 "${WHITELILY_COMPONENT_DATA_ROOT}"
    Call WhiteLilyRequireOrdinaryComponentDirectory
    StrCpy $0 "$WhiteLilyComponentConfigRoot"
    Call WhiteLilyRequireOrdinaryComponentDirectory
    StrCpy $0 "$WhiteLilyComponentPreferencesPath"
    Call WhiteLilyRequireValidMinecraftComponentPreferences
  done:
  FunctionEnd

  ; Assisted mode processes its forced-current-user page after customInit,
  ; including /D= again. This hidden page runs after that mode page and is the
  ; final callback before MUI_PAGE_INSTFILES.
  Function WhiteLilyEnforceInstallDirectory
    !insertmacro WhiteLilySetFixedInstallDirectory
    Abort
  FunctionEnd

  !macro customPageAfterChangeDir
    Page custom WhiteLilyMinecraftComponentsPageCreate WhiteLilyMinecraftComponentsPageLeave
    Page custom WhiteLilyEnforceInstallDirectory
  !macroend

  !macro customInstall
    StrCpy $WhiteLilyComponentConfigRoot "${WHITELILY_COMPONENT_DATA_ROOT}\config"
    StrCpy $WhiteLilyComponentPreferencesPath "${WHITELILY_COMPONENT_DATA_ROOT}\config\minecraft-components.json"
    Call WhiteLilyWriteMinecraftComponentPreferences
  !macroend
!endif

; WhiteLily is intentionally per-user. This skips electron-builder's
; install-mode page and prevents an administrator/elevation path.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

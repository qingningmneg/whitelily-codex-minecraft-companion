!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "${PROJECT_DIR}\..\..\packaging\nsis\uninstaller.nsh"

!ifndef BUILD_UNINSTALLER
  !macro WhiteLilySetFixedInstallDirectory
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\WhiteLily"
  !macroend

  ; initMultiUser has already processed the registry and /D= when customInit
  ; runs. Silent installs therefore end initialization on the fixed path.
  !macro customInit
    !insertmacro WhiteLilySetFixedInstallDirectory
  !macroend

  ; Assisted mode processes its forced-current-user page after customInit,
  ; including /D= again. This hidden page runs after that mode page and is the
  ; final callback before MUI_PAGE_INSTFILES.
  Function WhiteLilyEnforceInstallDirectory
    !insertmacro WhiteLilySetFixedInstallDirectory
    Abort
  FunctionEnd

  !macro customPageAfterChangeDir
    Page custom WhiteLilyEnforceInstallDirectory
  !macroend
!endif

; WhiteLily is intentionally per-user. This skips electron-builder's
; install-mode page and prevents an administrator/elevation path.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifdef BUILD_UNINSTALLER
  Var WhiteLilyUnStrHaystack
  Var WhiteLilyUnStrNeedle
  Var WhiteLilyUnStrIndex
  Var WhiteLilyUnStrNeedleLength
  Var WhiteLilyUnStrSlice
  Var WhiteLilyUnStrHaystackLength
  Var WhiteLilyUnStrReturn

  ; Keep StrContains' stack contract in an uninstall-namespaced implementation
  ; so path literals are passed once and no unused installer function is emitted.
  Function un.StrContains
    Exch $WhiteLilyUnStrNeedle
    Exch 1
    Exch $WhiteLilyUnStrHaystack
    StrCpy $WhiteLilyUnStrReturn ""
    StrCpy $WhiteLilyUnStrIndex -1
    StrLen $WhiteLilyUnStrNeedleLength $WhiteLilyUnStrNeedle
    StrLen $WhiteLilyUnStrHaystackLength $WhiteLilyUnStrHaystack

    whitelily_un_str_contains_loop:
      IntOp $WhiteLilyUnStrIndex $WhiteLilyUnStrIndex + 1
      StrCpy $WhiteLilyUnStrSlice $WhiteLilyUnStrHaystack $WhiteLilyUnStrNeedleLength $WhiteLilyUnStrIndex
      StrCmp $WhiteLilyUnStrSlice $WhiteLilyUnStrNeedle whitelily_un_str_contains_found
      StrCmp $WhiteLilyUnStrIndex $WhiteLilyUnStrHaystackLength whitelily_un_str_contains_done
      Goto whitelily_un_str_contains_loop

    whitelily_un_str_contains_found:
      StrCpy $WhiteLilyUnStrReturn $WhiteLilyUnStrNeedle

    whitelily_un_str_contains_done:
      Pop $WhiteLilyUnStrNeedle
      Exch $WhiteLilyUnStrReturn
  FunctionEnd

  ; Preserve StrContains' OUT/NEEDLE/HAYSTACK call order.
  !macro _UnStrContainsConstructor OUT NEEDLE HAYSTACK
    Push `${HAYSTACK}`
    Push `${NEEDLE}`
    Call un.StrContains
    Pop `${OUT}`
  !macroend
  !define UnStrContains '!insertmacro "_UnStrContainsConstructor"'

  !define WHITE_LILY_FILE_ATTRIBUTE_DIRECTORY 0x10
  !define WHITE_LILY_FILE_ATTRIBUTE_REPARSE_POINT 0x400
  !define WHITE_LILY_INVALID_FILE_ATTRIBUTES -1
  !define WHITE_LILY_INVALID_HANDLE_VALUE -1
  !define WHITE_LILY_FILE_SHARE_ALL 7
  !define WHITE_LILY_OPEN_EXISTING 3
  !define WHITE_LILY_FILE_FLAG_BACKUP_SEMANTICS 0x02000000

  Var WhiteLilyDataChoice
  Var WhiteLilyDataPage
  Var WhiteLilyKeepDataRadio
  Var WhiteLilyDeleteDataRadio
  Var WhiteLilyDeleteTarget
  Var WhiteLilyExpectedDataRoot
  Var WhiteLilyCanonicalDeleteTarget
  Var WhiteLilyCanonicalExpectedRoot
  Var WhiteLilyResolvedDeleteTarget
  Var WhiteLilyResolvedLocalAppData
  Var WhiteLilyResolvedExpectedRoot
  Var WhiteLilyDirectoryHandle

  ; Silent uninstall and upgrade start and remain on the safe keep-data choice.
  !macro customUnInit
    StrCpy $WhiteLilyDataChoice "keep_data"
  !macroend

  !macro customUnWelcomePage
    !insertmacro MUI_UNPAGE_WELCOME
    UninstPage custom un.WhiteLilyDataChoicePageCreate un.WhiteLilyDataChoicePageLeave
  !macroend

  Function un.WhiteLilyDataChoicePageCreate
    nsDialogs::Create 1018
    Pop $WhiteLilyDataPage
    ${If} $WhiteLilyDataPage == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0u 0u 300u 24u \
      "卸载程序文件后，如何处理 WhiteLily 数据？ / After removing the program, what should happen to WhiteLily data?"
    Pop $R0

    ${NSD_CreateRadioButton} 10u 38u 280u 24u \
      "保留 WhiteLily 数据（推荐） / Keep WhiteLily data (recommended)"
    Pop $WhiteLilyKeepDataRadio
    ${NSD_Check} $WhiteLilyKeepDataRadio

    ${NSD_CreateRadioButton} 10u 70u 280u 24u \
      "删除 WhiteLily 数据 / Delete WhiteLily data"
    Pop $WhiteLilyDeleteDataRadio

    nsDialogs::Show
  FunctionEnd

  Function un.WhiteLilyDataChoicePageLeave
    StrCpy $WhiteLilyDataChoice "keep_data"
    SendMessage $WhiteLilyDeleteDataRadio ${BM_GETCHECK} 0 0 $R0
    ${If} $R0 == ${BST_CHECKED}
      StrCpy $WhiteLilyDataChoice "delete_data"
    ${EndIf}
  FunctionEnd

  Function un.WhiteLilyDeleteExactDataRoot
    ; Refuse empty, wildcard, unresolved-environment, and UNC/device paths.
    ${If} "$WhiteLilyDeleteTarget" == ""
      Return
    ${EndIf}
    ${UnStrContains} $R0 "*" "$WhiteLilyDeleteTarget"
    ${If} "$R0" != ""
      Return
    ${EndIf}
    ${UnStrContains} $R0 "?" "$WhiteLilyDeleteTarget"
    ${If} "$R0" != ""
      Return
    ${EndIf}
    ${UnStrContains} $R0 "%" "$WhiteLilyDeleteTarget"
    ${If} "$R0" != ""
      Return
    ${EndIf}
    ${UnStrContains} $R0 "\..\" "$WhiteLilyDeleteTarget"
    ${If} "$R0" != ""
      Return
    ${EndIf}
    ${UnStrContains} $R0 "/../" "$WhiteLilyDeleteTarget"
    ${If} "$R0" != ""
      Return
    ${EndIf}
    ${UnStrContains} $R0 "\../" "$WhiteLilyDeleteTarget"
    ${If} "$R0" != ""
      Return
    ${EndIf}
    ${UnStrContains} $R0 "/..\" "$WhiteLilyDeleteTarget"
    ${If} "$R0" != ""
      Return
    ${EndIf}
    StrCpy $R0 "$WhiteLilyDeleteTarget" 3 -3
    ${If} "$R0" == "\.."
      Return
    ${EndIf}
    ${If} "$R0" == "/.."
      Return
    ${EndIf}
    StrCpy $R0 "$WhiteLilyDeleteTarget" 2
    ${If} "$R0" == "\\"
      Return
    ${EndIf}

    StrCpy $WhiteLilyExpectedDataRoot "$LOCALAPPDATA\WhiteLily"
    ${If} "$WhiteLilyExpectedDataRoot" == ""
      Return
    ${EndIf}
    StrCpy $R0 "$WhiteLilyExpectedDataRoot" 2
    ${If} "$R0" == "\\"
      Return
    ${EndIf}

    ; GetFullPathName resolves dot segments before the exact path comparison.
    GetFullPathName $WhiteLilyCanonicalDeleteTarget "$WhiteLilyDeleteTarget"
    GetFullPathName $WhiteLilyCanonicalExpectedRoot "$WhiteLilyExpectedDataRoot"
    ${If} "$WhiteLilyCanonicalDeleteTarget" == ""
      Return
    ${EndIf}
    ${If} "$WhiteLilyCanonicalExpectedRoot" == ""
      Return
    ${EndIf}

    StrCmp $WhiteLilyCanonicalDeleteTarget $WhiteLilyCanonicalExpectedRoot whitelily_delete_exact_root whitelily_reject_delete_target

    whitelily_delete_exact_root:
      ; GetFullPathName is lexical. Refuse real reparse points and then compare
      ; paths resolved from Windows directory handles before recursive deletion.
      System::Call 'kernel32::GetFileAttributesW(w "$WhiteLilyCanonicalDeleteTarget") i.r0'
      ${If} $R0 == ${WHITE_LILY_INVALID_FILE_ATTRIBUTES}
        Return
      ${EndIf}
      IntOp $R1 $R0 & ${WHITE_LILY_FILE_ATTRIBUTE_DIRECTORY}
      ${If} $R1 == 0
        Return
      ${EndIf}
      IntOp $R1 $R0 & ${WHITE_LILY_FILE_ATTRIBUTE_REPARSE_POINT}
      ${If} $R1 != 0
        Return
      ${EndIf}

      System::Call 'kernel32::GetFileAttributesW(w "$LOCALAPPDATA") i.r0'
      ${If} $R0 == ${WHITE_LILY_INVALID_FILE_ATTRIBUTES}
        Return
      ${EndIf}
      IntOp $R1 $R0 & ${WHITE_LILY_FILE_ATTRIBUTE_DIRECTORY}
      ${If} $R1 == 0
        Return
      ${EndIf}
      IntOp $R1 $R0 & ${WHITE_LILY_FILE_ATTRIBUTE_REPARSE_POINT}
      ${If} $R1 != 0
        Return
      ${EndIf}

      System::Call 'kernel32::CreateFileW(w "$WhiteLilyCanonicalDeleteTarget", i 0, i ${WHITE_LILY_FILE_SHARE_ALL}, p 0, i ${WHITE_LILY_OPEN_EXISTING}, i ${WHITE_LILY_FILE_FLAG_BACKUP_SEMANTICS}, p 0) p.r0'
      StrCpy $WhiteLilyDirectoryHandle $R0
      ${If} $WhiteLilyDirectoryHandle == ${WHITE_LILY_INVALID_HANDLE_VALUE}
        Return
      ${EndIf}
      System::Call 'kernel32::GetFinalPathNameByHandleW(p r0, w .r1, i ${NSIS_MAX_STRLEN}, i 0) i.r2'
      System::Call 'kernel32::CloseHandle(p r0) i.r3'
      ${If} $R2 == 0
        Return
      ${EndIf}
      ${If} $R2 >= ${NSIS_MAX_STRLEN}
        Return
      ${EndIf}
      StrCpy $WhiteLilyResolvedDeleteTarget "$R1"

      System::Call 'kernel32::CreateFileW(w "$LOCALAPPDATA", i 0, i ${WHITE_LILY_FILE_SHARE_ALL}, p 0, i ${WHITE_LILY_OPEN_EXISTING}, i ${WHITE_LILY_FILE_FLAG_BACKUP_SEMANTICS}, p 0) p.r0'
      StrCpy $WhiteLilyDirectoryHandle $R0
      ${If} $WhiteLilyDirectoryHandle == ${WHITE_LILY_INVALID_HANDLE_VALUE}
        Return
      ${EndIf}
      System::Call 'kernel32::GetFinalPathNameByHandleW(p r0, w .r1, i ${NSIS_MAX_STRLEN}, i 0) i.r2'
      System::Call 'kernel32::CloseHandle(p r0) i.r3'
      ${If} $R2 == 0
        Return
      ${EndIf}
      ${If} $R2 >= ${NSIS_MAX_STRLEN}
        Return
      ${EndIf}
      StrCpy $WhiteLilyResolvedLocalAppData "$R1"
      StrCpy $WhiteLilyResolvedExpectedRoot "$WhiteLilyResolvedLocalAppData\WhiteLily"
      StrCmp $WhiteLilyResolvedDeleteTarget $WhiteLilyResolvedExpectedRoot whitelily_delete_resolved_exact_root whitelily_reject_delete_target

    whitelily_delete_resolved_exact_root:
      RMDir /r "$WhiteLilyCanonicalDeleteTarget"
      Return

    whitelily_reject_delete_target:
      Return
  FunctionEnd

  !macro customUnInstall
    ${If} $WhiteLilyDataChoice == "delete_data"
      ${IfNot} ${Silent}
        StrCpy $WhiteLilyDeleteTarget "$LOCALAPPDATA\WhiteLily"
        Call un.WhiteLilyDeleteExactDataRoot
      ${EndIf}
    ${EndIf}
  !macroend
!endif

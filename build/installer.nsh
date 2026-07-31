; The normal electron-builder installer and uninstaller remain intact. These
; optional hooks only publish factual milestones to Anodex's branded shell.

!ifndef BUILD_UNINSTALLER
  ; customHeader is expanded at top level after electron-builder has established
  ; RequestExecutionLevel, which is the safe place for helper declarations.
  !macro customHeader
    Var /GLOBAL anodexStatusFile
    Var /GLOBAL anodexStatusToken

    ; The shell passes a 32-character lowercase hexadecimal token, never an
    ; arbitrary path. This function accepts only that exact form, then derives
    ; the harmless telemetry location under the current user's temp directory.
    Function AnodexResolveStatusFile
      Exch $R0
      Push $R1
      Push $R2
      Push $R3

      StrCpy $anodexStatusFile ""
      StrLen $R1 $R0
      StrCmp $R1 32 0 anodexStatusTokenDone
      StrCpy $R2 0

    anodexStatusTokenLoop:
      IntCmp $R2 32 anodexStatusTokenCharacter anodexStatusTokenValid anodexStatusTokenValid

    anodexStatusTokenCharacter:
      StrCpy $R3 $R0 1 $R2
      StrCmp $R3 "0" anodexStatusTokenNext
      StrCmp $R3 "1" anodexStatusTokenNext
      StrCmp $R3 "2" anodexStatusTokenNext
      StrCmp $R3 "3" anodexStatusTokenNext
      StrCmp $R3 "4" anodexStatusTokenNext
      StrCmp $R3 "5" anodexStatusTokenNext
      StrCmp $R3 "6" anodexStatusTokenNext
      StrCmp $R3 "7" anodexStatusTokenNext
      StrCmp $R3 "8" anodexStatusTokenNext
      StrCmp $R3 "9" anodexStatusTokenNext
      StrCmp $R3 "a" anodexStatusTokenNext
      StrCmp $R3 "b" anodexStatusTokenNext
      StrCmp $R3 "c" anodexStatusTokenNext
      StrCmp $R3 "d" anodexStatusTokenNext
      StrCmp $R3 "e" anodexStatusTokenNext
      StrCmp $R3 "f" anodexStatusTokenNext
      Goto anodexStatusTokenDone

    anodexStatusTokenNext:
      IntOp $R2 $R2 + 1
      Goto anodexStatusTokenLoop

    anodexStatusTokenValid:
      StrCpy $anodexStatusFile "$TEMP\anodex-installer-stage-$R0.txt"

    anodexStatusTokenDone:
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
    FunctionEnd

    ; Caller: Push "stage" / Call AnodexWriteInstallerStage
    ; The status file is optional: errors are cleared so telemetry can never
    ; change the stock install, update, or uninstall behavior.
    Function AnodexWriteInstallerStage
      Exch $R0
      Push $R1

      StrCmp $anodexStatusFile "" anodexWriteInstallerStageDone
      ClearErrors
      FileOpen $R1 "$anodexStatusFile" w
      IfErrors anodexWriteInstallerStageDone
      FileWrite $R1 "$R0$\r$\n"
      FileClose $R1

    anodexWriteInstallerStageDone:
      ClearErrors
      Pop $R1
      Pop $R0
    FunctionEnd

    ; This is only a payload-success signal. The branded shell waits for the
    ; actual process exit and validates Anodex.exe before showing Ready.
    Function .onInstSuccess
      Push "payload-complete"
      Call AnodexWriteInstallerStage
    FunctionEnd

    Function .onInstFailed
      Push "failed"
      Call AnodexWriteInstallerStage
    FunctionEnd
  !macroend

  ; StdUtils is supplied by electron-builder before this include. It parses the
  ; wrapper's opaque token while electron-builder retains `/D=...` ownership.
  !macro preInit
    ${StdUtils.GetParameter} $anodexStatusToken "anodex-status-token" ""
    Push $anodexStatusToken
    Call AnodexResolveStatusFile
    Push "preparing"
    Call AnodexWriteInstallerStage
  !macroend

  ; Runs after electron-builder has selected its install mode.
  !macro customInit
    Push "installing"
    Call AnodexWriteInstallerStage
  !macroend

  ; These run immediately after electron-builder has decompressed the embedded
  ; app package into the selected directory. Registry, shortcuts, and the
  ; normal uninstaller are still completed afterward.
  !macro customFiles_x64
    Push "finishing"
    Call AnodexWriteInstallerStage
  !macroend

  !macro customFiles_ia32
    Push "finishing"
    Call AnodexWriteInstallerStage
  !macroend

  !macro customFiles_arm64
    Push "finishing"
    Call AnodexWriteInstallerStage
  !macroend
!endif

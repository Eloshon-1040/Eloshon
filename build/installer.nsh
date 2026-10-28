; Eloshon Scraper — NSIS additions (electron-builder `nsis.include`).
;
; The browser extension talks to the app through a small relay that Chrome / Edge start
; themselves: `Eloshon Scraper.exe ...\native-host\host.mjs`. It has the app's name, so the
; installer took it for the app still running and could not replace the files. Before
; installing (and uninstalling), stop ONLY these relays — matched by their command line;
; the browser starts a fresh one when the extension needs the app again.

!macro eloshonStopHostRelays
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='Eloshon Scraper.exe'\" | Where-Object { $$_.CommandLine -like '*native-host*host.mjs*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

!macro customInit
  !insertmacro eloshonStopHostRelays
!macroend

!macro customUnInit
  !insertmacro eloshonStopHostRelays
!macroend

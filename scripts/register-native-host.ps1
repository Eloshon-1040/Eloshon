# Registers the Eloshon Scraper native messaging host for Chrome, Edge and Brave
# under HKEY_CURRENT_USER (per-user; no admin, does not touch HKLM). Review before
# running. Undo with scripts/unregister-native-host.ps1.
$ErrorActionPreference = 'Stop'
$name = 'com.eloshon.scraper.host'
$manifest = Join-Path $PSScriptRoot '..\native-host\com.eloshon.scraper.host.json'
if (-not (Test-Path $manifest)) {
  Write-Error "Manifeste introuvable : $manifest. Lancez d'abord : npm run host:gen"
  exit 1
}
$manifest = (Resolve-Path $manifest).Path

$bases = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
)
foreach ($base in $bases) {
  $key = Join-Path $base $name
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifest
  Write-Host "OK  $key"
}
Write-Host ""
Write-Host "Hôte enregistre -> $manifest"
